/**
 * 社内利用の画面を出す小さなサーバ。
 *
 * 待受は 127.0.0.1 のみ。社外はもちろん、同じ LAN の他の端末からも届かない。
 * 手元の法人データは外に出さない前提の道具なので、既定を内向きにしておく。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Db } from '../db/index.ts';
import { loadMeta, type Meta } from '../search/meta.ts';
import { CAPITAL_BANDS, EMPLOYEE_BANDS, REVENUE_BANDS } from '../search/bands.ts';
import { scaleWithEstimates } from '../enrich/estimate.ts';
import {
  breakdown,
  countCompanies,
  searchCompanies,
  streamCompanies,
  toCsvLines,
  toLabelCsvLines,
  type SearchFilter,
  type SearchOptions,
} from '../search/query.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';

/** 検索条件を要求の問い合わせ文字列から組み立てる。 */
export function filterFromParams(q: URLSearchParams): SearchFilter {
  const filter: SearchFilter = {
    activeOnly: q.get('includeInactive') !== '1',
    excludeRefused: q.get('includeRefused') !== '1',
  };
  const list = (k: string): string[] | undefined => {
    const v = q.getAll(k).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
    return v.length > 0 ? v : undefined;
  };
  const num = (k: string): number | undefined => {
    const v = q.get(k);
    if (v === null || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const keyword = q.get('keyword')?.trim();
  if (keyword) filter.keyword = keyword;
  const pref = list('pref');
  if (pref) filter.prefCodes = pref;
  const city = list('city');
  if (city) filter.cityCodes = city;
  const kind = list('kind')?.map(Number).filter(Number.isFinite);
  if (kind?.length) filter.kinds = kind;
  const form = list('form');
  if (form) filter.corpForms = form;
  const industry = list('industry');
  if (industry) filter.industryCodes = industry;
  // 確信度は業種の絞り込みに付随する条件。業種を選んでいないのに効かせると、
  // 業種が未推定の 430 万社が黙って消えて「営業対象 500 万社」と食い違う
  const conf = num('industryConfidence');
  if (conf !== undefined && industry) filter.industryMinConfidence = conf;
  const capitalMin = num('capitalMin');
  if (capitalMin !== undefined) filter.capitalMin = capitalMin;
  const employeesMin = num('employeesMin');
  if (employeesMin !== undefined) filter.employeesMin = employeesMin;
  const assignedFrom = q.get('assignedFrom')?.trim();
  if (assignedFrom) filter.assignedFrom = assignedFrom;
  const assignedTo = q.get('assignedTo')?.trim();
  if (assignedTo) filter.assignedTo = assignedTo;
  if (q.get('hasWebsite') === '1') filter.hasWebsite = true;
  if (q.get('hasContactForm') === '1') filter.hasContactForm = true;
  if (q.get('hasEmail') === '1') filter.hasEmail = true;
  if (q.get('reachable') === '1') filter.reachable = true;
  if (q.get('hasRepresentative') === '1') filter.hasRepresentative = true;
  const employeeBands = list('employeeBand');
  if (employeeBands) filter.employeeBands = employeeBands;
  const capitalBands = list('capitalBand');
  if (capitalBands) filter.capitalBands = capitalBands;
  const revenueBands = list('revenueBand');
  if (revenueBands) filter.revenueBands = revenueBands;
  return filter;
}

function optionsFromParams(q: URLSearchParams): SearchOptions {
  const opts: SearchOptions = {};
  const order = q.get('order');
  if (order === 'name' || order === 'assigned_desc' || order === 'capital_desc' || order === 'employees_desc') {
    opts.orderBy = order;
  }
  return opts;
}

/**
 * 政令指定都市を「市まるごと」でも選べるようにする。
 *
 * 国税庁のデータは区の単位で持っている (横浜市は 18 区に分かれる)。
 * 「横浜市で探したい」のが普通なので、区を束ねた見出しを足す。
 * 値は区のコードをまとめたもので、区ごとに選ぶことも引き続きできる。
 */
export function withWholeCities(
  cities: ReadonlyArray<{ code: string; label: string; count: number }>,
): Array<{ code: string; label: string; count: number }> {
  const wards = new Map<string, Array<{ code: string; label: string; count: number }>>();
  for (const c of cities) {
    const m = c.label.match(/^(.+?市)(.+区)$/);
    if (!m?.[1]) continue;
    const list = wards.get(m[1]) ?? [];
    list.push(c);
    wards.set(m[1], list);
  }

  const out: Array<{ code: string; label: string; count: number }> = [];
  const emitted = new Set<string>();
  for (const c of cities) {
    const m = c.label.match(/^(.+?市)(.+区)$/);
    const parent = m?.[1];
    // 区が 2 つ以上あるときだけ束ねる (1 つなら束ねる意味がない)
    if (parent && (wards.get(parent)?.length ?? 0) > 1 && !emitted.has(parent)) {
      emitted.add(parent);
      const group = wards.get(parent)!;
      out.push({
        code: group.map((w) => w.code).join(','),
        label: `${parent} (全${group.length}区)`,
        count: group.reduce((n, w) => n + w.count, 0),
      });
    }
    out.push(c);
  }
  return out;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function handle(db: Db, meta: Meta, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const q = url.searchParams;

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(HERE, 'app.html'), 'utf8'));
    return;
  }

  if (url.pathname === '/api/meta') {
    // 帯の選択肢も一緒に返す。画面と絞り込みで定義がずれないようにするため
    sendJson(res, 200, {
      ...meta,
      bands: { employees: EMPLOYEE_BANDS, capital: CAPITAL_BANDS, revenue: REVENUE_BANDS },
    });
    return;
  }

  if (url.pathname === '/api/cities') {
    const pref = q.get('pref');
    sendJson(res, 200, withWholeCities((pref && meta.cities[pref]) || []));
    return;
  }

  // 一覧と件数は別々に返す。件数の集計は数秒かかることがあるため、
  // 先に一覧を描いてから件数を追いつかせたい (画面側が 2 本同時に投げる)。
  if (url.pathname === '/api/search') {
    const limit = Math.min(Number(q.get('limit') ?? 50) || 50, 500);
    const offset = Math.max(Number(q.get('offset') ?? 0) || 0, 0);
    const started = Date.now();
    const rows = searchCompanies(db, filterFromParams(q), { ...optionsFromParams(q), limit, offset })
      // 従業員数と年商は書いていない会社が多い。実測値が無い先には推定を添える。
      // 実測か推定かは必ず区別して返す (画面と CSV でそのまま出す)
      .map((r) => ({ ...r, scale: scaleWithEstimates(r.capital, r.employees, r.revenue) }));
    sendJson(res, 200, { rows, offset, limit, elapsedMs: Date.now() - started });
    return;
  }

  /**
   * いまの条件のまま、切り口ごとの件数を返す。
   *
   * 数を見てから狙いを決められるようにするためのもの。
   * 一覧より重いことがあるので、画面側は別々に投げて後から埋める。
   */
  if (url.pathname === '/api/breakdown') {
    const dimension = q.get('dimension') ?? 'employees';
    const allowed = ['employees', 'revenue', 'capital', 'city', 'pref', 'industry'] as const;
    if (!(allowed as readonly string[]).includes(dimension)) {
      sendJson(res, 400, { error: `知らない切り口: ${dimension}` });
      return;
    }
    const started = Date.now();
    const slices = breakdown(db, filterFromParams(q), dimension as (typeof allowed)[number]);
    sendJson(res, 200, { dimension, slices, elapsedMs: Date.now() - started });
    return;
  }

  if (url.pathname === '/api/count') {
    const started = Date.now();
    const total = countCompanies(db, filterFromParams(q));
    sendJson(res, 200, { total, elapsedMs: Date.now() - started });
    return;
  }

  if (url.pathname === '/api/export') {
    const labels = q.get('labels') === '1';
    const rows = streamCompanies(db, filterFromParams(q), optionsFromParams(q));
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${labels ? 'labels' : 'companies'}-${stamp}.csv"`,
    });
    res.write('﻿'); // 表計算ソフトで文字化けさせないため
    for (const line of labels ? toLabelCsvLines(rows) : toCsvLines(rows)) {
      res.write(line + '\n');
    }
    res.end();
    return;
  }

  /**
   * 収集の進み具合。画面の見出しに出す。
   *
   * リストは今も増え続けている。「いま何件まで集まっているか」が
   * 見えないと、少ない検索結果を見て「壊れている」と勘違いする。
   */
  if (url.pathname === '/api/progress') {
    const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    sendJson(res, 200, {
      hosts: one('SELECT COUNT(*) AS n FROM web_hosts'),
      visited: one("SELECT COUNT(*) AS n FROM web_hosts WHERE crawl_status <> 'pending'"),
      matched: one('SELECT COUNT(*) AS n FROM web_hosts WHERE corporate_number IS NOT NULL'),
      withForm: one('SELECT COUNT(*) AS n FROM company_profiles WHERE contact_form_url IS NOT NULL'),
      withEmail: one('SELECT COUNT(*) AS n FROM company_profiles WHERE contact_email IS NOT NULL'),
      withRep: one('SELECT COUNT(*) AS n FROM company_profiles WHERE representative IS NOT NULL'),
      refused: one('SELECT COUNT(*) AS n FROM company_profiles WHERE solicitation_refused = 1'),
    });
    return;
  }

  // 接触の状況。画面の見出しに出す
  if (url.pathname === '/api/outreach-summary') {
    const suppressed = db.prepare('SELECT COUNT(*) AS n FROM suppressions').get() as { n: number };
    const sent = db
      .prepare("SELECT COUNT(DISTINCT corporate_number) AS n FROM outreach_log WHERE outcome = 'sent'")
      .get() as { n: number };
    sendJson(res, 200, { suppressed: suppressed.n, contacted: sent.n });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

export interface ServeOptions {
  port?: number;
  onListen?: (url: string) => void;
}

/** 画面を出す。呼び出し側が止められるよう、サーバを返す。 */
export function serve(db: Db, options: ServeOptions = {}) {
  const meta = loadMeta(db, {
    onCompute: () => console.error('[画面] 選択肢の集計を作ります (初回のみ 1 分ほど)…'),
  });
  const server = createServer((req, res) => {
    try {
      handle(db, meta, req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.end();
    }
  });

  // 待受口が別の何かに使われていることは普通に起きる (5173 は他の道具もよく使う)。
  // そこで生のエラーを出して終わると、利用者は何をすればよいか分からない。
  // 空いている口を探して、どこで開いたかを伝える。
  const wanted = options.port ?? 5173;

  // 案内するのは「実際に確保できた口」。listen に渡した番号ではない。
  // 再試行のたびに callback を渡すと、失敗した番号の callback も後から発火して
  // 開けない URL を案内してしまう (実際に起きた)。
  server.on('listening', () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : wanted;
    options.onListen?.(`http://${HOST}:${port}/`);
  });

  let attemptsLeft = 10;
  let current = wanted;
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      attemptsLeft--;
      current++;
      console.error(`[画面] ${current - 1} は使用中のため ${current} を試します`);
      server.listen(current, HOST);
      return;
    }
    console.error(
      err.code === 'EADDRINUSE'
        ? `[画面] ${wanted} から ${current} まで空きがありません。--port で指定してください`
        : `[画面] 起動できません: ${err.message}`,
    );
    process.exitCode = 1;
  });

  server.listen(wanted, HOST);
  return server;
}
