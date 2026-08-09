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
  /** 売上高(円)。会社概要に載っていた分だけが対象 */
  revenueMin?: number;
  revenueMax?: number;
  /** 法人番号指定年月日の範囲。設立時期のおおよその代理として使う */
  assignedFrom?: string;
  assignedTo?: string;
  /** サイトが判明している先だけに絞る */
  hasWebsite?: boolean;
  /** 問い合わせフォームが判明している先だけに絞る */
  hasContactForm?: boolean;
  /** 公開メールが判明している先だけに絞る */
  hasEmail?: boolean;
  /**
   * 送れる先だけに絞る (メール **または** フォーム)。
   *
   * 宛先は経路ごとに要る。メールを全体の必須にすると、フォームでは
   * 送れる先まで捨ててしまう (実測: 収集できたサイトの 70% が
   * 「メール無し・フォーム有」だった)。
   */
  reachable?: boolean;
  /** 代表者名が判明している先だけに絞る */
  hasRepresentative?: boolean;
  /** 採用しているところだけ。動いている印であり、募集職種は当てる部署の手がかり */
  hiring?: boolean;
  /** 募集職種で絞る (施工管理 / 情報システム / 営業 …) */
  hiringRoles?: string[];
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
  revenue: number | null;
  website_url: string | null;
  contact_form_url: string | null;
  contact_email: string | null;
  contact_tel: string | null;
  hiring: number | null;
  hiring_roles: string | null;
  representative: string | null;
  business_evidence: string | null;
  /** SNS のリンク (JSON 文字列)。会社のものと代表者のものを分けて持つ */
  social_links: string | null;
  /** 項目ごとの取得元 URL (JSON 文字列)。後から検証するため */
  field_sources: string | null;
}

const SELECT_COLUMNS = `
  c.corporate_number, c.name, c.corp_form, c.pref_name, c.city_name,
  c.address_full, c.post_code, c.kind, c.assignment_date,
  p.industry_code, p.industry_name, p.capital, p.employees, p.revenue,
  p.website_url, p.contact_form_url, p.contact_email, p.contact_tel, p.hiring, p.hiring_roles,
  p.representative, p.business_evidence, p.field_sources, p.social_links
`;

interface BuiltWhere {
  /** FROM から結合までの一式 */
  from: string;
  sql: string;
  params: unknown[];
}

/** 全文検索を使わない場合の読み取り元。 */
const fromPlain = (hint = ''): string => `
  FROM corporations c${hint}
  LEFT JOIN company_profiles p ON p.corporate_number = c.corporate_number`;

/** 付加情報を一切使わない場合。500 万行に結合を張らずに済む。 */
const fromCorpOnly = (hint = ''): string => `FROM corporations c${hint}`;

/**
 * 接触してはいけない先。2 つの出どころがある。
 *   suppressions … 手で積んだ除外 (受信拒否・取引先・競合など)
 *   company_profiles.solicitation_refused … サイトで営業お断りを検出したもの
 * どちらも「送らない」なので、検索の既定でも外す。
 */
const BLOCKED_EXISTS = `
  EXISTS (SELECT 1 FROM suppressions s WHERE s.corporate_number = c.corporate_number)
  OR EXISTS (SELECT 1 FROM company_profiles pr
              WHERE pr.corporate_number = c.corporate_number AND pr.solicitation_refused = 1)`;

/** 接触してはいけない先の一覧。件数の引き算で使う (小さいので毎回作って構わない)。 */
const BLOCKED_SET = `
  SELECT corporate_number FROM suppressions
  UNION
  SELECT corporate_number FROM company_profiles WHERE solicitation_refused = 1`;

const FROM_PLAIN = fromPlain();
const FROM_CORP_ONLY = fromCorpOnly();

