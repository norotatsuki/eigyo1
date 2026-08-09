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
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { openDb, defaultDbPath, type Db } from './db/index.ts';
import { loadZenken } from './ingest/nta/load.ts';
import { PREFECTURES, type Region } from './ingest/nta/catalog.ts';
import { COMPANY_KINDS, CORP_KIND_LABEL } from './ingest/nta/record.ts';
import { classifyAll } from './enrich/industry/classify.ts';
import { discoverHosts, fetchPageCount, DEFAULT_COLLECTION, DEFAULT_PATTERN } from './ingest/commoncrawl/hosts.ts';
import { crawlPendingHosts, rematchHosts } from './enrich/site/crawl.ts';
import { createLlm, estimateCost, roughTokens, DEFAULT_LLM } from './enrich/llm/client.ts';
import { enrichWithLlm } from './enrich/llm/enrich.ts';
import { GbizClient, type GbizSearch } from './ingest/gbizinfo/client.ts';
import { enrichFromGbiz, importFromSearch } from './ingest/gbizinfo/ingest.ts';
import { trimForLlm } from './enrich/llm/extract.ts';
import { applyGate, recordOutreach, CHANNEL_POLICY, type Channel } from './outreach/gate.ts';
import { CONFIG_PATH, PRESET_DAILY_CAP, checkChannelReady, configTemplate, loadConfig } from './outreach/config.ts';
import { runCampaign } from './outreach/campaign.ts';
import type { Template } from './outreach/template.ts';
import {
  addSuppressions, countSuppressions, removeSuppression, summarizeOutreach,
  saveSegment, getSegment, listSegments, deleteSegment,
  SUPPRESSION_REASONS, type SuppressionReason,
} from './outreach/store.ts';
import { divisionName, majorDivisionOf } from './enrich/industry/classification.ts';
import { serve } from './web/server.ts';
import {
  countCompanies,
  searchCompanies,
  streamCompanies,
  toCsvLines,
  toLabelCsvLines,
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

  discover ホスト名を集める (Common Crawl の公開索引。トークン不要)
    --pages <数>           取得するページ数 (既定 10 / 全体で 1153 ページ)
    --collection <版>      索引の版 (既定 CC-MAIN-2025-05)

  rematch  収集済みのデータだけで突き合わせをやり直す (サイトは訪ねない)

  gbiz     gBizINFO (経済産業省) から取り込む
    --search               条件を gBizINFO に投げて、当てはまる法人を取り込む
                           (売上・従業員数・資本金は手元に無いのでこちらを使う)
      --revenue-min/max <円>   売上高
      --employees-min/max <人> 従業員数
      --capital-min/max <円>   資本金
      --pref <コード>          都道府県
      --max-pages <数>         取得ページ数 (既定 5)
    --enrich               手元の絞り込み結果を 1 件ずつ照会して補完する
      --limit <数>             照会件数 (既定 100)
    ※ トークンは環境変数 GBIZ_API_TOKEN から読みます
      https://info.gbiz.go.jp/hojin/various_registration/form で取得

  llm      収集済みの本文を LLM に読ませ、取りこぼしを埋める (サイトは訪ねない)
    --limit <数>           対象の件数 (既定 50)
    --classify             業種の分類もかける
    --model <名前>         既定 gpt-4o-mini
    --estimate             費用の見積もりだけ出して終わる
    ※ 絞り込みの指定 (--pref / --industry など) を付けると、
      その範囲だけを補完します。全件にかける必要はまずありません
    ※ 鍵は環境変数 OPENAI_API_KEY から読みます
    ※ 抽出した値は原文に含まれることを確かめてから採用します
       (LLM が作った宛先を使わないため)

  crawl    集めたホストを訪ねて接触先を取り出し、法人番号に突き合わせる
    --limit <数>           訪ねる件数 (既定 50)
    --delay <ミリ秒>       1 本あたりの間隔 (既定 300)
    --concurrency <数>     同時に当たる相手の数 (既定 6)。相手は全て別のサイト

  init-config 送信の設定ファイルのひな形を作る
    --preset gmail|workspace   Gmail / Google Workspace の SMTP を埋めた形で作る
  config      設定の状態を見る (足りない項目を挙げる)

  send     施策を走らせる。既定は下見のみ。実送信は --live を明示したときだけ
    --channel <経路>       form / email / postal / phone
    --template <パス>      文面のひな形 (JSON)
    --campaign <名前>      施策名。記録に残る
    --limit <数>           送る上限
    --live                 実際に送る (設定が揃っていないと止まる)
    (絞り込みは search と同じ指定が使えます)

  suppress 除外リスト (絶対に接触しない先) を扱う
    --add <法人番号,…>     除外に積む
    --remove <法人番号>    除外から外す
    --reason <理由>        opt_out / refused / customer / competitor / bounced / manual
    --note <文字列>        理由の補足
    (引数なしで内訳を表示)

  outreach 接触記録を扱う
    --check <経路>         いま検索条件に合う先が送れるかを判定する
                           (postal / email / form / phone)
    --record <経路>        送った実績として記録する。--check で通った先が対象
    --campaign <名前>      施策名。記録に残る
    (引数なしで内訳を表示)

  segment  絞り込み条件に名前を付けて残す
    --save <名前>          いまの絞り込み条件を保存する
    --use <名前>           保存した条件を読み込んで検索する
    --delete <名前>        削除する
    (引数なしで一覧を表示)

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
    --employees-max <人>   従業員数の上限
    --revenue-min <円>     売上高の下限 (会社概要に載っていた分だけ)
    --revenue-max <円>     売上高の上限
    --assigned-from <日付> 法人番号指定年月日の下限 (YYYY-MM-DD)
    --has-website          サイトが判明している先だけ
    --has-form             問い合わせフォームが判明している先だけ
    --hiring               採用している先だけ (動いている印)
    --role <職種,…>        募集職種で絞る (施工管理 / 情報システム / 営業 …)
    --include-inactive     閉鎖・除外された法人も含める
    --include-refused      営業お断りの先も含める
    --limit <件数>         表示件数 (search のみ、既定 20)
    --order <並び>         name / assigned_desc / capital_desc / employees_desc
    --out <パス>           書き出し先 (export のみ)
    --labels               宛名の形で書き出す (差込印刷用。export のみ)
`.trim();

const options = {
  region: { type: 'string' },
  db: { type: 'string' },
  'min-confidence': { type: 'string' },
  port: { type: 'string' },
  labels: { type: 'boolean' },
  pages: { type: 'string' },
  collection: { type: 'string' },
  delay: { type: 'string' },
  channel: { type: 'string' },
  template: { type: 'string' },
  live: { type: 'boolean' },
  preset: { type: 'string' },
  classify: { type: 'boolean' },
  model: { type: 'string' },
  estimate: { type: 'boolean' },
  search: { type: 'boolean' },
  enrich: { type: 'boolean' },
  'max-pages': { type: 'string' },
  concurrency: { type: 'string' },
  'capital-max': { type: 'string' },
  add: { type: 'string' },
  remove: { type: 'string' },
  reason: { type: 'string' },
  note: { type: 'string' },
  check: { type: 'string' },
  record: { type: 'string' },
  campaign: { type: 'string' },
  save: { type: 'string' },
  use: { type: 'string' },
  delete: { type: 'string' },
  keyword: { type: 'string' },
  pref: { type: 'string' },
  kind: { type: 'string' },
  companies: { type: 'boolean' },
  form: { type: 'string' },
  industry: { type: 'string' },
  'industry-confidence': { type: 'string' },
  'capital-min': { type: 'string' },
  'employees-min': { type: 'string' },
  'employees-max': { type: 'string' },
  'revenue-min': { type: 'string' },
  'revenue-max': { type: 'string' },
  'assigned-from': { type: 'string' },
  'has-website': { type: 'boolean' },
  'has-form': { type: 'boolean' },
  hiring: { type: 'boolean' },
  role: { type: 'string' },
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

function toFilter(v: Values, base: SearchFilter | null = null): SearchFilter {
  const filter: SearchFilter = {
    ...(base ?? {}),
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
  const capitalMax = num(v['capital-max']);
  if (capitalMax !== undefined) filter.capitalMax = capitalMax;
  const employeesMin = num(v['employees-min']);
  if (employeesMin !== undefined) filter.employeesMin = employeesMin;
  const employeesMax = num(v['employees-max']);
  if (employeesMax !== undefined) filter.employeesMax = employeesMax;
  const revenueMin = num(v['revenue-min']);
  if (revenueMin !== undefined) filter.revenueMin = revenueMin;
  const revenueMax = num(v['revenue-max']);
  if (revenueMax !== undefined) filter.revenueMax = revenueMax;
  const assignedFrom = asString(v['assigned-from']);
  if (assignedFrom) filter.assignedFrom = assignedFrom;
  if (v['has-website'] === true) filter.hasWebsite = true;
  if (v['has-form'] === true) filter.hasContactForm = true;
  if (v.hiring === true) filter.hiring = true;
  const roles = list(v.role);
  if (roles) filter.hiringRoles = roles;
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

async function cmdDiscover(db: Db, v: Values): Promise<void> {
  const pages = num(v.pages) ?? 10;
  const collection = asString(v.collection) ?? DEFAULT_COLLECTION;
  console.error(`[発見] ${collection} から ${pages} ページ分のホスト名を集めます`);
  try {
    const total = await fetchPageCount(collection, DEFAULT_PATTERN);
    console.error(`[発見] この索引には ${fmt(total)} ページあります`);
  } catch {
    console.error('[発見] ページ総数を取得できませんでした (続行します)');
  }

  const r = await discoverHosts(db, {
    collection, pages,
    onProgress: (page, found, inserted) =>
      console.error(`[発見] ページ ${page}: ホスト ${fmt(found)} / 新規 ${fmt(inserted)}`),
  });
  console.error(
    `[発見] 完了 ${r.pagesFetched} ページ / 新規 ${fmt(r.hostsInserted)} 件 / ` +
      `累計 ${fmt(r.totalHosts)} 件` + (r.failures > 0 ? ` / 失敗 ${r.failures} ページ` : ''),
  );
}

async function cmdGbiz(db: Db, v: Values, base: SearchFilter | null): Promise<void> {
  let client: GbizClient;
  try {
    client = new GbizClient();
  } catch (err) {
    console.error(`[gBiz] ${err instanceof Error ? err.message : String(err)}`);
    console.error('[gBiz] 動作確認だけなら GBIZ_API_TOKEN に仕様書公開の確認用トークンを入れられます');
    process.exitCode = 1;
    return;
  }

  if (v.search === true) {
    const params: GbizSearch = {};
    const set = (k: keyof GbizSearch, n: number | undefined): void => {
      if (n !== undefined) (params as Record<string, unknown>)[k] = n;
    };
    set('net_sales_summary_of_business_results_from', num(v['revenue-min']));
    set('net_sales_summary_of_business_results_to', num(v['revenue-max']));
    set('employee_number_from', num(v['employees-min']));
    set('employee_number_to', num(v['employees-max']));
    set('capital_stock_from', num(v['capital-min']));
    set('capital_stock_to', num(v['capital-max']));
    const pref = list(v.pref)?.[0];
    if (pref) params.prefecture = pref;

    console.error(`[gBiz] 条件を投げます: ${JSON.stringify(params)}`);
    const r = await importFromSearch(db, client, params, {
      maxPages: num(v['max-pages']) ?? 5,
      onProgress: (page, found) => console.error(`[gBiz] ${page} ページ目 / 累計 ${fmt(found)} 件`),
    });
    console.log(`gBizINFO から ${fmt(r.found)} 件 (${r.pages} ページ)`);
    console.log(`  手元のマスタにあった  ${fmt(r.inMaster)}`);
    console.log(`  付加情報を取り込んだ  ${fmt(r.imported)}`);
    if (r.found > r.inMaster) {
      console.log(`  ※ ${fmt(r.found - r.inMaster)} 件は手元に無い法人 (国税庁データが唯一の正なので取り込まない)`);
    }
    return;
  }

  const r = await enrichFromGbiz(db, client, {
    ...(base || v.pref || v.industry ? { scope: toFilter(v, base) } : {}),
    ...(num(v.limit) !== undefined ? { limit: num(v.limit)! } : {}),
    onProgress: (done, filled) => {
      if (done % 20 === 0) console.error(`[gBiz] ${fmt(done)} 件照会 / ${fmt(filled)} 件で値が入った`);
    },
  });
  console.log(`照会 ${fmt(r.queried)} 件 / 応答 ${fmt(r.responded)} 件`);
  console.log(`  資本金が入った  ${fmt(r.filled.capital).padStart(6)}`);
  console.log(`  従業員数        ${fmt(r.filled.employees).padStart(6)}`);
  console.log(`  企業HP          ${fmt(r.filled.url).padStart(6)}`);
  console.log(`  設立年月日      ${fmt(r.filled.founded).padStart(6)}`);
  console.log(`  中身が空        ${fmt(r.empty).padStart(6)}  ← 国の調達・補助金・特許に関わりが無い法人`);
  if (r.errors > 0) console.log(`  応答が得られず  ${fmt(r.errors).padStart(6)}`);
}

async function cmdLlm(db: Db, v: Values, base: SearchFilter | null): Promise<void> {
  const limit = num(v.limit) ?? 50;
  const classify = v.classify === true;

  const target = db.prepare(
    `SELECT COUNT(*) AS n FROM web_hosts WHERE crawl_status = 'ok' AND site_text IS NOT NULL
       AND (site_name IS NULL OR site_address IS NULL OR corporate_number IS NULL)`,
  ).get() as { n: number };
  const noText = db.prepare(
    "SELECT COUNT(*) AS n FROM web_hosts WHERE crawl_status = 'ok' AND site_text IS NULL",
  ).get() as { n: number };

  console.error(`[LLM] 埋められる先: ${fmt(target.n)} 件`);
  if (noText.n > 0) {
    console.error(`[LLM] 本文を保存していない先が ${fmt(noText.n)} 件あります (本文の保存は後から入れたため)`);
    console.error('[LLM] これらは crawl で訪ね直すと対象になります');
  }

  // 見積もりは推測ではなく実データから。抜粋したあとの長さを実際に測る
  const sample = db.prepare(
    `SELECT site_text FROM web_hosts WHERE crawl_status = 'ok' AND site_text IS NOT NULL LIMIT 200`,
  ).all() as Array<{ site_text: string }>;
  const avgChars = sample.length > 0
    ? sample.reduce((a, r) => a + trimForLlm(r.site_text).length, 0) / sample.length
    : 1500;
  const perCall = { input: roughTokens('あ'.repeat(Math.round(avgChars))), output: 100 };
  const calls = Math.min(limit, target.n) * (classify ? 2 : 1);
  const pricing = { inputPerMillion: 0.15, outputPerMillion: 0.6, currency: 'USD' };
  const estimate = estimateCost(
    { promptTokens: perCall.input * calls, completionTokens: perCall.output * calls, calls },
    pricing,
  );
  console.error(`[LLM] 1 件あたり 約 ${Math.round(avgChars)} 文字を送ります (抜粋後・実測)`);
  console.error(`[LLM] 見積もり: ${fmt(calls)} 回 / 約 $${estimate.toFixed(2)} (gpt-4o-mini の単価で計算)`);
  const forAll = (estimate / Math.max(1, Math.min(limit, target.n))) * target.n;
  if (target.n > limit) console.error(`[LLM] 全 ${fmt(target.n)} 件なら 約 $${forAll.toFixed(2)}`);

  if (v.estimate === true) {
    console.error('[LLM] 見積もりのみ。実行するには --estimate を外してください');
    return;
  }

  let llm;
  try {
    llm = createLlm({ ...DEFAULT_LLM, ...(asString(v.model) ? { model: asString(v.model)! } : {}) });
  } catch (err) {
    console.error(`[LLM] ${err instanceof Error ? err.message : String(err)}`);
    console.error('[LLM] export OPENAI_API_KEY="..." を実行してください');
    process.exitCode = 1;
    return;
  }

  const r = await enrichWithLlm(db, llm, {
    limit, classify, pricing,
    ...(base || v.pref || v.industry || v.keyword ? { scope: toFilter(v, base) } : {}),
    onProgress: (done, matched, cost) => {
      if (done % 10 === 0) console.error(`[LLM] ${fmt(done)} 件 / 新たに紐付き ${fmt(matched)} / 約 $${cost.toFixed(3)}`);
    },
  });

  console.log(`走査 ${fmt(r.scanned)} 件 — 約 $${r.estimatedCost.toFixed(3)} (${fmt(r.usage.calls)} 回)`);
  console.log(`  会社名を補えた    ${fmt(r.filled.name).padStart(6)}`);
  console.log(`  住所を補えた      ${fmt(r.filled.address).padStart(6)}`);
  console.log(`  電話を補えた      ${fmt(r.filled.tel).padStart(6)}`);
  console.log(`  メールを補えた    ${fmt(r.filled.email).padStart(6)}`);
  console.log(`  新たに紐付いた    ${fmt(r.newlyMatched).padStart(6)}`);
  if (classify) console.log(`  業種を入れた      ${fmt(r.classified).padStart(6)}`);
  console.log(`  原文に無く捨てた  ${fmt(r.rejected).padStart(6)}  ← LLM が作った値`);
  if (r.errors > 0) console.log(`  応答が得られず    ${fmt(r.errors).padStart(6)}`);
}

function cmdRematch(db: Db): void {
  console.error('[再照合] 収集済みのデータで突き合わせをやり直します (サイトは訪ねません)');
  const started = Date.now();
  const r = rematchHosts(db);
  console.log(`走査 ${fmt(r.scanned)} 件 / 紐付き ${fmt(r.matched)} 件 / 変わった ${fmt(r.changed)} 件 — ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
  for (const [m, n] of Object.entries(r.byMethod).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${m.padEnd(16, ' ')} ${fmt(n).padStart(8)}`);
  }
}

async function cmdCrawl(db: Db, v: Values): Promise<void> {
  const limit = num(v.limit) ?? 50;
  const delayMs = num(v.delay) ?? 300;
  const concurrency = num(v.concurrency) ?? 6;
  const pending = db.prepare("SELECT COUNT(*) AS n FROM web_hosts WHERE crawl_status = 'pending'").get() as { n: number };
  console.error(`[収集] 未訪問 ${fmt(pending.n)} 件のうち ${fmt(limit)} 件を訪ねます (同時 ${concurrency} / 間隔 ${delayMs}ms)`);

  const started = Date.now();
  const r = await crawlPendingHosts(db, {
    limit, delayMs, concurrency,
    onProgress: (done, matched) => {
      if (done % 10 === 0) console.error(`[収集] ${fmt(done)} 件 / 紐付き ${fmt(matched)} 件`);
    },
  });
  const sec = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`訪問 ${fmt(r.visited)} 件 — ${sec} 秒`);
  console.log(`  取得できた          ${fmt(r.ok).padStart(6)}`);
  console.log(`  接続できなかった    ${fmt(r.failed).padStart(6)}`);
  console.log(`  robots.txt で不可   ${fmt(r.disallowed).padStart(6)}`);
  console.log(`  法人番号に紐付いた  ${fmt(r.matched).padStart(6)}`);
  console.log(`  問い合わせ先が判明  ${fmt(r.contactFound).padStart(6)}`);
  console.log(`  営業お断りを検出    ${fmt(r.refusedFound).padStart(6)}`);
}

function cmdInitConfig(v: Values): void {
  if (existsSync(CONFIG_PATH)) {
    console.error(`[設定] 既にあります: ${CONFIG_PATH}`);
    return;
  }
  const presetArg = asString(v.preset);
  if (presetArg && presetArg !== 'gmail' && presetArg !== 'workspace') {
    throw new Error(`--preset は gmail か workspace を指定してください (指定: ${presetArg})`);
  }
  const preset = presetArg as 'gmail' | 'workspace' | undefined;
  writeFileSync(CONFIG_PATH, JSON.stringify(configTemplate(preset), null, 2) + '\n', 'utf8');
  console.error(`[設定] ひな形を作りました: ${CONFIG_PATH}`);
  console.error('[設定] identity の 4 項目は特定電子メール法 4 条の要求です。必ず埋めてください');
  if (preset) {
    console.error('');
    console.error('[設定] Gmail で送るには「アプリパスワード」が要ります:');
    console.error('  1. Google アカウントで二段階認証を有効にする');
    console.error('  2. https://myaccount.google.com/apppasswords で発行する');
    console.error('  3. export EIGYO_SMTP_PASS="発行された16桁" を実行する');
    console.error('  4. email.fromAddress と email.smtp.user に Gmail のアドレスを入れる');
    console.error('');
    console.error(`[設定] 1 日の上限は ${PRESET_DAILY_CAP[preset]} 通にしてあります`);
    console.error('[設定] 普段使いのアドレスから大量に送ると、アカウントが止まる恐れがあります');
  }
}

function cmdConfig(): void {
  const { config, missing } = loadConfig();
  if (missing.length > 0) {
    console.log('足りない項目:');
    for (const m of missing) console.log(`  - ${m}`);
  } else {
    console.log('法定表示: 揃っています');
  }
  for (const ch of ['form', 'email'] as const) {
    const lack = checkChannelReady(config, ch);
    console.log(lack.length === 0 ? `${ch}: 送れます` : `${ch}: 送れません`);
    for (const m of lack) console.log(`  - ${m}`);
  }
}

async function cmdSend(db: Db, v: Values, base: SearchFilter | null): Promise<void> {
  const channel = (asString(v.channel) ?? 'form') as Channel;
  if (!(channel in CHANNEL_POLICY)) throw new Error(`経路の指定が不正です: ${channel}`);
  const campaign = asString(v.campaign);
  if (!campaign) throw new Error('--campaign <名前> を指定してください (記録に残ります)');

  const templatePath = asString(v.template);
  if (!templatePath) throw new Error('--template <パス> を指定してください');
  const template = JSON.parse(readFileSync(templatePath, 'utf8')) as Template;

  const { config } = loadConfig();
  const live = v.live === true;
  console.error(live ? '[送信] 実際に送ります' : '[送信] 下見のみ (実際に送るには --live)');

  const r = await runCampaign(db, toFilter(v, base), channel, template, config, {
    live, campaign,
    ...(num(v.limit) !== undefined ? { limit: num(v.limit)! } : {}),
    evidenceDir: '.send-logs',
    onProgress: (done, sent) => console.error(`[送信] ${fmt(done)} 件処理 / ${fmt(sent)} 件送信`),
  });

  if (r.blockers.length > 0) {
    console.log('実行できません。先に次を直してください:');
    for (const b of r.blockers) console.log(`  - ${b}`);
    process.exitCode = 1;
    return;
  }

  console.log(`候補 ${fmt(r.candidates)} 件 / ゲートで除外 ${fmt(r.blockedByGate)} 件`);
  for (const [reason, n] of Object.entries(r.blockedByReason)) console.log(`    ${reason.padEnd(16, ' ')} ${fmt(n)}`);
  console.log(`対象 ${fmt(r.attempted)} 件 — 送信 ${fmt(r.sent)} / 見送り ${fmt(r.skipped)} / 失敗 ${fmt(r.failed)}`);
  for (const [reason, n] of Object.entries(r.skipReasons)) console.log(`    見送り: ${reason} — ${fmt(n)} 件`);

  if (!live && r.preview) {
    console.log('');
    console.log('── 1 通目の中身 ──');
    console.log(`宛先: ${r.preview.to}`);
    console.log(`件名: ${r.preview.subject}`);
    console.log('---');
    console.log(r.preview.body);
  }
}

function cmdSuppress(db: Db, v: Values): void {
  const add = list(v.add);
  const remove = asString(v.remove);

  if (add?.length) {
    const reason = (asString(v.reason) ?? 'manual') as SuppressionReason;
    if (!SUPPRESSION_REASONS.includes(reason)) {
      throw new Error(`理由の指定が不正です: ${reason} (${SUPPRESSION_REASONS.join(' / ')})`);
    }
    const note = asString(v.note);
    addSuppressions(
      db,
      add.map((n) => ({ corporateNumber: n, reason, ...(note ? { note } : {}) })),
    );
    console.error(`[除外] ${fmt(add.length)} 件を積みました (理由: ${reason})`);
  }
  if (remove) {
    console.error(removeSuppression(db, remove) ? `[除外] ${remove} を外しました` : `[除外] ${remove} は載っていません`);
  }

  const rows = countSuppressions(db);
  const total = rows.reduce((s, r) => s + r.count, 0);
  console.log(`除外リスト: ${fmt(total)} 件`);
  for (const r of rows) console.log(`  ${r.reason.padEnd(12, ' ')} ${fmt(r.count).padStart(8)}`);
  if (total === 0) console.log('  (まだ何も積まれていません)');
}

function cmdOutreach(db: Db, v: Values, base: SearchFilter | null): void {
  const check = asString(v.check) as Channel | undefined;
  const record = asString(v.record) as Channel | undefined;
  const channel = check ?? record;

  if (channel) {
    if (!(channel in CHANNEL_POLICY)) {
      throw new Error(`経路の指定が不正です: ${channel} (${Object.keys(CHANNEL_POLICY).join(' / ')})`);
    }
    const filter = toFilter(v, base);
    const numbers = [...streamCompanies(db, filter)].map((r) => r.corporate_number);
    console.error(`[接触] 検索条件に合う ${fmt(numbers.length)} 件を ${channel} で判定します`);

    const campaign = asString(v.campaign);
    const result = applyGate(db, numbers, channel, { ...(campaign ? { campaign } : {}) });

    console.log(`送れる: ${fmt(result.allowed.length)} 件 / 止めた: ${fmt(result.blocked.length)} 件`);
    for (const [reason, n] of Object.entries(result.blockedByReason)) {
      console.log(`  止めた理由 ${reason.padEnd(16, ' ')} ${fmt(n).padStart(8)}`);
    }

    if (record) {
      const write = db.transaction((ns: string[]) => {
        for (const n of ns) {
          recordOutreach(db, {
            corporateNumber: n, channel, outcome: 'sent',
            ...(campaign ? { campaign } : {}),
          });
        }
      });
      write(result.allowed);
      console.error(`[接触] ${fmt(result.allowed.length)} 件を送付済みとして記録しました`);
    } else {
      console.error('[接触] 判定のみ。記録するには --record <経路> を使ってください');
    }
    return;
  }

  const summary = summarizeOutreach(db, asString(v.campaign));
  if (summary.length === 0) {
    console.log('接触の記録はまだありません。');
    return;
  }
  console.log('接触の内訳');
  for (const r of summary) {
    console.log(`  ${r.channel.padEnd(8, ' ')} ${r.outcome.padEnd(10, ' ')} ${fmt(r.count).padStart(8)}`);
  }
}

function cmdSegment(db: Db, v: Values, base: SearchFilter | null): SearchFilter | null {
  const save = asString(v.save);
  const use = asString(v.use);
  const del = asString(v.delete);

  if (save) {
    saveSegment(db, save, toFilter(v, base), asString(v.note));
    console.error(`[条件] 「${save}」を保存しました`);
    return null;
  }
  if (del) {
    console.error(deleteSegment(db, del) ? `[条件] 「${del}」を削除しました` : `[条件] 「${del}」はありません`);
    return null;
  }
  if (use) {
    const s = getSegment(db, use);
    if (!s) throw new Error(`保存された条件が見つかりません: ${use}`);
    return s.filter;
  }

  const all = listSegments(db);
  if (all.length === 0) {
    console.log('保存された条件はありません。search の条件に --save <名前> を付けて保存できます。');
    return null;
  }
  console.log('保存された条件');
  for (const s of all) {
    console.log(`  ${s.name}${s.note ? `  — ${s.note}` : ''}`);
    console.log(`      ${JSON.stringify(s.filter)}`);
  }
  return null;
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

function cmdSearch(db: Db, v: Values, base: SearchFilter | null): void {
  const filter = toFilter(v, base);
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

function cmdExport(db: Db, v: Values, base: SearchFilter | null): void {
  const out = asString(v.out);
  if (!out) throw new Error('export には --out <パス> が必要です');

  const filter = toFilter(v, base);
  const total = countCompanies(db, filter);
  console.error(`[書出] 該当 ${fmt(total)} 件 → ${out}`);

  const stream = createWriteStream(out, { encoding: 'utf8' });
  stream.write('﻿'); // 表計算ソフトで文字化けさせないため
  const rows = streamCompanies(db, filter, toSearchOptions(v));
  const lines = v.labels === true ? toLabelCsvLines(rows) : toCsvLines(rows);
  let written = 0;
  for (const line of lines) {
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
    // 保存した条件を土台にする。--use 以外の指定はその上から重ねる
    const useName = asString(v.use);
    let base: SearchFilter | null = null;
    if (useName && command !== 'segment') {
      const s = getSegment(db, useName);
      if (!s) throw new Error(`保存された条件が見つかりません: ${useName}`);
      base = s.filter;
      console.error(`[条件] 「${useName}」を読み込みました`);
    }
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
        cmdSearch(db, v, base);
        break;
      case 'export':
        cmdExport(db, v, base);
        break;
      case 'discover':
        await cmdDiscover(db, v);
        break;
      case 'rematch':
        cmdRematch(db);
        break;
      case 'gbiz':
        await cmdGbiz(db, v, base);
        break;
      case 'llm':
        await cmdLlm(db, v, base);
        break;
      case 'crawl':
        await cmdCrawl(db, v);
        break;
      case 'init-config':
        cmdInitConfig(v);
        break;
      case 'config':
        cmdConfig();
        break;
      case 'send':
        await cmdSend(db, v, base);
        break;
      case 'suppress':
        cmdSuppress(db, v);
        break;
      case 'outreach':
        cmdOutreach(db, v, base);
        break;
      case 'segment':
        cmdSegment(db, v, base);
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
