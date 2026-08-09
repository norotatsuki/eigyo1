/**
 * 収集済みのサイト本文を LLM に読ませ、足りない情報を埋める。
 *
 * サイトを訪ね直さない。本文は収集のときに取ってあるので、
 * 手元の文章を読ませるだけで足りる。相手に負担をかけない。
 *
 * 埋めるのは 2 つ。
 *   抽出 … 会社名・住所・電話・メール (原文との照合を通したものだけ)
 *   分類 … 業種 (日本標準産業分類の一覧にあるコードだけ)
 */
import type { Db } from '../../db/index.ts';
import { invalidateMeta, loadMeta } from '../../search/meta.ts';
import { searchCompanies, type SearchFilter } from '../../search/query.ts';
import { matchCorporation } from '../site/crawl.ts';
import { classifyWithLlm, extractWithLlm } from './extract.ts';
import { emptyUsage, estimateCost, type Llm, type Pricing, type Usage } from './client.ts';

/** LLM 由来であることを残す。あとで出典で選別できるようにする。 */
export const SOURCE_LLM_EXTRACT = 'llm_extract';
export const SOURCE_LLM_CLASSIFY = 'llm_classify';

export interface EnrichOptions {
  limit?: number;
  /**
   * 補完する範囲を絞る条件。
   *
   * 全 34.8 万件にかける必要はまず無い。実際に要るのは、これから接触する
   * 絞り込みの範囲だけである。東京都の情報サービス業 1 万社なら、
   * 全件にかけるより 30 分の 1 で済む。
   */
  scope?: SearchFilter;
  /** 業種の分類もかける */
  classify?: boolean;
  /** 抽出もかける */
  extract?: boolean;
  /** これ未満の確信度の業種は保存しない */
  minConfidence?: number;
  pricing?: Pricing;
  onProgress?: (done: number, improved: number, cost: number) => void;
}

export interface EnrichResult {
  scanned: number;
  /** 抽出で新しく埋まった項目の数 */
  filled: { name: number; address: number; tel: number; email: number };
  /** 原文に無かったため捨てた数 */
  rejected: number;
  /** 新たに法人番号に紐付いた数 */
  newlyMatched: number;
  /** 業種を入れた数 */
  classified: number;
  usage: Usage;
  estimatedCost: number;
  errors: number;
}

const addUsage = (a: Usage, b: Usage): Usage => ({
  promptTokens: a.promptTokens + b.promptTokens,
  completionTokens: a.completionTokens + b.completionTokens,
  calls: a.calls + b.calls,
});

/**
 * 取りこぼしを埋める。
 *
 * 対象は「収集はできたが、会社名か住所が取れていない」先。
 * 正規表現で取れているものに LLM を使っても費用が増えるだけなので、
 * 足りない先だけを選ぶ。
 */
