/**
 * 企業サイトを訪ねて事実を集め、法人番号に突き合わせる。
 *
 * 相手の負担を増やさないこと。1 サイトあたり最大 3 ページ
 * (トップ / 会社概要 / 問い合わせ)、robots.txt に従い、間隔を空ける。
 */
import type { Db } from '../../db/index.ts';
import { normalizeCompanyName } from '../../normalize/company-name.ts';
import { invalidateMeta, loadMeta } from '../../search/meta.ts';
import {
  contactUrlRejectReason, emptySocialLinks, extractFromHtml, findBusinessDescription,
  findRepresentative, findSocialLinks, toText, trimmedNameVariants,
  type Extracted, type SocialLinks,
} from './extract.ts';
import { extractScale } from './scale.ts';
import { extractRecruit, findRecruitUrl, type Recruit } from './recruit.ts';
import { SOURCE as DOMAIN_LIST_SOURCE } from '../../ingest/commoncrawl/domains.ts';

/** 事業内容の根拠。会社が自分で書いた文をそのまま残す。 */
function businessEvidence(text: string): string | null {
  return findBusinessDescription(text);
}

/** 会社概要から拾えた規模。1 つも取れなければ出典も残さない。 */
function scaleOf(text: string): {
  capital: number | null; employees: number | null; revenue: number | null; scaleSource: string | null;
} {
  const s = extractScale(text);
  const any = s.capital !== null || s.employees !== null || s.revenue !== null;
  return { ...s, scaleSource: any ? 'site_profile' : null };
}

const USER_AGENT = 'eigyo1-site-collector/0.1 (internal sales list builder)';
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 1_500_000;

/**
 * 会社の事実が置かれがちな場所。上から順に試す。
 *
 * 並びは「取れる見込みの高い順」。実測でメールが最も見つかったのは
 * プライバシーポリシー (追加で見つかった 34 件のうち 17 件) だった。
 * 会社概要は社名・住所・代表者が揃うので先に見る。
 */
const DETAIL_PATHS = [
  '/company/', '/company.html', '/about/', '/corporate/', '/outline/', '/profile/',
  '/privacy/', '/privacypolicy/', '/policy/', '/privacy-policy/',
  '/contact/', '/inquiry/', '/contact.html',
  '/tokushoho/', '/law/', '/legal/',
  '/greeting/', '/message/',
];

/** robots.txt の確認に使う代表的な道筋。 */
const PROFILE_PATHS = DETAIL_PATHS.slice(0, 6);

/** 1 サイトあたりに開く下位ページの上限。相手の負担を抑える。 */
const MAX_PAGES_PER_SITE = 6;

export interface CrawlOptions {
  limit?: number;
  /** 1 サイトごとの間隔 (ミリ秒)。同時実行するので 1 本あたりの間隔 */
  delayMs?: number;
  /** 同時に当たる相手の数。相手は全て別のサイトなので、1 社への負荷は増えない */
  concurrency?: number;
  /** 同じ相手に続けて要求するときの間隔 (ミリ秒) */
  politeMs?: number;
  onProgress?: (done: number, matched: number) => void;
}

/** 1 サイト分の収集結果。通信だけを行い、書き込みは別で行う。 */
interface Collected {
  host: string;
  origin: string;
  status: 'ok' | 'failed' | 'disallowed';
  httpStatus?: number | null;
  error?: string;
  info?: Extracted;
  pageText?: string;
  recruit?: Recruit | null;
  representative?: string | null;
  social?: SocialLinks;
  /** 項目ごとに、どのページから取ったか。後から検証できるように残す */
  sources?: FieldSources;
}

/** 項目 → 取得元 URL。空欄の項目は入らない。 */
export type FieldSources = Partial<Record<
  'name' | 'address' | 'tel' | 'email' | 'contactUrl' | 'representative' | 'refusedText',
  string
>>;

/** 収集の途中経過。ページを見るたびに、まだ空いている項目だけを埋める。 */
interface Accumulator {
  info: Extracted;
  representative: string | null;
  social: SocialLinks;
  sources: FieldSources;
  text: string;
  pagesFetched: number;
}

function newAccumulator(): Accumulator {
  return {
    info: { name: null, address: null, tel: null, email: null, contactUrl: null, refusedText: null },
    representative: null,
    social: emptySocialLinks(),
    sources: {},
    text: '',
    pagesFetched: 0,
  };
}

