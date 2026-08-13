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
import { employeesSqlExpr, revenueSqlExpr, scaleWithEstimates } from '../enrich/estimate.ts';
import { CAPITAL_BANDS, EMPLOYEE_BANDS, REVENUE_BANDS, findBand, type Band } from './bands.ts';
import { emptySocialLinks, normalizeSocialLinks } from '../enrich/site/extract.ts';

export interface SearchFilter {
  /** 商号の部分一致。3 文字以上は全文検索、2 文字以下は前方後方一致で照合する */
  keyword?: string;
  /** 都道府県コード ('13' = 東京都) */
  prefCodes?: string[];
  /** 市区町村コード。prefCodes と併用する */
  /** 県と市区町村を繋いだ 5 桁 (例: 京都市中京区 = "26" + "100")。コード単体では県を跨ぐ */
  cityKeys?: string[];
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
  /**
   * 規模の帯で絞る。複数選べる (選んだ帯のどれかに当たれば対象)。
   *
   * 従業員数と年商は書いていない会社が多いため、**推定を含めて**判定する。
   * 使う推定は画面に出すものと同じ (src/enrich/estimate.ts の定数から作る)。
   */
  employeeBands?: string[];
  capitalBands?: string[];
  revenueBands?: string[];
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
  /**
   * 並び。既定は 'fastest' — 絞り込みの中身を見て、索引が効く方の並びを選ぶ。
   * 商号順が要るときだけ 'name' を明示する。
   */
  orderBy?: 'fastest' | 'name' | 'assigned_desc' | 'capital_desc' | 'employees_desc';
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
  const orderBy = options.orderBy ?? 'fastest';
  // fastest は付加情報で絞らないとき商号順になる。そのときは商号の索引が効く
  if (orderBy !== 'name' && orderBy !== 'fastest') return '';
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
      (filter.employeeBands?.length ?? 0) > 0 ||
      (filter.capitalBands?.length ?? 0) > 0 ||
      (filter.revenueBands?.length ?? 0) > 0 ||
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
  /*
   * 市区町村は **県と組** で絞る。コードだけでは足りない。
   *
   * 市区町村コードは都道府県ごとに振り直されている。実測 (2026-08-13):
   *   コード 360 個のうち 221 個 (61%) が複数の県で重なっている。
   *   最大 44 県が同じコードを共有し、重なるコードの下に 478 万社いる。
   *   `city=201` だけで引くと、先頭 300 件に 37 県が混ざった。
   *
   * 内訳 (breakdown) は前から県と組で束ねていたのに、絞り込みだけが
   * コード単体を見ていた。そのうえ内訳の id は 5 桁 (県 2 + 市 3)、
   * 画面の印は 3 桁だったため、内訳の市区町村を押しても何も起きなかった。
   * 両方を 5 桁に揃える。
   */
  if (filter.cityKeys?.length) {
    clauses.push(`(c.pref_code || c.city_code) IN (${placeholders(filter.cityKeys.length)})`);
    params.push(...filter.cityKeys);
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

  // 帯は「どれかに当たれば対象」。1 つの括弧にまとめて OR でつなぐ
  const bandClause = (bands: readonly string[] | undefined, expr: string, table: readonly Band[]): void => {
    if (!bands || bands.length === 0) return;
    const parts: string[] = [];
    for (const id of bands) {
      const band = findBand(table, id);
      if (!band) continue;
      const conds = [`${expr} IS NOT NULL`];
      if (band.min !== null) conds.push(`${expr} >= ${band.min}`);
      if (band.max !== null) conds.push(`${expr} < ${band.max}`);
      parts.push(`(${conds.join(' AND ')})`);
    }
    if (parts.length > 0) clauses.push(`(${parts.join(' OR ')})`);
  };
  bandClause(filter.employeeBands, employeesSqlExpr('p'), EMPLOYEE_BANDS);
  bandClause(filter.capitalBands, 'p.capital', CAPITAL_BANDS);
  bandClause(filter.revenueBands, revenueSqlExpr('p'), REVENUE_BANDS);

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
    sql: `SELECT ${columns} ${where.from} ${where.sql} ${
      (options.orderBy ?? 'fastest') === 'fastest' ? fastestOrder(filter) : orderClause(options.orderBy)
    }`,
    params: where.params,
  };
}

