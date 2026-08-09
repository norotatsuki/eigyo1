/**
 * gBizINFO の内容を手元のマスタに取り込む。
 *
 * gBizINFO は **権威ある出典** として扱う。
 * 商号やサイト本文からの推定より優先し、上書きしてよい。
 * 逆に、gBizINFO が入っている先を推定で上書きしてはいけない
 * (src/enrich/industry/classify.ts の AUTHORITATIVE_SOURCES を参照)。
 */
import type { Db } from '../../db/index.ts';
import { finishRun, startRun } from '../../db/index.ts';
import { invalidateMeta, loadMeta } from '../../search/meta.ts';
import { searchCompanies, type SearchFilter } from '../../search/query.ts';
import type { GbizClient, GbizHojin, GbizSearch } from './client.ts';

export const SOURCE = 'gbizinfo';

export interface EnrichResult {
  queried: number;
  responded: number;
  /** 実際に値が入った項目の数 */
  filled: { capital: number; employees: number; url: number; summary: number; founded: number };
  /** 応答はあったが中身が空だった数 */
  empty: number;
  errors: number;
}

const UPSERT = `
INSERT INTO company_profiles
  (corporate_number, capital, employees, scale_source, website_url, website_confidence,
   website_checked_at, founded_date, updated_at)
VALUES (@n, @capital, @employees, @source, @url, @conf, @at, @founded, @at)
ON CONFLICT(corporate_number) DO UPDATE SET
  -- gBizINFO は権威ある出典。推定で入っていた値は上書きしてよい
  capital       = COALESCE(excluded.capital, company_profiles.capital),
  employees     = COALESCE(excluded.employees, company_profiles.employees),
  scale_source  = CASE WHEN excluded.capital IS NOT NULL OR excluded.employees IS NOT NULL
                       THEN excluded.scale_source ELSE company_profiles.scale_source END,
  website_url   = COALESCE(excluded.website_url, company_profiles.website_url),
  website_confidence = CASE WHEN excluded.website_url IS NOT NULL
                            THEN excluded.website_confidence ELSE company_profiles.website_confidence END,
  founded_date  = COALESCE(excluded.founded_date, company_profiles.founded_date),
  updated_at    = excluded.updated_at
`;

/** gBizINFO の 1 件を手元の形に移す。値が無い項目は null のまま。 */
export function toProfile(h: GbizHojin): {
  capital: number | null; employees: number | null; url: string | null; founded: string | null;
} {
  return {
    capital: typeof h.capital_stock === 'number' && h.capital_stock > 0 ? h.capital_stock : null,
    employees: typeof h.employee_number === 'number' && h.employee_number > 0 ? h.employee_number : null,
    url: h.company_url && h.company_url.startsWith('http') ? h.company_url : null,
    founded: h.date_of_establishment ?? (h.founding_year ? `${h.founding_year}-01-01` : null),
  };
}

export interface EnrichOptions {
  /** 補完する範囲。指定しないと手当たり次第になるので必ず絞る */
  scope?: SearchFilter;
  limit?: number;
  onProgress?: (done: number, filled: number) => void;
}

/**
 * 手元の絞り込み結果に対して、1 件ずつ gBizINFO に問い合わせる。
 *
 * 無作為な中小企業には gBizINFO の付加情報が入っていないことが多い
 * (実測: 無作為 20 社で資本金・従業員数とも 0 件)。
 * 入っているのは、国の調達資格・補助金・届出・特許に関わった法人である。
 * そのため「全件を舐める」使い方はせず、必ず範囲を絞る。
 */