/**
 * 1 ページ分の抽出結果を取り込む。
 *
 * 先に取れた値を優先する (上位のページほど確からしいため)。
 * 埋めた項目には、その値をどのページから取ったかを必ず残す。
 */
function absorb(acc: Accumulator, more: Extracted, url: string, html: string): void {
  for (const key of ['name', 'address', 'tel', 'email', 'contactUrl', 'refusedText'] as const) {
    if (acc.info[key] === null && more[key] !== null) {
      acc.info[key] = more[key];
      acc.sources[key] = url;
    }
  }
  const text = toText(html);
  acc.text = acc.text.length > 0 ? `${acc.text}\n${text}` : text;
  if (acc.representative === null) {
    const rep = findRepresentative(text);
    if (rep) {
      acc.representative = rep;
      acc.sources.representative = url;
    }
  }

  // SNS は footer に置かれることが多く、どのページからでも拾える。
  // 代表者名が先に取れていれば、本人のものかどうかも判じられる
  const social = findSocialLinks(html, acc.representative);
  for (const key of Object.keys(acc.social) as Array<keyof SocialLinks>) {
    if (acc.social[key] === null && social[key] !== null) acc.social[key] = social[key];
  }
}

/**
 * 欲しいものが揃ったか。
 *
 * 宛先 (メール または 問い合わせフォーム) は必ず要る。
 * 会社を特定するために社名と、住所か電話のどちらかも要る。
 * 代表者名は取れれば良い程度で、これを待って何ページも開かない。
 */
function satisfied(acc: Accumulator): boolean {
  const hasDestination = acc.info.email !== null || acc.info.contactUrl !== null;
  const hasIdentity = acc.info.name !== null && (acc.info.address !== null || acc.info.tel !== null);
  return hasDestination && hasIdentity && acc.representative !== null;
}

