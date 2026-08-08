/**
 * 絞り込み検索。
 *
 * 「全企業を持っておき、狙いたいときに条件で切り出す」という使い方に合わせ、
 * 条件は積み上げ式にする。指定しなかった条件は絞り込みに使わない。
 *
 * 既定で 2 つの安全側の絞り込みが入る。外すには明示的に false を渡す。
 *   activeOnly     … 閉鎖・除外・過去履歴を落とす
 *   excludeRefused … 営業お断りを検出した先を落とす
 */
import type { Db } from '../db/index.ts';

export interface SearchFilter {
  /** 商号の部分一致。3 文字以上は全文検索、2 文字以下は前方後方一致で照合する */
  keyword?: string;
  /** 都道府県コード ('13' = 東京都) */
  prefCodes?: string[];
  /** 市区町村コード。prefCodes と併用する */
  cityCodes?: string[];
  /** 法人種別 (301 株式会社 / 302 有限会社 / 305 合同会社 / 399 その他の設立登記法人 …) */
  kinds?: number[];
  /** 法人格 ('株式会社' など) */
  corpForms?: string[];
  /** 日本標準産業分類。前方一致で照合するため大分類・中分類でも指定できる */
  industryCodes?: string[];
  capitalMin?: number;
  capitalMax?: number;
  employeesMin?: number;
  employeesMax?: number;
  /** 法人番号指定年月日の範囲。設立時期のおおよその代理として使う */
  assignedFrom?: string;
  assignedTo?: string;
  /** サイトが判明している先だけに絞る */
  hasWebsite?: boolean;
  /** 問い合わせフォームが判明している先だけに絞る */
  hasContactForm?: boolean;
  activeOnly?: boolean;
  excludeRefused?: boolean;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  orderBy?: 'name' | 'assigned_desc' | 'capital_desc' | 'employees_desc';
}

export interface CompanyRow {
  corporate_number: string;
  name: string;
  corp_form: string | null;
  pref_name: string;
  city_name: string;
  address_full: string;
  post_code: string;
  kind: number | null;
  assignment_date: string | null;
  industry_code: string | null;
  industry_name: string | null;
  capital: number | null;
  employees: number | null;
  website_url: string | null;
  contact_form_url: string | null;
  contact_email: string | null;
}

const SELECT_COLUMNS = `
  c.corporate_number, c.name, c.corp_form, c.pref_name, c.city_name,
  c.address_full, c.post_code, c.kind, c.assignment_date,
  p.industry_code, p.industry_name, p.capital, p.employees,
  p.website_url, p.contact_form_url, p.contact_email
`;

interface BuiltWhere {
  sql: string;
  params: unknown[];
  /** 全文検索を使う場合の結合句 */
  join: string;
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

function buildWhere(filter: SearchFilter): BuiltWhere {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let join = '';

  const activeOnly = filter.activeOnly ?? true;
  const excludeRefused = filter.excludeRefused ?? true;

  if (activeOnly) clauses.push('c.is_active = 1');

  if (excludeRefused) {
    // プロフィール未取得 (NULL) は「お断りが確認されていない」= 対象に残す
    clauses.push('COALESCE(p.solicitation_refused, 0) = 0');
  }

  // 索引は正規化済みの商号に張ってあるため、検索語にも同じ正規化をかける。
  // これが無いと半角「AI」で「ＡＩシステム開発」に当たらない。
  const keyword = filter.keyword?.normalize('NFKC').trim();
  if (keyword) {
    if (keyword.length >= 3) {
      // trigram 索引による部分一致
      join = 'JOIN corporations_fts f ON f.rowid = c.id';
      clauses.push('corporations_fts MATCH ?');
      params.push(`"${keyword.replace(/"/g, '""')}"`);
    } else {
      // trigram は 3 文字未満を扱えないため、正規化名で素直に照合する
      clauses.push('c.name_normalized LIKE ?');
      params.push(`%${keyword}%`);
    }
  }

  if (filter.prefCodes?.length) {
    clauses.push(`c.pref_code IN (${placeholders(filter.prefCodes.length)})`);
    params.push(...filter.prefCodes);
  }
  if (filter.cityCodes?.length) {
    clauses.push(`c.city_code IN (${placeholders(filter.cityCodes.length)})`);
    params.push(...filter.cityCodes);
  }
  if (filter.kinds?.length) {
    clauses.push(`c.kind IN (${placeholders(filter.kinds.length)})`);
    params.push(...filter.kinds);
  }
  if (filter.corpForms?.length) {
    clauses.push(`c.corp_form IN (${placeholders(filter.corpForms.length)})`);
    params.push(...filter.corpForms);
  }

  if (filter.industryCodes?.length) {
    // 大分類・中分類での指定を許すため前方一致
    const ors = filter.industryCodes.map(() => 'p.industry_code LIKE ?').join(' OR ');
    clauses.push(`(${ors})`);
    params.push(...filter.industryCodes.map((c) => `${c}%`));
  }

  if (filter.capitalMin !== undefined) {
    clauses.push('p.capital >= ?');
    params.push(filter.capitalMin);
  }
  if (filter.capitalMax !== undefined) {
    clauses.push('p.capital <= ?');
    params.push(filter.capitalMax);
  }
  if (filter.employeesMin !== undefined) {
    clauses.push('p.employees >= ?');
    params.push(filter.employeesMin);
  }
  if (filter.employeesMax !== undefined) {
    clauses.push('p.employees <= ?');
    params.push(filter.employeesMax);
  }
  if (filter.assignedFrom) {
    clauses.push('c.assignment_date >= ?');
    params.push(filter.assignedFrom);
  }
  if (filter.assignedTo) {
    clauses.push('c.assignment_date <= ?');
    params.push(filter.assignedTo);
  }
  if (filter.hasWebsite) clauses.push("p.website_url IS NOT NULL AND p.website_url <> ''");
  if (filter.hasContactForm) clauses.push("p.contact_form_url IS NOT NULL AND p.contact_form_url <> ''");

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
    join,
  };
}

