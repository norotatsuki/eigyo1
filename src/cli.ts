#!/usr/bin/env node
/**
 * 営業リスト基盤の操作口。
 *
 *   ingest  … 国税庁の全件データを取り込む
 *   stats   … 取り込んだ内容の内訳を見る
 *   search  … 条件で絞り込んで画面に出す
 *   export  … 条件で絞り込んで CSV に書き出す
 */
import { parseArgs } from 'node:util';
import { createWriteStream } from 'node:fs';
import { openDb, defaultDbPath, type Db } from './db/index.ts';
import { loadZenken } from './ingest/nta/load.ts';
import { PREFECTURES, type Region } from './ingest/nta/catalog.ts';
import { COMPANY_KINDS, CORP_KIND_LABEL } from './ingest/nta/record.ts';
import { classifyAll } from './enrich/industry/classify.ts';
import { divisionName, majorDivisionOf } from './enrich/industry/classification.ts';
import { serve } from './web/server.ts';
import {
  countCompanies,
  searchCompanies,
  streamCompanies,
  toCsvLines,
  type SearchFilter,
  type SearchOptions,
} from './search/query.ts';

const USAGE = `
使い方: npm run cli -- <コマンド> [オプション]

  ingest   国税庁 法人番号公表サイト の全件データを取り込む
    --region <地域>    全国 (既定) / 都道府県名 / 国外
    --db <パス>        データベースの位置 (既定: data/eigyo.db)

  classify 商号と法人格から業種を推定して付加情報に書き込む
    --min-confidence <値>  この確信度未満は保存しない (既定 0.5)

  serve    画面を出す (127.0.0.1 のみ。社外からは届かない)
    --port <番号>          待受ポート (既定 5173)

  stats    取り込み内容の内訳を表示する

  search   条件で絞り込んで表示する
  export   条件で絞り込んで CSV に書き出す (--out が必須)

    共通の絞り込み:
    --keyword <語>         商号の部分一致
    --pref <コード,…>      都道府県コード (13 = 東京都)
    --kind <番号,…>        法人種別 101 国の機関 / 201 地方公共団体 /
                           301 株式会社 / 302 有限会社 / 303 合名会社 /
                           304 合資会社 / 305 合同会社 /
                           399 その他の設立登記法人 / 401 外国会社等 / 499 その他
    --companies            会社だけに絞る (301,302,303,304,305 と同じ)
    --form <法人格,…>      株式会社 など
    --industry <コード,…>  日本標準産業分類 (前方一致)
    --industry-confidence <値>
                           業種の確信度の下限。営業に使うなら 0.7 を薦める
    --capital-min <円>     資本金の下限
    --employees-min <人>   従業員数の下限
    --assigned-from <日付> 法人番号指定年月日の下限 (YYYY-MM-DD)
    --has-website          サイトが判明している先だけ
    --has-form             問い合わせフォームが判明している先だけ
    --include-inactive     閉鎖・除外された法人も含める
    --include-refused      営業お断りの先も含める
    --limit <件数>         表示件数 (search のみ、既定 20)
    --order <並び>         name / assigned_desc / capital_desc / employees_desc
    --out <パス>           書き出し先 (export のみ)
`.trim();

const options = {
  region: { type: 'string' },
  db: { type: 'string' },
  'min-confidence': { type: 'string' },
  port: { type: 'string' },
  keyword: { type: 'string' },
  pref: { type: 'string' },
  kind: { type: 'string' },
  companies: { type: 'boolean' },
  form: { type: 'string' },
  industry: { type: 'string' },
  'industry-confidence': { type: 'string' },
  'capital-min': { type: 'string' },
  'employees-min': { type: 'string' },
  'assigned-from': { type: 'string' },
  'has-website': { type: 'boolean' },
  'has-form': { type: 'boolean' },
  'include-inactive': { type: 'boolean' },
  'include-refused': { type: 'boolean' },
  limit: { type: 'string' },
  order: { type: 'string' },
  out: { type: 'string' },
} as const;

type Values = Partial<Record<keyof typeof options, string | boolean>>;