export async function enrichFromGbiz(
  db: Db,
  client: GbizClient,
  options: EnrichOptions = {},
): Promise<EnrichResult> {
  const limit = options.limit ?? 100;
  const result: EnrichResult = {
    queried: 0, responded: 0,
    filled: { capital: 0, employees: 0, url: 0, summary: 0, founded: 0 },
    empty: 0, errors: 0,
  };

  const targets = searchCompanies(db, options.scope ?? {}, { limit }).map((r) => r.corporate_number);
  if (targets.length === 0) return result;

  const runId = startRun(db, { source: SOURCE, target: `enrich:${targets.length}` });
  const upsert = db.prepare(UPSERT);
  const now = new Date().toISOString();

  try {
    for (const n of targets) {
      result.queried++;
      const r = await client.detail(n);
      if (r.error) {
        result.errors++;
        continue;
      }
      if (!r.value) {
        result.empty++;
        continue;
      }
      result.responded++;

      const p = toProfile(r.value);
      if (p.capital !== null) result.filled.capital++;
      if (p.employees !== null) result.filled.employees++;
      if (p.url !== null) result.filled.url++;
      if (p.founded !== null) result.filled.founded++;
      if (r.value.business_summary) result.filled.summary++;

      if (p.capital === null && p.employees === null && p.url === null && p.founded === null) {
        result.empty++;
        continue;
      }
      upsert.run({
        n, capital: p.capital, employees: p.employees, source: SOURCE,
        url: p.url, conf: p.url ? 1.0 : null, founded: p.founded, at: now,
      });
      options.onProgress?.(result.queried, result.filled.capital + result.filled.employees);
    }
    finishRun(db, runId, { rowsRead: result.queried, rowsUpserted: result.responded, status: 'ok' });
  } catch (err) {
    finishRun(db, runId, {
      rowsRead: result.queried, rowsUpserted: result.responded, status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  invalidateMeta(db);
  loadMeta(db);
  return result;
}

export interface SearchImportResult {
  found: number;
  /** 手元のマスタにあった数 */
  inMaster: number;
  imported: number;
  pages: number;
}

/**
 * gBizINFO 側に条件を投げ、返ってきた法人を手元に取り込む。
 *
 * 「売上 50〜70 億の建設会社」のような、手元に無い項目での絞り込みはこちら。
 * 手元の 500 万件を舐めるより、条件に合う先だけを受け取る方が速く、安い。
 */
export async function importFromSearch(
  db: Db,
  client: GbizClient,
  params: GbizSearch,
  options: { maxPages?: number; onProgress?: (page: number, found: number) => void } = {},
): Promise<SearchImportResult> {
  const maxPages = options.maxPages ?? 5;
  const result: SearchImportResult = { found: 0, inMaster: 0, imported: 0, pages: 0 };

  const runId = startRun(db, { source: SOURCE, target: `search:${JSON.stringify(params)}`.slice(0, 120) });
  const upsert = db.prepare(UPSERT);
  const exists = db.prepare('SELECT 1 FROM corporations WHERE corporate_number = ?');
  const now = new Date().toISOString();

  try {
    for (let page = 1; page <= maxPages; page++) {
      const r = await client.search({ ...params, page, limit: params.limit ?? 100 });
      if (r.error || !r.value) break;
      if (r.value.length === 0) break;

      result.pages++;
      for (const h of r.value) {
        result.found++;
        const n = h.corporate_number;
        if (!n) continue;
        // 手元のマスタに無い法人は取り込まない (国税庁のデータが唯一の正)
        if (!exists.get(n)) continue;
        result.inMaster++;

        // 検索の応答は概要だけで、資本金や従業員数は入っていない。
        // 条件に合致した先だけを対象に、あらためて詳細を照会する
        // (これを怠ると「22 件見つかったが 0 件取り込み」になる。実際になった)。
        const d = await client.detail(n);
        const p = toProfile(d.value ?? h);
        if (p.capital === null && p.employees === null && p.url === null && p.founded === null) continue;
        upsert.run({
          n, capital: p.capital, employees: p.employees, source: SOURCE,
          url: p.url, conf: p.url ? 1.0 : null, founded: p.founded, at: now,
        });
        result.imported++;
      }
      options.onProgress?.(page, result.found);
    }
    finishRun(db, runId, { rowsRead: result.found, rowsUpserted: result.imported, status: 'ok' });
  } catch (err) {
    finishRun(db, runId, {
      rowsRead: result.found, rowsUpserted: result.imported, status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  if (result.imported > 0) {
    invalidateMeta(db);
    loadMeta(db);
  }
  return result;
}