export async function enrichWithLlm(
  db: Db,
  llm: Llm,
  options: EnrichOptions = {},
): Promise<EnrichResult> {
  const limit = options.limit ?? 50;
  const doExtract = options.extract ?? true;
  const doClassify = options.classify ?? false;
  const minConfidence = options.minConfidence ?? 0.6;
  const pricing = options.pricing ?? { inputPerMillion: 0.15, outputPerMillion: 0.6, currency: 'USD' };

  const result: EnrichResult = {
    scanned: 0,
    filled: { name: 0, address: 0, tel: 0, email: 0 },
    rejected: 0, newlyMatched: 0, classified: 0,
    usage: emptyUsage(), estimatedCost: 0, errors: 0,
  };

  // 本文を保存していないので、対象は「収集できたが情報が欠けている」先。
  // 本文は site_name / site_address 等に散っているものを繋いで使う
  // 範囲が指定されていれば、その条件に合う法人に紐付いた先だけを対象にする
  let scopeClause = '';
  const scopeParams: unknown[] = [];
  if (options.scope) {
    const inScope = searchCompanies(db, options.scope, { limit: 100_000 }).map((r) => r.corporate_number);
    if (inScope.length === 0) return result;
    scopeClause = `AND corporate_number IN (${inScope.map(() => '?').join(', ')})`;
    scopeParams.push(...inScope);
  }

  const rows = db
    .prepare(
      `SELECT host, site_name, site_address, site_tel, site_email, site_text,
              corporate_number AS corp
         FROM web_hosts
        WHERE crawl_status = 'ok'
          AND site_text IS NOT NULL
          AND (site_name IS NULL OR site_address IS NULL OR corporate_number IS NULL)
          ${scopeClause}
        ORDER BY host LIMIT ?`,
    )
    .all(...scopeParams, limit) as Array<{
    host: string; site_name: string | null; site_address: string | null;
    site_tel: string | null; site_email: string | null; site_text: string; corp: string | null;
  }>;

  const updateHost = db.prepare(
    `UPDATE web_hosts SET site_name = ?, site_address = ?, site_tel = ?, site_email = ?,
       corporate_number = ?, match_confidence = ?, match_method = ? WHERE host = ?`,
  );
  const upsertProfile = db.prepare(
    `INSERT INTO company_profiles
       (corporate_number, website_url, website_confidence, website_checked_at,
        contact_email, contact_tel, updated_at)
     VALUES (@n, @url, @conf, @at, @email, @tel, @at)
     ON CONFLICT(corporate_number) DO UPDATE SET
       website_url = COALESCE(company_profiles.website_url, excluded.website_url),
       contact_email = COALESCE(excluded.contact_email, company_profiles.contact_email),
       contact_tel = COALESCE(excluded.contact_tel, company_profiles.contact_tel),
       updated_at = excluded.updated_at`,
  );
  const upsertIndustry = db.prepare(
    `INSERT INTO company_profiles
       (corporate_number, industry_code, industry_name, industry_source, industry_confidence, updated_at)
     VALUES (@n, @code, @name, @source, @conf, @at)
     ON CONFLICT(corporate_number) DO UPDATE SET
       industry_code = excluded.industry_code,
       industry_name = excluded.industry_name,
       industry_source = excluded.industry_source,
       industry_confidence = excluded.industry_confidence,
       updated_at = excluded.updated_at
     WHERE company_profiles.industry_source IS NULL
        OR company_profiles.industry_source NOT IN ('gbizinfo', 'manual')`,
  );

  for (const row of rows) {
    result.scanned++;
    const now = new Date().toISOString();
    let name = row.site_name;
    let address = row.site_address;
    let tel = row.site_tel;
    let email = row.site_email;

    if (doExtract) {
      const r = await extractWithLlm(llm, row.site_text);
      result.usage = addUsage(result.usage, r.usage);
      result.rejected += r.rejected.length;
      if (r.error) result.errors++;

      if (!name && r.extracted.name) { name = r.extracted.name; result.filled.name++; }
      if (!address && r.extracted.address) { address = r.extracted.address; result.filled.address++; }
      if (!tel && r.extracted.tel) { tel = r.extracted.tel; result.filled.tel++; }
      if (!email && r.extracted.email) { email = r.extracted.email; result.filled.email++; }
    }

    // 情報が増えたので、もう一度突き合わせる
    const match = matchCorporation(db, { name, address, tel, email, contactUrl: null, refusedText: null });
    if (match && !row.corp) result.newlyMatched++;

    updateHost.run(
      name, address, tel, email,
      match?.corporateNumber ?? row.corp,
      match?.confidence ?? null, match?.method ?? null,
      row.host,
    );

    const corp = match?.corporateNumber ?? row.corp;
    if (corp) {
      upsertProfile.run({
        n: corp, url: `https://${row.host}`, conf: match?.confidence ?? null,
        at: now, email, tel,
      });

      if (doClassify && name) {
        const c = await classifyWithLlm(llm, name, row.site_text);
        result.usage = addUsage(result.usage, c.usage);
        if (c.error) result.errors++;
        if (c.code && c.confidence >= minConfidence) {
          upsertIndustry.run({
            n: corp, code: c.code, name: c.name,
            source: SOURCE_LLM_CLASSIFY, conf: c.confidence, at: now,
          });
          result.classified++;
        }
      }
    }

    result.estimatedCost = estimateCost(result.usage, pricing);
    options.onProgress?.(result.scanned, result.newlyMatched, result.estimatedCost);
  }

  if (result.newlyMatched > 0 || result.classified > 0) {
    invalidateMeta(db);
    loadMeta(db);
  }
  return result;
}