/**
 * 並べ替えの費用は、絞り込みの中身で逆転する。
 *
 * 実測 (2026-08-13、500 件を取るまで):
 *
 *              商号順    法人番号順
 *   送れる先    0.78s      0.06s     ← 付加情報の索引から回せる
 *   年商帯     10.31s      1.37s     ← 同上
 *   県のみ      0.02s      8.61s     ← 商号の索引が県ごとに使える
 *   語 建設     4.27s     44.85s     ← 全文検索が駆動側
 *
 * どちらか一方に決め打つと、必ずどちらかが極端に遅くなる。
 * 付加情報で絞るときは法人番号順、それ以外は商号順を選ぶ。
 * どちらも決まった並びなので、続きを読み足しても行がずれない
 * (並べ替えを外すと最速だが、読み足しで重複や取りこぼしが起きうる)。
 */
function fastestOrder(filter: SearchFilter): string {
  return usesProfile(filter) ? 'ORDER BY c.corporate_number' : 'ORDER BY c.name_core';
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

/**
 * いまの条件のまま、指定した切り口ごとの件数を返す。
 *
 * 「神奈川県の建設業に絞ったとき、従業員規模はどう散らばっているか」を
 * 見るためのもの。数を見てから狙いを決められる。
 *
 * 切り口ごとに 1 本の GROUP BY で数える。帯ごとに COUNT を投げると
 * 帯の数だけ全走査が走るため、CASE で 1 回にまとめている。
 */
export type Dimension = 'employees' | 'revenue' | 'capital' | 'city' | 'pref' | 'industry';

export interface Slice {
  id: string;
  label: string;
  count: number;
}

/**
 * 集計は付加情報の側から駆動する。
 *
 * 法人マスタ (500 万行) を先に走査すると、送れる先の集計に 15 秒かかった。
 * 付加情報は 120 万行で、しかも送れる先には部分索引が張ってある。
 * 小さい方から辿れば 0.1〜3 秒に収まる (実測 15.5 秒 → 3.2 秒 → 0.1 秒)。
 */
const fromProfileFirst = `
  FROM company_profiles p
  JOIN corporations c ON c.corporate_number = p.corporate_number`;

export function breakdown(db: Db, filter: SearchFilter, dimension: Dimension): Slice[] {
  const built = buildWhere(filter, false);
  // 付加情報を条件に使っているなら、そちらから辿った方が速い。
  // 使っていない場合 (全法人が対象) は結合を変えると件数が変わってしまう
  const where = usesProfile(filter)
    ? { ...built, from: fromProfileFirst }
    : built;

  // 帯で切るものは、重なる帯 (100名以上 と 300名以上) があるため
  // CASE では 1 つにしか入らない。帯ごとに数える必要がある
  const banded: Partial<Record<Dimension, { bands: readonly Band[]; expr: string }>> = {
    employees: { bands: EMPLOYEE_BANDS, expr: employeesSqlExpr('p') },
    revenue: { bands: REVENUE_BANDS, expr: revenueSqlExpr('p') },
    capital: { bands: CAPITAL_BANDS, expr: 'p.capital' },
  };
  const b = banded[dimension];
  if (b) {
    const columns = b.bands.map((band, i) => {
      const parts = [`${b.expr} IS NOT NULL`];
      if (band.min !== null) parts.push(`${b.expr} >= ${band.min}`);
      if (band.max !== null) parts.push(`${b.expr} < ${band.max}`);
      return `SUM(CASE WHEN ${parts.join(' AND ')} THEN 1 ELSE 0 END) AS b${i}`;
    });
    const row = db
      .prepare(`SELECT ${columns.join(', ')} ${where.from} ${where.sql}`)
      .get(...where.params) as Record<string, number>;
    return b.bands.map((band, i) => ({
      id: band.id,
      label: band.label,
      count: Number(row[`b${i}`] ?? 0),
    }));
  }

  /**
   * 市区町村コードは都道府県ごとに振り直されている。
   * 「201」は 42 の都道府県に存在するため、コードだけで束ねると
   * 鳥取市と札幌市中央区が同じ塊になる (実際になった)。必ず県と組で見る。
   */
  /*
   * `present` は「空でない」。IS NOT NULL だけでは足りない。
   *
   * 実測 (2026-08-13): 都道府県の内訳が 48 区分になっていた。48 番目は
   * ラベルも id も空で 9,585 社。pref_code が NULL ではなく **空文字** の
   * 行があり、NULL の判定をすり抜けて、画面に押せない空行として出ていた。
   */
  const group: Record<'city' | 'pref' | 'industry', { key: string; label: string; present: string }> = {
    city: {
      key: 'c.pref_code || c.city_code',
      label: 'c.pref_name || c.city_name',
      present: "c.city_code IS NOT NULL AND c.city_code <> ''",
    },
    pref: { key: 'c.pref_code', label: 'c.pref_name', present: "c.pref_code IS NOT NULL AND c.pref_code <> ''" },
    industry: {
      key: 'p.industry_code',
      label: 'p.industry_name',
      present: "p.industry_code IS NOT NULL AND p.industry_code <> ''",
    },
  };
  const g = group[dimension as 'city' | 'pref' | 'industry'];
  // 別名を `id` にしてはいけない。corporations には id 列があり、
  // HAVING がそちらを見て絞り込みが効かなくなる (実際に効いていなかった)
  const rows = db
    .prepare(
      `SELECT ${g.key} AS slice_id, ${g.label} AS slice_label, COUNT(*) AS n
       ${where.from} ${where.sql} AND ${g.present}
        GROUP BY ${g.key} ORDER BY n DESC LIMIT 60`,
    )
    .all(...where.params) as Array<{ slice_id: string; slice_label: string; n: number }>;
  return rows.map((r) => ({ id: String(r.slice_id), label: r.slice_label, count: r.n }));
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

/**
 * 書き出す列。
 *
 * 表計算ソフトに貼って、そのまま営業リストとして使える並びにする。
 * 推定値には「(実測/推定)」の列を隣に置く。事実と推定を同じ列に混ぜると、
 * 受け取った人が区別できない。
 *
 * 法人番号は画面には出していないが、ここには残す。
 * 重複を防ぐ鍵であり、他の名簿と突き合わせるときの唯一の目印になる。
 */
const EXPORT_HEADER = [
  '企業名', 'メールアドレス', '代表者名', '電話番号',
  '従業員数', '従業員数の別', '年商', '年商の別',
  '公式HP', '問い合わせフォームURL', '業種', '事業内容',
  '住所', '郵便番号', '都道府県', '市区町村', '資本金',
  '代表者LinkedIn', '代表者Facebook', '代表者Instagram',
  '会社LinkedIn', '会社Facebook', '会社Instagram', '会社X',
  '採用中', '募集職種', '法人格', '法人番号', '出典',
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

/** SNS は 1 つの升目に収める。複数あるときは改行で並べる (表計算ソフトで読める形) */
function joinUrls(urls: readonly string[]): string {
  return urls.join('\n');
}

/** 表計算ソフトで開ける形に整えて 1 行ずつ返す。 */
export function* toCsvLines(rows: Iterable<CompanyRow>): Generator<string, void, void> {
  yield EXPORT_HEADER.join(',');
  for (const r of rows) {
    const scale = scaleWithEstimates(r.capital, r.employees, r.revenue);
    let sns = emptySocialLinks();
    if (r.social_links) {
      try {
        sns = normalizeSocialLinks(JSON.parse(r.social_links));
      } catch {
        // 壊れていたら空欄。書き出しを止める理由にはならない
      }
    }
    yield [
      r.name, r.contact_email, r.representative, r.contact_tel,
      scale.employees?.value ?? '', scale.employees ? (scale.employees.estimated ? '推定' : '実測') : '',
      scale.revenue?.value ?? '', scale.revenue ? (scale.revenue.estimated ? '推定' : '実測') : '',
      r.website_url, r.contact_form_url, r.industry_name, r.business_evidence,
      r.address_full, r.post_code, r.pref_name, r.city_name, r.capital,
      joinUrls(sns.representativeLinkedin), joinUrls(sns.representativeFacebook),
      joinUrls(sns.representativeInstagram),
      joinUrls(sns.linkedin), joinUrls(sns.facebook), joinUrls(sns.instagram), joinUrls(sns.x),
      r.hiring === 1 ? '採用中' : '', r.hiring_roles, r.corp_form, r.corporate_number,
      r.field_sources ?? '',
    ].map(csvEscape).join(',');
  }
}