/**
 * 一覧を出すときに使う索引を明示する。
 *
 * 索引を足すたびに最適化器の選択が揺れ、同じ条件が 0 秒になったり 2.9 秒に
 * なったりした。一覧は画面が最初に描くものなので、ここだけは選択を固定する。
 * どちらの索引も末尾が name_core なので、商号順に読んで 50 件で打ち切れる。
 *
 * ただし業種などの付加情報で絞るときは指定しない。付加情報の側が
 * ずっと選択的で (東京都の 1% しか残らないなど)、法人を商号順になぞると
 * 50 件そろうまでに数千行を見ることになる。そこは最適化器に任せた方が速い。
 */
function listIndexHint(filter: SearchFilter, options: SearchOptions): string {
  const orderBy = options.orderBy ?? 'name';
  if (orderBy !== 'name') return '';
  if (filter.activeOnly === false) return '';
  if (usesProfile(filter)) return ''; // 付加情報側から回した方が速い
  if ((filter.keyword?.normalize('NFKC').trim().length ?? 0) >= 3) return ''; // 全文検索が駆動側
  if (filter.prefCodes?.length === 1) return ' INDEXED BY idx_corp_active_pref_name';
  return ' INDEXED BY idx_corp_active_name';
}

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

/**
 * 前方一致を範囲に置き換えるための上限値。
 * 末尾の 1 文字を次の文字に進める ('39' → '3:')。
 */
export function prefixUpperBound(prefix: string): string {
  if (prefix === '') return '￿';
  const head = prefix.slice(0, -1);
  const last = prefix.charCodeAt(prefix.length - 1);
  return head + String.fromCharCode(last + 1);
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
      filter.revenueMin !== undefined ||
      filter.revenueMax !== undefined ||
      filter.hasWebsite ||
      filter.hasContactForm ||
      filter.hasEmail ||
      filter.reachable ||
      filter.hasRepresentative ||
      filter.hiring ||
      filter.hiringRoles?.length,
  );
}

/**
 * @param forCount 件数だけを数える場合。付加情報の列を表示しないぶん結合を省ける
 */