function orderClause(orderBy: SearchOptions['orderBy']): string {
  switch (orderBy) {
    case 'assigned_desc':
      return 'ORDER BY c.assignment_date DESC';
    case 'capital_desc':
      return 'ORDER BY p.capital DESC NULLS LAST';
    case 'employees_desc':
      return 'ORDER BY p.employees DESC NULLS LAST';
    case 'name':
    default:
      return 'ORDER BY c.name_core';
  }
}

/** 条件に一致する件数を数える。リストを出す前の当たりをつけるのに使う。 */
export function countCompanies(db: Db, filter: SearchFilter): number {
  const where = buildWhere(filter);
  const sql = `
    SELECT COUNT(*) AS n
      FROM corporations c
      LEFT JOIN company_profiles p ON p.corporate_number = c.corporate_number
      ${where.join}
      ${where.sql}`;
  const row = db.prepare(sql).get(...where.params) as { n: number };
  return row.n;
}

/** 条件に一致する法人を返す。 */
export function searchCompanies(
  db: Db,
  filter: SearchFilter,
  options: SearchOptions = {},
): CompanyRow[] {
  const where = buildWhere(filter);
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;
  const sql = `
    SELECT ${SELECT_COLUMNS}
      FROM corporations c
      LEFT JOIN company_profiles p ON p.corporate_number = c.corporate_number
      ${where.join}
      ${where.sql}
      ${orderClause(options.orderBy)}
      LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...where.params, limit, offset) as CompanyRow[];
}

/** 条件に一致する法人を、件数上限なしで順に返す。書き出し用。 */
export function* streamCompanies(
  db: Db,
  filter: SearchFilter,
  options: SearchOptions = {},
): Generator<CompanyRow, void, void> {
  const where = buildWhere(filter);
  const sql = `
    SELECT ${SELECT_COLUMNS}
      FROM corporations c
      LEFT JOIN company_profiles p ON p.corporate_number = c.corporate_number
      ${where.join}
      ${where.sql}
      ${orderClause(options.orderBy)}`;
  yield* db.prepare(sql).iterate(...where.params) as IterableIterator<CompanyRow>;
}

const EXPORT_HEADER = [
  '法人番号', '商号', '法人格', '都道府県', '市区町村', '所在地', '郵便番号',
  '法人種別', '法人番号指定年月日', '業種コード', '業種', '資本金', '従業員数',
  'サイト', '問い合わせフォーム', 'メール',
];

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 表計算ソフトで開ける形に整えて 1 行ずつ返す。 */
export function* toCsvLines(rows: Iterable<CompanyRow>): Generator<string, void, void> {
  yield EXPORT_HEADER.join(',');
  for (const r of rows) {
    yield [
      r.corporate_number, r.name, r.corp_form, r.pref_name, r.city_name,
      r.address_full, r.post_code, r.kind, r.assignment_date,
      r.industry_code, r.industry_name, r.capital, r.employees,
      r.website_url, r.contact_form_url, r.contact_email,
    ].map(csvEscape).join(',');
  }
}
