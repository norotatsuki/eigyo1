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
  /** 業種の確信度の下限。商号からの推定は幅があるため、実際の営業では 0.7 以上を薦める */
  industryMinConfidence?: number;
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
  /** FROM から結合までの一式 */
  from: string;
  sql: string;
  params: unknown[];
}

/** 全文検索を使わない場合の読み取り元。 */
const FROM_PLAIN = `
  FROM corporations c
  LEFT JOIN company_profiles p ON p.corporate_number = c.corporate_number`;

/** 付加情報を一切使わない場合。500 万行に結合を張らずに済む。 */
const FROM_CORP_ONLY = `FROM corporations c`;

/**
 * 全文検索を使う場合の読み取り元。
 *
 * CROSS JOIN で結合順を固定しているのは、SQLite の見積もりが外れるため。
 * 業種や法人種別の条件があると corporations を駆動側に選び、250 万行それぞれに
 * 全文照合をかける計画を立ててしまう (実測: 1 件の検索に 64 秒〜返らず)。
 * CROSS JOIN は SQLite に「この順で回せ」と伝える唯一の手段で、
 * 同じ検索が 0-1ms に戻る。並べ替えても意味は変わらない。
 */
const FROM_FTS = `
  FROM corporations_fts f
  CROSS JOIN corporations c ON c.id = f.rowid
  LEFT JOIN company_profiles p ON p.corporate_number = c.corporate_number`;

/** 全文検索を使い、付加情報は使わない場合。 */
const FROM_FTS_CORP_ONLY = `
  FROM corporations_fts f
  CROSS JOIN corporations c ON c.id = f.rowid`;

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

/** 付加情報の列を条件に使っているか。使っていなければ結合を省ける。 */
function usesProfile(filter: SearchFilter): boolean {
  return Boolean(
    filter.industryCodes?.length ||
      filter.industryMinConfidence !== undefined ||
      filter.capitalMin !== undefined ||
      filter.capitalMax !== undefined ||
      filter.employeesMin !== undefined ||
      filter.employeesMax !== undefined ||
      filter.hasWebsite ||
      filter.hasContactForm,
  );
}

/**
 * @param forCount 件数だけを数える場合。付加情報の列を表示しないぶん結合を省ける
 */
function buildWhere(filter: SearchFilter, forCount = false): BuiltWhere {
  const clauses: string[] = [];
  const params: unknown[] = [];
  // 件数を数えるだけで付加情報を条件にも使っていないなら、結合そのものを省く
  const joinProfile = !forCount || usesProfile(filter);
  let from = joinProfile ? FROM_PLAIN : FROM_CORP_ONLY;

  // 索引は正規化済みの商号に張ってあるため、検索語にも同じ正規化をかける。
  // これが無いと半角「AI」で「ＡＩシステム開発」に当たらない。
  //
  // 全文検索の条件は必ず先頭に置く。FROM_FTS では MATCH が SQL 文の先頭側に来るため、
  // 引数の並びもそれに合わせる必要がある。
  const keyword = filter.keyword?.normalize('NFKC').trim();
  if (keyword) {
    if (keyword.length >= 3) {
      from = joinProfile ? FROM_FTS : FROM_FTS_CORP_ONLY;
      clauses.push('corporations_fts MATCH ?');
      params.push(`"${keyword.replace(/"/g, '""')}"`);
    } else {
      // trigram は 3 文字未満を扱えないため、正規化名で素直に照合する
      clauses.push('c.name_normalized LIKE ?');
      params.push(`%${keyword}%`);
    }
  }

  const activeOnly = filter.activeOnly ?? true;
  const excludeRefused = filter.excludeRefused ?? true;

  if (activeOnly) clauses.push('c.is_active = 1');

  if (excludeRefused) {
    // プロフィール未取得 (NULL) は「お断りが確認されていない」= 対象に残す
    //
    // 結合を張っていない場合は NOT EXISTS で照会する。お断りの行はごく少数で
    // 索引が効くため、500 万行それぞれに結合するより桁違いに速い
    // (実測: 全件の件数取得が 16.5 秒 → 1 秒未満)。
    clauses.push(
      joinProfile
        ? 'COALESCE(p.solicitation_refused, 0) = 0'
        : `NOT EXISTS (SELECT 1 FROM company_profiles pr
                        WHERE pr.corporate_number = c.corporate_number
                          AND pr.solicitation_refused = 1)`,
    );
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

  if (filter.industryMinConfidence !== undefined) {
    clauses.push('p.industry_confidence >= ?');
    params.push(filter.industryMinConfidence);
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
    from,
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

/** 組み立てた読み取り文。実行計画の確認にも使う。 */
export function buildSelectSql(
  filter: SearchFilter,
  options: SearchOptions = {},
  columns: string = SELECT_COLUMNS,
): { sql: string; params: unknown[] } {
  const where = buildWhere(filter);
  return {
    sql: `SELECT ${columns} ${where.from} ${where.sql} ${orderClause(options.orderBy)}`,
    params: where.params,
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

/** 付加情報を使わない読み取り元に、付加情報の結合を足した形を返す。 */
function withProfileJoin(from: string): string {
  if (from === FROM_CORP_ONLY) return FROM_PLAIN;
  if (from === FROM_FTS_CORP_ONLY) return FROM_FTS;
  return from;
}

/**
 * 条件に一致する件数を数える。リストを出す前の当たりをつけるのに使う。
 *
 * お断りの除外だけが付加情報を必要とする場合、「全体 − お断り」の引き算で求める。
 * 500 万行それぞれに問い合わせると 7.2 秒かかるのに対し、引き算なら 0.6 秒で済む
 * (お断りの行はごく少数で、そちら側の集計が一瞬で終わるため)。
 */
export function countCompanies(db: Db, filter: SearchFilter): number {
  const excludeRefused = filter.excludeRefused ?? true;
  const canSubtract = excludeRefused && !usesProfile(filter);

  if (!canSubtract) {
    const where = buildWhere(filter, true);
    const row = db.prepare(`SELECT COUNT(*) AS n ${where.from} ${where.sql}`).get(...where.params) as {
      n: number;
    };
    return row.n;
  }

  const base = buildWhere({ ...filter, excludeRefused: false }, true);
  const refusedFrom = withProfileJoin(base.from);
  const refusedWhere = base.sql
    ? `${base.sql} AND p.solicitation_refused = 1`
    : 'WHERE p.solicitation_refused = 1';
  const sql = `
    SELECT (SELECT COUNT(*) ${base.from} ${base.sql})
         - (SELECT COUNT(*) ${refusedFrom} ${refusedWhere}) AS n`;
  const row = db.prepare(sql).get(...base.params, ...base.params) as { n: number };
  return row.n;
}

/** 条件に一致する法人を返す。 */
export function searchCompanies(
  db: Db,
  filter: SearchFilter,
  options: SearchOptions = {},
): CompanyRow[] {
  const built = buildSelectSql(filter, options);
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;
  return db.prepare(`${built.sql} LIMIT ? OFFSET ?`).all(...built.params, limit, offset) as CompanyRow[];
}

/** 条件に一致する法人を、件数上限なしで順に返す。書き出し用。 */
export function* streamCompanies(
  db: Db,
  filter: SearchFilter,
  options: SearchOptions = {},
): Generator<CompanyRow, void, void> {
  const built = buildSelectSql(filter, options);
  yield* db.prepare(built.sql).iterate(...built.params) as IterableIterator<CompanyRow>;
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
