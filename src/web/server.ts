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
import {
  countCompanies,
  searchCompanies,
  streamCompanies,
  toCsvLines,
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
    sendJson(res, 200, meta);
    return;
  }

  if (url.pathname === '/api/cities') {
    const pref = q.get('pref');
    sendJson(res, 200, (pref && meta.cities[pref]) || []);
    return;
  }

  // 一覧と件数は別々に返す。件数の集計は数秒かかることがあるため、
  // 先に一覧を描いてから件数を追いつかせたい (画面側が 2 本同時に投げる)。
  if (url.pathname === '/api/search') {
    const limit = Math.min(Number(q.get('limit') ?? 50) || 50, 500);
    const offset = Math.max(Number(q.get('offset') ?? 0) || 0, 0);
    const started = Date.now();
    const rows = searchCompanies(db, filterFromParams(q), { ...optionsFromParams(q), limit, offset });
    sendJson(res, 200, { rows, offset, limit, elapsedMs: Date.now() - started });
    return;
  }

  if (url.pathname === '/api/count') {
    const started = Date.now();
    const total = countCompanies(db, filterFromParams(q));
    sendJson(res, 200, { total, elapsedMs: Date.now() - started });
    return;
  }

  if (url.pathname === '/api/export') {
    const filter = filterFromParams(q);
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="companies-${stamp}.csv"`,
    });
    res.write('﻿'); // 表計算ソフトで文字化けさせないため
    for (const line of toCsvLines(streamCompanies(db, filter, optionsFromParams(q)))) {
      res.write(line + '\n');
    }
    res.end();
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

  const port = options.port ?? 5173;
  server.listen(port, HOST, () => {
    options.onListen?.(`http://${HOST}:${port}/`);
  });
  return server;
}