const asString = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;
const list = (v: string | boolean | undefined): string[] | undefined => {
  const s = asString(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
};
const num = (v: string | boolean | undefined): number | undefined => {
  const s = asString(v);
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

function toFilter(v: Values): SearchFilter {
  const filter: SearchFilter = {
    activeOnly: v['include-inactive'] !== true,
    excludeRefused: v['include-refused'] !== true,
  };
  const keyword = asString(v.keyword);
  if (keyword) filter.keyword = keyword;
  const prefCodes = list(v.pref);
  if (prefCodes) filter.prefCodes = prefCodes;
  const kinds = list(v.kind)?.map(Number).filter(Number.isFinite);
  if (kinds?.length) filter.kinds = kinds;
  else if (v.companies === true) filter.kinds = [...COMPANY_KINDS];
  const forms = list(v.form);
  if (forms) filter.corpForms = forms;
  const industry = list(v.industry);
  if (industry) filter.industryCodes = industry;
  const industryConfidence = num(v['industry-confidence']);
  if (industryConfidence !== undefined) filter.industryMinConfidence = industryConfidence;
  const capitalMin = num(v['capital-min']);
  if (capitalMin !== undefined) filter.capitalMin = capitalMin;
  const employeesMin = num(v['employees-min']);
  if (employeesMin !== undefined) filter.employeesMin = employeesMin;
  const assignedFrom = asString(v['assigned-from']);
  if (assignedFrom) filter.assignedFrom = assignedFrom;
  if (v['has-website'] === true) filter.hasWebsite = true;
  if (v['has-form'] === true) filter.hasContactForm = true;
  return filter;
}

function toSearchOptions(v: Values): SearchOptions {
  const opts: SearchOptions = {};
  const limit = num(v.limit);
  if (limit !== undefined) opts.limit = limit;
  const order = asString(v.order);
  if (order === 'name' || order === 'assigned_desc' || order === 'capital_desc' || order === 'employees_desc') {
    opts.orderBy = order;
  }
  return opts;
}

const fmt = (n: number): string => n.toLocaleString('ja-JP');

async function cmdIngest(db: Db, v: Values): Promise<void> {
  const regionArg = asString(v.region) ?? '全国';
  const valid: readonly string[] = ['全国', '国外', ...PREFECTURES];
  if (!valid.includes(regionArg)) {
    throw new Error(`地域の指定が不正です: ${regionArg}`);
  }
  const region = regionArg as Region;

  console.error(`[取込] 対象=${region}`);
  console.error('[取込] 国税庁の画面から目録を取得します…');
  const started = Date.now();

  const result = await loadZenken(db, {
    region,
    onProgress: (read, upserted) => {
      const sec = ((Date.now() - started) / 1000).toFixed(0);
      console.error(`[取込] 読取 ${fmt(read)} 件 / 投入 ${fmt(upserted)} 件 (${sec} 秒)`);
    },
  });

  const sec = ((Date.now() - started) / 1000).toFixed(1);
  console.error(
    `[取込] 完了 ${result.fileName} (基準日 ${result.sourceDate}) ` +
      `読取 ${fmt(result.rowsRead)} / 投入 ${fmt(result.rowsUpserted)} / ` +
      `除外 ${fmt(result.rowsSkipped)} — ${sec} 秒`,
  );
}

/** 画面を出して待ち続ける。Ctrl-C まで戻らない。 */
function cmdServe(db: Db, v: Values): Promise<void> {
  const port = num(v.port) ?? 5173;
  return new Promise<void>((resolve) => {
    const server = serve(db, {
      port,
      onListen: (url) => {
        console.error(`[画面] ${url} を開いてください (127.0.0.1 のみ待受)`);
        console.error('[画面] 止めるときは Ctrl-C');
      },
    });
    const stop = () => {
      console.error('\n[画面] 停止します');
      server.close(() => resolve());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

function cmdClassify(db: Db, v: Values): void {
  const minConfidence = num(v['min-confidence']) ?? 0.5;
  const started = Date.now();
  console.error(`[推定] 商号と法人格から業種を推定します (確信度 ${minConfidence} 以上を保存)`);

  const r = classifyAll(db, {
    minConfidence,
    onProgress: (scanned, inferred) => {
      const sec = ((Date.now() - started) / 1000).toFixed(0);
      console.error(`[推定] 走査 ${fmt(scanned)} 件 / 推定 ${fmt(inferred)} 件 (${sec} 秒)`);
    },
  });

  const rate = r.scanned > 0 ? ((r.inferred / r.scanned) * 100).toFixed(1) : '0.0';
  console.error(
    `[推定] 完了 走査 ${fmt(r.scanned)} / 推定 ${fmt(r.inferred)} 件 (${rate}%) — ` +
      `${((Date.now() - started) / 1000).toFixed(1)} 秒`,
  );
  if (r.skippedAuthoritative > 0) {
    console.error(`[推定] 権威ある出典が入っていた ${fmt(r.skippedAuthoritative)} 件は変更していません`);
  }

  console.log('');
  console.log('確信度の分布 — 実際の営業に使うなら 0.7 以上を薦める');
  const bands = [...r.byConfidence.entries()].sort((a, b) => b[0] - a[0]);
  const reliable = bands.filter(([c]) => c >= 0.7).reduce((s, [, n]) => s + n, 0);
  for (const [band, n] of bands) {
    const note = band >= 0.7 ? '確か' : '手がかり程度 (「工業」「商事」など幅の広い語)';
    console.log(`  ${band.toFixed(1)}  ${fmt(n).padStart(10)}  ${note}`);
  }
  console.log(`  → 0.7 以上は ${fmt(reliable)} 件`);

  console.log('');
  console.log('業種の内訳 (上位 20)');
  const sorted = [...r.byCode.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [code, n] of sorted) {
    const major = majorDivisionOf(code);
    const label = `${code} ${divisionName(code)}`;
    console.log(`  ${major ?? '-'}  ${label.padEnd(34, '　')} ${fmt(n).padStart(10)}`);
  }
}

function cmdStats(db: Db): void {
  const total = db.prepare('SELECT COUNT(*) AS n FROM corporations').get() as { n: number };
  if (total.n === 0) {
    console.log('まだ何も取り込まれていません。先に ingest を実行してください。');
    return;
  }
  const active = db.prepare('SELECT COUNT(*) AS n FROM corporations WHERE is_active = 1').get() as { n: number };
  const basis = db.prepare('SELECT MAX(source_date) AS d FROM corporations').get() as { d: string };

  console.log(`データ基準日: ${basis.d}`);
  console.log(`総件数:       ${fmt(total.n)}`);
  console.log(`営業対象:     ${fmt(active.n)}  (閉鎖・除外・過去履歴を落とした数)`);
  console.log('');

  console.log('法人種別の内訳 (営業対象のみ)');
  const byKind = db.prepare(
    'SELECT kind, COUNT(*) AS n FROM corporations WHERE is_active = 1 GROUP BY kind ORDER BY n DESC',
  ).all() as Array<{ kind: number | null; n: number }>;
  for (const r of byKind) {
    const label = r.kind === null ? '(不明)' : (CORP_KIND_LABEL[r.kind] ?? `不明(${r.kind})`);
    console.log(`  ${label.padEnd(20, '　')} ${fmt(r.n).padStart(12)}`);
  }
  console.log('');

  console.log('法人格の内訳 (上位 10)');
  const byForm = db.prepare(
    `SELECT COALESCE(corp_form, '(なし)') AS f, COUNT(*) AS n
       FROM corporations WHERE is_active = 1 GROUP BY f ORDER BY n DESC LIMIT 10`,
  ).all() as Array<{ f: string; n: number }>;
  for (const r of byForm) {
    console.log(`  ${r.f.padEnd(20, '　')} ${fmt(r.n).padStart(12)}`);
  }
  console.log('');

  const profiles = db.prepare('SELECT COUNT(*) AS n FROM company_profiles').get() as { n: number };
  console.log(`付加情報 (業種・規模・窓口) が入っている先: ${fmt(profiles.n)}`);
  if (profiles.n === 0) {
    console.log('  → 業種での絞り込みには gBizINFO の取込が必要です (docs/concept 参照)');
  }
}

function cmdSearch(db: Db, v: Values): void {
  const filter = toFilter(v);
  const opts = toSearchOptions(v);
  if (opts.limit === undefined) opts.limit = 20;

  const total = countCompanies(db, filter);
  const rows = searchCompanies(db, filter, opts);

  console.log(`該当 ${fmt(total)} 件 (先頭 ${rows.length} 件を表示)`);
  console.log('');
  for (const r of rows) {
    const industry = r.industry_name ? ` [${r.industry_name}]` : '';
    console.log(`${r.corporate_number}  ${r.name}${industry}`);
    console.log(`    ${r.post_code ? `〒${r.post_code} ` : ''}${r.address_full}`);
    if (r.website_url) console.log(`    ${r.website_url}`);
  }
}

function cmdExport(db: Db, v: Values): void {
  const out = asString(v.out);
  if (!out) throw new Error('export には --out <パス> が必要です');

  const filter = toFilter(v);
  const total = countCompanies(db, filter);
  console.error(`[書出] 該当 ${fmt(total)} 件 → ${out}`);

  const stream = createWriteStream(out, { encoding: 'utf8' });
  stream.write('﻿'); // 表計算ソフトで文字化けさせないため
  let written = 0;
  for (const line of toCsvLines(streamCompanies(db, filter, toSearchOptions(v)))) {
    stream.write(line + '\n');
    written++;
  }
  stream.end();
  console.error(`[書出] 完了 ${fmt(Math.max(0, written - 1))} 件`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options,
    allowPositionals: true,
  });
  const command = positionals[0];
  const v = values as Values;

  if (!command || command === 'help') {
    console.log(USAGE);
    return;
  }

  const dbPath = asString(v.db) ?? defaultDbPath();
  const db = openDb(dbPath);
  try {
    switch (command) {
      case 'ingest':
        await cmdIngest(db, v);
        break;
      case 'classify':
        cmdClassify(db, v);
        break;
      case 'serve':
        await cmdServe(db, v);
        break;
      case 'stats':
        cmdStats(db);
        break;
      case 'search':
        cmdSearch(db, v);
        break;
      case 'export':
        cmdExport(db, v);
        break;
      default:
        console.error(`不明なコマンド: ${command}\n`);
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error(`エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