function buildWhere(filter: SearchFilter, forCount = false, indexHint = ''): BuiltWhere {
  const clauses: string[] = [];
  const params: unknown[] = [];
  // 件数を数えるだけで付加情報を条件にも使っていないなら、結合そのものを省く
  const joinProfile = !forCount || usesProfile(filter);
  let from = joinProfile ? fromPlain(indexHint) : fromCorpOnly(indexHint);

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
    // 一覧は LIMIT で打ち切るので、見た行だけ照会すれば済む。
    // 件数の方は 500 万行すべてを見ることになるため、別に引き算で求める
    // (countCompanies を参照)。
    clauses.push(`NOT (${BLOCKED_EXISTS})`);
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
    // 大分類・中分類での指定を許すため前方一致にするが、LIKE は索引を使えない。
    // 「39 で始まる」を「'39' 以上 '3:' 未満」の範囲に書き換えると索引が効く
    // (実測 6.2 秒 → 0.05 秒)。
    const ors = filter.industryCodes
      .map(() => '(p.industry_code >= ? AND p.industry_code < ?)')
      .join(' OR ');
    clauses.push(`(${ors})`);
    for (const code of filter.industryCodes) {
      params.push(code, prefixUpperBound(code));
    }
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
  if (filter.revenueMin !== undefined) {
    clauses.push('p.revenue >= ?');
    params.push(filter.revenueMin);
  }
  if (filter.revenueMax !== undefined) {
    clauses.push('p.revenue <= ?');
    params.push(filter.revenueMax);
  }
  if (filter.assignedFrom) {
    clauses.push('c.assignment_date >= ?');
    params.push(filter.assignedFrom);
  }
  if (filter.assignedTo) {
    clauses.push('c.assignment_date <= ?');
    params.push(filter.assignedTo);
  }
  if (filter.hiring) clauses.push('p.hiring = 1');
  if (filter.hiringRoles?.length) {
    const ors = filter.hiringRoles.map(() => 'p.hiring_roles LIKE ?').join(' OR ');
    clauses.push(`(${ors})`);
    params.push(...filter.hiringRoles.map((r) => `%${r}%`));
  }
  if (filter.hasWebsite) clauses.push("p.website_url IS NOT NULL AND p.website_url <> ''");
  if (filter.hasContactForm) clauses.push("p.contact_form_url IS NOT NULL AND p.contact_form_url <> ''");
  if (filter.hasEmail) clauses.push("p.contact_email IS NOT NULL AND p.contact_email <> ''");
  if (filter.reachable) {
    clauses.push(
      "((p.contact_email IS NOT NULL AND p.contact_email <> '')" +
      " OR (p.contact_form_url IS NOT NULL AND p.contact_form_url <> ''))",
    );
  }
  if (filter.hasRepresentative) clauses.push("p.representative IS NOT NULL AND p.representative <> ''");

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
  const where = buildWhere(filter, false, listIndexHint(filter, options));
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

/**
 * 接触禁止の件数を数えるための読み取り元。
 *
 * 禁止された側から回すよう CROSS JOIN で固定する。禁止の行はごく少数なのに対し、
 * 法人の側から回すと 115 万行それぞれに結合を張ることになる
 * (実測 4.1 秒 → 0.04 秒)。
 */
function blockedFrom(from: string): string {
  if (from === FROM_FTS || from === FROM_FTS_CORP_ONLY) {
    return `
      FROM corporations_fts f
      CROSS JOIN corporations c ON c.id = f.rowid
      JOIN (${BLOCKED_SET}) b ON b.corporate_number = c.corporate_number
      LEFT JOIN company_profiles p ON p.corporate_number = c.corporate_number`;
  }
  return `
    FROM (${BLOCKED_SET}) b
    CROSS JOIN corporations c ON c.corporate_number = b.corporate_number
    LEFT JOIN company_profiles p ON p.corporate_number = c.corporate_number`;
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
  const sql = `
    SELECT (SELECT COUNT(*) ${base.from} ${base.sql})
         - (SELECT COUNT(*) ${blockedFrom(base.from)} ${base.sql}) AS n`;
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
  '法人種別', '法人番号指定年月日', '業種コード', '業種', '資本金', '従業員数', '売上高',
  'サイト', '問い合わせフォーム', 'メール', '採用中', '募集職種',
];

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const LABEL_HEADER = ['郵便番号', '住所', '会社名', '宛名', '法人番号'];

/**
 * 差込印刷用の宛名を書き出す。
 *
 * サイトもメールも分かっていない今、実際に接触できる唯一の経路が郵送。
 * 郵便番号と所在地は国税庁の全件データに必ず入っているため、
 * 500 万社すべてに宛名を作れる。
 *
 * @param honorific 宛名の敬称。部署が分かっていないので既定は「御中」
 */
export function* toLabelCsvLines(
  rows: Iterable<CompanyRow>,
  honorific = '御中',
): Generator<string, void, void> {
  yield LABEL_HEADER.join(',');
  for (const r of rows) {
    const postal = r.post_code ? `${r.post_code.slice(0, 3)}-${r.post_code.slice(3)}` : '';
    yield [postal, r.address_full, r.name, `${r.name} ${honorific}`, r.corporate_number]
      .map(csvEscape)
      .join(',');
  }
}

/** 表計算ソフトで開ける形に整えて 1 行ずつ返す。 */
export function* toCsvLines(rows: Iterable<CompanyRow>): Generator<string, void, void> {
  yield EXPORT_HEADER.join(',');
  for (const r of rows) {
    yield [
      r.corporate_number, r.name, r.corp_form, r.pref_name, r.city_name,
      r.address_full, r.post_code, r.kind, r.assignment_date,
      r.industry_code, r.industry_name, r.capital, r.employees, r.revenue,
      r.website_url, r.contact_form_url, r.contact_email,
      r.hiring === 1 ? '採用中' : '', r.hiring_roles,
    ].map(csvEscape).join(',');
  }
}