export interface CrawlResult {
  visited: number;
  ok: number;
  failed: number;
  disallowed: number;
  matched: number;
  refusedFound: number;
  contactFound: number;
  hiringFound: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fetchText(url: string): Promise<{ status: number; body: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.includes('html')) return { status: res.status, body: '' };
    const buf = await res.arrayBuffer();
    const slice = buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf;
    // 文字コードは宣言を見る。日本のサイトは Shift_JIS / EUC-JP がまだ残っている
    const charset = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? sniffCharset(slice);
    return { status: res.status, body: decode(slice, charset) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sniffCharset(buf: ArrayBuffer): string {
  const head = new TextDecoder('ascii').decode(buf.slice(0, 2048));
  return /charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8';
}

function decode(buf: ArrayBuffer, charset: string): string {
  const label = charset.toLowerCase().replace('windows-31j', 'shift_jis').replace('x-sjis', 'shift_jis');
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/** robots.txt を読んで、この道筋を辿ってよいかを判断する。 */
async function robotsAllows(origin: string, paths: readonly string[]): Promise<boolean> {
  const res = await fetchText(`${origin}/robots.txt`).catch(() => null);
  // robots.txt が無い / 読めない場合は許可とみなす (慣行どおり)
  if (!res || res.body === '') return true;

  const disallow: string[] = [];
  let applies = false;
  for (const raw of res.body.split('\n')) {
    const line = raw.split('#', 1)[0]!.trim();
    const [keyRaw, ...rest] = line.split(':');
    const key = (keyRaw ?? '').trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') applies = value === '*' || USER_AGENT.toLowerCase().includes(value.toLowerCase());
    else if (applies && key === 'disallow' && value !== '') disallow.push(value);
  }
  return !paths.some((p) => disallow.some((d) => p.startsWith(d)));
}

/**
 * 抽出した会社名と住所から法人番号を探す。
 *
 * 商号は照合キー (法人格・記号を落とした形) で突き合わせる。
 * 同名の会社は全国に何十社もあるため、住所の都道府県まで一致して初めて
 * 高い確信度を与える。名前だけの一致は候補が 1 社のときに限る。
 */
/**
 * 住所の文字列から郵便番号 7 桁を取り出す。国税庁側はハイフン無しで持っている。
 *
 * 区切りに使われる横棒は 1 種類ではない。NFKC で全角ハイフンは半角になるが、
 * 「−」(U+2212) や「―」「‐」はそのまま残るため、まとめて受ける。
 */
const DASHES = '-\\u2010-\\u2015\\u2212\\uFF0D';
const POSTAL_RE = new RegExp(`(?:〒\\s*)?(\\d{3})[${DASHES}\\s]?(\\d{4})(?!\\d)`);

export function postalCodeOf(address: string): string | null {
  const m = address.normalize('NFKC').match(POSTAL_RE);
  return m ? `${m[1]}${m[2]}` : null;
}

export function matchCorporation(
  db: Db,
  extracted: Extracted,
): { corporateNumber: string; confidence: number; method: string } | null {
  if (!extracted.name) return null;
  const direct = matchByName(db, extracted.name, extracted.address ?? null);
  if (direct) return direct;

  // 題名から取った社名に宣伝文句が残っていることがある
  // (「事務所をお探しならバイリンク株式会社」)。国税庁に無い商号だったときに限り、
  // 助詞で削った形を試す。削った形は誤りうるので、住所が一致したものだけ採る。
  for (const variant of trimmedNameVariants(extracted.name)) {
    const m = matchByName(db, variant, extracted.address ?? null);
    if (m && m.method !== 'name_only') {
      return { corporateNumber: m.corporateNumber, confidence: m.confidence - 0.1, method: `trimmed_${m.method}` };
    }
  }
  return null;
}

function matchByName(
  db: Db,
  name: string,
  rawAddress: string | null,
): { corporateNumber: string; confidence: number; method: string } | null {
  const { core, corpForm } = normalizeCompanyName(name);
  if (core.length < 2) return null;

  const address = (rawAddress ?? '').normalize('NFKC');
  const postal = address ? postalCodeOf(address) : null;

  /**
   * 法人格が違えば別の法人である。
   * 「合同会社スリー」と「株式会社スリー」、「BE株式会社」と「有限会社Ｂ・Ｅ」は
   * 名寄せキーが同じになるだけで、別の会社。実際に 45 件を取り違えていた。
   *
   * ただし郵便番号まで一致する先は同じ会社とみなす。
   * 有限会社から株式会社への移行をサイト側が直していないだけのことがある。
   */
  const formAgrees = (masterForm: string | null): boolean =>
    !corpForm || !masterForm || corpForm === masterForm;

  // 郵便番号が一致すれば、住所の書き方の違いに左右されず特定できる。
  // 国税庁側の所在地は全角、サイト側は半角で書かれることが多く、
  // 文字列の比較だけでは取りこぼすため、まず番号で照合する。
  //
  // 番号での絞り込みは SQL 側で行う。手元に読み出してから絞ると、
  // 同名が多い商号 (「株式会社ＺＥＲＯ」は 497 社ある) で
  // 読み出す上限に当たり、正しい 1 社が候補に入らないまま落ちる。
  if (postal) {
    const byPost = db
      .prepare(
        `SELECT corporate_number AS n FROM corporations
          WHERE name_core = ? AND is_active = 1 AND post_code = ? LIMIT 2`,
      )
      .all(core, postal) as Array<{ n: string }>;
    if (byPost.length === 1) {
      return { corporateNumber: byPost[0]!.n, confidence: 0.97, method: 'name_postal' };
    }
  }

  const all = db
    .prepare(
      `SELECT corporate_number AS n, pref_name AS pref, city_name AS city,
              address_full AS addr, corp_form AS form
         FROM corporations WHERE name_core = ? AND is_active = 1 LIMIT 1000`,
    )
    .all(core) as Array<{ n: string; pref: string; city: string; addr: string; form: string | null }>;
  const candidates = all.filter((c) => formAgrees(c.form));
  if (candidates.length === 0) return null;

  // 住所が無いなら、全国で 1 社しかない商号のときだけ紐付けてよい
  if (!address) {
    if (candidates.length > 1) return null;
    return { corporateNumber: candidates[0]!.n, confidence: 0.6, method: 'name_only' };
  }

  // 都道府県 + 市区町村まで一致するものを次点に (全角半角を揃えてから比べる)
  const exact = candidates.filter(
    (c) => c.addr.length > 0 && address.includes(c.addr.normalize('NFKC').slice(0, 8)),
  );
  if (exact.length === 1) {
    return { corporateNumber: exact[0]!.n, confidence: 0.95, method: 'name_address' };
  }

  const byPref = candidates.filter((c) => c.pref && address.includes(c.pref));
  if (byPref.length === 1) {
    return { corporateNumber: byPref[0]!.n, confidence: 0.85, method: 'name_pref' };
  }
  if (byPref.length > 1) return null; // 同じ県に同名が複数。決められないので取らない

  // 都道府県を書かないサイトは多い (「大阪市中央区城見1-2-27」など)。
  // 政令指定都市や区の名前は県をまたいで重複しないものが大半なので、
  // 市区町村だけでも 1 社に定まるならそれを採る。
  const byCity = candidates.filter((c) => c.city.length >= 2 && address.includes(c.city));
  if (byCity.length === 1) {
    return { corporateNumber: byCity[0]!.n, confidence: 0.8, method: 'name_city' };
  }
  return null;
}

export interface RematchResult {
  scanned: number;
  matched: number;
  changed: number;
  /** 前は紐付いていたが、判定を直した結果 外れた先 */
  cleared: number;
  byMethod: Record<string, number>;
}

export interface RepairResult {
  scanned: number;
  fixed: number;
  cleared: number;
}

/**
 * 保存済みの事業内容を、集めてある本文から取り直す。
 *
 * 取り方を直しても、直す前に保存した分は残る。本文は手元にあるので
 * サイトを訪ね直す必要はない。
 */
export function repairBusinessEvidence(db: Db): RepairResult {
  const rows = db
    .prepare(
      `SELECT p.corporate_number AS n, p.business_evidence AS ev,
              (SELECT h.site_text FROM web_hosts h
                WHERE h.corporate_number = p.corporate_number AND h.site_text IS NOT NULL LIMIT 1) AS text
         FROM company_profiles p WHERE p.business_evidence IS NOT NULL`,
    )
    .all() as Array<{ n: string; ev: string; text: string | null }>;

  const set = db.prepare('UPDATE company_profiles SET business_evidence = ? WHERE corporate_number = ?');
  const result: RepairResult = { scanned: rows.length, fixed: 0, cleared: 0 };
  db.transaction(() => {
    for (const r of rows) {
      const again = r.text ? findBusinessDescription(r.text) : null;
      if (again === r.ev) continue;
      set.run(again, r.n);
      if (again === null) result.cleared++;
      else result.fixed++;
    }
  })();
  return result;
}

/**
 * 保存済みの代表者名を、いまの判定にかけ直す。
 *
 * 人名の判定を厳しくしても、直す前に集めた分は残る。サイトを訪ね直さなくても
 * 保存してある値を読み直せば足りる (「代表者 <値>」として読ませる)。
 *
 * 直せるものは直し (「岡本篤 専務取締役」→「岡本篤」)、
 * 人名でないもの (「経営ビジョン」「本社」) は空欄に戻す。
 * 誤った値を残すより空欄の方がよい。
 */
export function repairRepresentatives(db: Db): RepairResult {
  const rows = db
    .prepare('SELECT host, corporate_number AS n, site_representative AS rep FROM web_hosts WHERE site_representative IS NOT NULL')
    .all() as Array<{ host: string; n: string | null; rep: string }>;

  const setHost = db.prepare('UPDATE web_hosts SET site_representative = ? WHERE host = ?');
  const setProfile = db.prepare('UPDATE company_profiles SET representative = ? WHERE corporate_number = ?');

  const result: RepairResult = { scanned: rows.length, fixed: 0, cleared: 0 };
  db.transaction(() => {
    for (const r of rows) {
      const again = findRepresentative(`代表者 ${r.rep}`);
      if (again === r.rep) continue;
      setHost.run(again, r.host);
      if (r.n) setProfile.run(again, r.n);
      if (again === null) result.cleared++;
      else result.fixed++;
    }
  })();
  return result;
}

/**
 * 繋がらなかった先を、もう一度訪ねる対象に戻す。
 *
 * 取得の仕方を直したときに使う。サイト側は変わっていないので、
 * 直した分だけ結果が変わる。一度も繋がらなかった先だけが対象で、
 * 内容が取れている先には触らない。
 */
export function resetFailedHosts(db: Db, error = '接続できません'): number {
  return db
    .prepare(
      `UPDATE web_hosts SET crawl_status = 'pending', error = NULL, crawled_at = NULL, http_status = NULL
        WHERE crawl_status = 'failed' AND error = ?`,
    )
    .run(error).changes;
}

export interface ScrubResult {
  scanned: number;
  removed: number;
  /** 除外の理由 → 件数 */
  byReason: Record<string, number>;
}

/**
 * 既に集めてある問い合わせ先から、送ってはいけない行き先を落とす。
 *
 * 判定の仕方を直しても、直す前に集めた分はそのまま残っている。
 * 集め直すのは相手にも時間にも無駄なので、手元の値を見直すだけで済ませる。
 *
 * 落とすのは「宛先」だけで、収集した本文や紐付けはそのまま残す
 * (メールや電話が別にあれば、その先には送れるため)。
 */
export function scrubContactUrls(db: Db): ScrubResult {
  const rows = db
    .prepare('SELECT host, corporate_number AS n, contact_url AS url FROM web_hosts WHERE contact_url IS NOT NULL')
    .all() as Array<{ host: string; n: string | null; url: string }>;

  const clearHost = db.prepare('UPDATE web_hosts SET contact_url = NULL WHERE host = ?');
  const clearProfile = db.prepare(
    'UPDATE company_profiles SET contact_form_url = NULL WHERE corporate_number = ? AND contact_form_url = ?',
  );

  const result: ScrubResult = { scanned: rows.length, removed: 0, byReason: {} };
  db.transaction(() => {
    for (const r of rows) {
      const reason = contactUrlRejectReason(r.url);
      if (!reason) continue;
      clearHost.run(r.host);
      if (r.n) clearProfile.run(r.n, r.url);
      result.removed++;
      result.byReason[reason] = (result.byReason[reason] ?? 0) + 1;
    }
  })();

  return result;
}

/**
 * 収集済みのデータだけで突き合わせをやり直す。
 *
 * 照合の仕方を改善するたびにサイトを訪ね直すのは相手に失礼で、時間もかかる。
 * 取ってある会社名と住所は変わらないのだから、手元で計算し直せば足りる。
 */
export function rematchHosts(db: Db): RematchResult {
  const rows = db
    .prepare(
      `SELECT host, site_name, site_address, site_tel, site_email, site_text, contact_url, refused_text,
              corporate_number AS current, match_method AS currentMethod
         FROM web_hosts WHERE crawl_status = 'ok' AND site_name IS NOT NULL`,
    )
    .all() as Array<{
    host: string; site_name: string; site_address: string | null; site_tel: string | null;
    site_email: string | null; site_text: string | null;
    contact_url: string | null; refused_text: string | null;
    current: string | null; currentMethod: string | null;
  }>;

  const update = db.prepare(
    'UPDATE web_hosts SET corporate_number = ?, match_confidence = ?, match_method = ? WHERE host = ?',
  );
  const upsertProfile = db.prepare(
    `INSERT INTO company_profiles
       (corporate_number, website_url, website_confidence, website_checked_at,
        contact_form_url, contact_email, contact_tel, solicitation_refused, refused_evidence,
        capital, employees, revenue, scale_source, updated_at)
     VALUES (@n, @url, @conf, @at, @form, @email, @tel, @refused, @evidence,
             @capital, @employees, @revenue, @scaleSource, @at)
     ON CONFLICT(corporate_number) DO UPDATE SET
       website_url = excluded.website_url,
       website_confidence = excluded.website_confidence,
       contact_form_url = COALESCE(excluded.contact_form_url, company_profiles.contact_form_url),
       contact_email = COALESCE(excluded.contact_email, company_profiles.contact_email),
       contact_tel = COALESCE(excluded.contact_tel, company_profiles.contact_tel),
       solicitation_refused = MAX(excluded.solicitation_refused, company_profiles.solicitation_refused),
       refused_evidence = COALESCE(excluded.refused_evidence, company_profiles.refused_evidence),
       updated_at = excluded.updated_at`,
  );

  const result: RematchResult = { scanned: 0, matched: 0, changed: 0, cleared: 0, byMethod: {} };
  const now = new Date().toISOString();

  const run = db.transaction(() => {
    for (const r of rows) {
      result.scanned++;
      const m = matchCorporation(db, {
        name: r.site_name, address: r.site_address, tel: r.site_tel, email: r.site_email,
        contactUrl: r.contact_url, refusedText: r.refused_text,
      });
      if (!m) {
        // 前は紐付いていたが、今の判定では紐付かない先。
        // 取り違えを直したときにここへ落ちる。古い紐付けを残してはいけない
        if (r.current) {
          update.run(null, null, null, r.host);
          result.cleared++;
        }
        continue;
      }
      result.matched++;
      result.byMethod[m.method] = (result.byMethod[m.method] ?? 0) + 1;
      if (m.corporateNumber !== r.current || m.method !== r.currentMethod) result.changed++;

      update.run(m.corporateNumber, m.confidence, m.method, r.host);
      upsertProfile.run({
        n: m.corporateNumber, url: `https://${r.host}`, conf: m.confidence, at: now,
        form: r.contact_url, email: r.site_email, tel: r.site_tel,
        ...scaleOf(r.site_text ?? ''),
        hiring: null, hiringRoles: null, newGrad: null, midCareer: null, hiringAt: null,
        refused: r.refused_text ? 1 : 0,
        evidence: r.refused_text ? `https://${r.host}: ${r.refused_text}` : null,
      });
    }
  });
  run();

  invalidateMeta(db);
  loadMeta(db);
  return result;
}

/** 収集していない先を 1 件ずつ訪ねる。 */
export async function crawlPendingHosts(db: Db, options: CrawlOptions = {}): Promise<CrawlResult> {
  const limit = options.limit ?? 50;
  const delayMs = options.delayMs ?? 300;
  const concurrency = options.concurrency ?? 6;
  const politeMs = options.politeMs ?? 300;

  /**
   * 訪ねる順。ドメイン一覧から来た先を先に回す。
   *
   * 一覧は重要な順に並んでいて、中身も会社の登録ドメインそのもの。
   * 一方、索引から来た先には `5pmjournal.0101.co.jp` のような
   * 既に消えた下位ドメインが多く混ざっており、繋がるまで待つ分だけ遅い。
   *
   * 名前順にすると「0」や「あ」から始まる小さな会社ばかりが先に埋まり、
   * 途中で止めたときの手元が偏る。
   */
  const hosts = db
    .prepare(
      `SELECT host FROM web_hosts WHERE crawl_status = 'pending'
        ORDER BY CASE WHEN source = ? THEN 0 ELSE 1 END, rowid LIMIT ?`,
    )
    .all(DOMAIN_LIST_SOURCE, limit) as Array<{ host: string }>;

  const update = db.prepare(
    `UPDATE web_hosts SET crawl_status = ?, crawled_at = ?, http_status = ?, error = ?,
       site_name = ?, site_address = ?, site_tel = ?, site_email = ?, contact_url = ?, refused_text = ?,
       site_text = ?, site_representative = ?, field_sources = ?, social_links = ?,
       corporate_number = ?, match_confidence = ?, match_method = ?
     WHERE host = ?`,
  );
  const upsertProfile = db.prepare(
    `INSERT INTO company_profiles
       (corporate_number, website_url, website_confidence, website_checked_at,
        contact_form_url, contact_email, contact_tel, solicitation_refused, refused_evidence,
        capital, employees, revenue, scale_source, representative, field_sources, business_evidence,
        social_links,
        hiring, hiring_roles, hiring_new_grad, hiring_mid_career, hiring_checked_at, updated_at)
     VALUES (@n, @url, @conf, @at, @form, @email, @tel, @refused, @evidence,
             @capital, @employees, @revenue, @scaleSource, @rep, @sources, @evidenceText,
             @social,
             @hiring, @hiringRoles, @newGrad, @midCareer, @hiringAt, @at)
     ON CONFLICT(corporate_number) DO UPDATE SET
       website_url = excluded.website_url,
       website_confidence = excluded.website_confidence,
       website_checked_at = excluded.website_checked_at,
       hiring = COALESCE(excluded.hiring, company_profiles.hiring),
       hiring_roles = COALESCE(excluded.hiring_roles, company_profiles.hiring_roles),
       hiring_new_grad = COALESCE(excluded.hiring_new_grad, company_profiles.hiring_new_grad),
       hiring_mid_career = COALESCE(excluded.hiring_mid_career, company_profiles.hiring_mid_career),
       hiring_checked_at = COALESCE(excluded.hiring_checked_at, company_profiles.hiring_checked_at),
       contact_form_url = COALESCE(excluded.contact_form_url, company_profiles.contact_form_url),
       contact_email = COALESCE(excluded.contact_email, company_profiles.contact_email),
       contact_tel = COALESCE(excluded.contact_tel, company_profiles.contact_tel),
       solicitation_refused = MAX(excluded.solicitation_refused, company_profiles.solicitation_refused),
       refused_evidence = COALESCE(excluded.refused_evidence, company_profiles.refused_evidence),
       capital = COALESCE(excluded.capital, company_profiles.capital),
       employees = COALESCE(excluded.employees, company_profiles.employees),
       revenue = COALESCE(excluded.revenue, company_profiles.revenue),
       scale_source = COALESCE(excluded.scale_source, company_profiles.scale_source),
       representative = COALESCE(excluded.representative, company_profiles.representative),
       field_sources = COALESCE(excluded.field_sources, company_profiles.field_sources),
       business_evidence = COALESCE(excluded.business_evidence, company_profiles.business_evidence),
       social_links = COALESCE(excluded.social_links, company_profiles.social_links),
       updated_at = excluded.updated_at`,
  );

  const result: CrawlResult = {
    visited: 0, ok: 0, failed: 0, disallowed: 0, matched: 0, refusedFound: 0, contactFound: 0,
    hiringFound: 0,
  };

  /**
   * 1 サイト分を集める。ここは通信だけで、データベースには触らない。
   *
   * 相手 1 社への作法は変えない。robots.txt に従い、見るのは 3 ページまで、
   * 同じ相手への続けざまの要求には間隔を空ける。
   * 速くなるのは「別々の相手に同時に当たる」からであって、
   * 1 社への当たり方を強めているわけではない。
   */
  const collect = async (host: string): Promise<Collected> => {
    // ドメイン一覧が渡してくるのは会社の登録名 (mazda.co.jp) だが、
    // 実際のサイトは www 付きでしか応答しない会社が多い。
    // 実測: 繋がらなかった先の 65% は www を付けると通った (40 件中 26 件)
    const origins = host.startsWith('www.')
      ? [`https://${host}`]
      : [`https://${host}`, `https://www.${host}`];

    let origin = origins[0]!;
    let top: { status: number; body: string } | null = null;
    for (const candidate of origins) {
      origin = candidate;
      if (!(await robotsAllows(origin, ['/', ...PROFILE_PATHS]))) {
        return { host, origin, status: 'disallowed', error: 'robots.txt により不可' };
      }
      top = await fetchText(`${origin}/`);
      if (top && top.body !== '') break;
      if (candidate !== origins[origins.length - 1]) await sleep(politeMs);
    }

    if (!top || top.body === '') {
      return {
        host, origin, status: 'failed',
        httpStatus: top?.status ?? null,
        error: top ? 'HTML を取得できません' : '接続できません',
      };
    }

    const acc = newAccumulator();
    absorb(acc, extractFromHtml(top.body, `${origin}/`), `${origin}/`, top.body);

    /**
     * 足りない項目が埋まるまで、順に下位ページを見る。
     *
     * 実測 (メールが取れなかった 120 社を追加ページまで見た): 28% で見つかった。
     * 内訳は /privacy/ 17 件 / /contact/ 7 件 / /recruit/ 3 件 / /company/ 2 件。
     * プライバシーポリシーに問い合わせ先を書く慣行があり、ここが最も効く。
     *
     * 全ページを必ず見ると 1 サイトあたり 10 往復になり、相手にも自分にも重い。
     * 欲しいものが揃った時点で切り上げる。
     */
    for (const path of DETAIL_PATHS) {
      if (satisfied(acc)) break;
      if (acc.pagesFetched >= MAX_PAGES_PER_SITE) break;
      await sleep(politeMs);
      const page = await fetchText(`${origin}${path}`);
      if (!page || page.body === '') continue;
      acc.pagesFetched++;
      absorb(acc, extractFromHtml(page.body, `${origin}${path}`), `${origin}${path}`, page.body);
    }

    let recruit: Recruit | null = null;
    const recruitUrl = findRecruitUrl(top.body, `${origin}/`);
    if (recruitUrl) {
      await sleep(politeMs);
      const page = await fetchText(recruitUrl);
      if (page && page.body !== '') recruit = extractRecruit(toText(page.body));
    }

    // 営業お断りは問い合わせページに書かれていることが多い。見落とすと
    // 断られている相手に送ることになるので、ここは必ず確かめる
    if (acc.info.contactUrl && !acc.info.refusedText) {
      await sleep(politeMs);
      const contactPage = await fetchText(acc.info.contactUrl);
      if (contactPage && contactPage.body !== '') {
        absorb(acc, extractFromHtml(contactPage.body, acc.info.contactUrl), acc.info.contactUrl, contactPage.body);
      }
    }

    return {
      host, origin, status: 'ok', httpStatus: top.status,
      info: acc.info, pageText: acc.text, recruit,
      representative: acc.representative, social: acc.social, sources: acc.sources,
    };
  };

  /** 集めた結果を書き込む。書き込みは 1 本にまとめる (SQLite は書き手が 1 つ)。 */
  const persist = (c: Collected): void => {
    result.visited++;
    const now = new Date().toISOString();

    if (c.status !== 'ok' || !c.info) {
      if (c.status === 'disallowed') result.disallowed++;
      else result.failed++;
      update.run(c.status, now, c.httpStatus ?? null, c.error ?? null,
        null, null, null, null, null, null, null, null, null, null, null, null, null, c.host);
      return;
    }

    const info = c.info;
    const match = matchCorporation(db, info);
    result.ok++;
    if (match) result.matched++;
    if (info.refusedText) result.refusedFound++;
    if (info.contactUrl) result.contactFound++;

    const sources = c.sources && Object.keys(c.sources).length > 0 ? JSON.stringify(c.sources) : null;
    // 1 つも見つからなかったときは空の JSON を残さない (空欄と区別がつかなくなる)
    const social = c.social && Object.values(c.social).some((v) => v !== null)
      ? JSON.stringify(c.social)
      : null;
    update.run(
      'ok', now, c.httpStatus ?? null, null,
      info.name, info.address, info.tel, info.email, info.contactUrl, info.refusedText,
      (c.pageText ?? '').slice(0, 4000), c.representative ?? null, sources, social,
      match?.corporateNumber ?? null, match?.confidence ?? null, match?.method ?? null,
      c.host,
    );

    if (match) {
      const recruit = c.recruit;
      upsertProfile.run({
        n: match.corporateNumber,
        url: c.origin,
        conf: match.confidence,
        at: now,
        form: info.contactUrl,
        email: info.email,
        tel: info.tel,
        refused: info.refusedText ? 1 : 0,
        evidence: info.refusedText ? `${c.origin}: ${info.refusedText}` : null,
        rep: c.representative ?? null,
        sources,
        evidenceText: businessEvidence(c.pageText ?? ''),
        social,
        ...scaleOf(c.pageText ?? ''),
        hiring: recruit ? (recruit.hiring ? 1 : 0) : null,
        hiringRoles: recruit && recruit.roles.length > 0 ? recruit.roles.join(',') : null,
        newGrad: recruit ? (recruit.newGrad ? 1 : 0) : null,
        midCareer: recruit ? (recruit.midCareer ? 1 : 0) : null,
        hiringAt: recruit ? now : null,
      });
      if (recruit?.hiring) result.hiringFound++;
    }

    options.onProgress?.(result.visited, result.matched);
  };

  // 別々の相手に同時に当たる。34.8 万件を 1 件ずつ回すと 190 時間かかる
  const queue = hosts.map((h) => h.host);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= queue.length) return;
      const host = queue[i]!;
      try {
        persist(await collect(host));
      } catch (err) {
        result.visited++;
        result.failed++;
        update.run('failed', new Date().toISOString(), null,
          err instanceof Error ? err.message : String(err),
          null, null, null, null, null, null, null, null, null, null, null, null, null, host);
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  // 付加情報を書き換えたので、画面の選択肢の控えを作り直しておく。
  // 捨てるだけにすると、次に画面を開いた人が 40 秒待たされる。
  if (result.matched > 0) {
    invalidateMeta(db);
    loadMeta(db);
  }

  return result;
}
