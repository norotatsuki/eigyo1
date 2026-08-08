/**
 * 企業サイトを訪ねて事実を集め、法人番号に突き合わせる。
 *
 * 相手の負担を増やさないこと。1 サイトあたり最大 3 ページ
 * (トップ / 会社概要 / 問い合わせ)、robots.txt に従い、間隔を空ける。
 */
import type { Db } from '../../db/index.ts';
import { normalizeCompanyName } from '../../normalize/company-name.ts';
import { invalidateMeta, loadMeta } from '../../search/meta.ts';
import { extractFromHtml, type Extracted } from './extract.ts';

const USER_AGENT = 'eigyo1-site-collector/0.1 (internal sales list builder)';
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 1_500_000;

/** 会社概要が置かれがちな場所。上から順に試す。 */
const PROFILE_PATHS = ['/company/', '/company.html', '/about/', '/corporate/', '/outline/', '/profile/'];

export interface CrawlOptions {
  limit?: number;
  /** 1 サイトごとの間隔 (ミリ秒) */
  delayMs?: number;
  onProgress?: (done: number, matched: number) => void;
}

export interface CrawlResult {
  visited: number;
  ok: number;
  failed: number;
  disallowed: number;
  matched: number;
  refusedFound: number;
  contactFound: number;
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
  const { core } = normalizeCompanyName(extracted.name);
  if (core.length < 2) return null;

  const candidates = db
    .prepare(
      `SELECT corporate_number AS n, pref_name AS pref, address_full AS addr, post_code AS post
         FROM corporations WHERE name_core = ? AND is_active = 1 LIMIT 50`,
    )
    .all(core) as Array<{ n: string; pref: string; addr: string; post: string }>;
  if (candidates.length === 0) return null;

  const address = (extracted.address ?? '').normalize('NFKC');

  // 郵便番号が一致すれば、住所の書き方の違いに左右されず特定できる。
  // 国税庁側の所在地は全角、サイト側は半角で書かれることが多く、
  // 文字列の比較だけでは取りこぼすため、まず番号で照合する。
  const postal = address ? postalCodeOf(address) : null;
  if (postal) {
    const byPost = candidates.filter((c) => c.post === postal);
    if (byPost.length === 1) {
      return { corporateNumber: byPost[0]!.n, confidence: 0.97, method: 'name_postal' };
    }
  }

  if (address) {
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
  }

  // 住所が取れなかった場合、全国で 1 社しかない商号なら紐付けてよい
  if (candidates.length === 1) {
    return { corporateNumber: candidates[0]!.n, confidence: 0.6, method: 'name_only' };
  }
  return null;
}

/** 収集していない先を 1 件ずつ訪ねる。 */
export async function crawlPendingHosts(db: Db, options: CrawlOptions = {}): Promise<CrawlResult> {
  const limit = options.limit ?? 50;
  const delayMs = options.delayMs ?? 1500;

  const hosts = db
    .prepare("SELECT host FROM web_hosts WHERE crawl_status = 'pending' ORDER BY host LIMIT ?")
    .all(limit) as Array<{ host: string }>;

  const update = db.prepare(
    `UPDATE web_hosts SET crawl_status = ?, crawled_at = ?, http_status = ?, error = ?,
       site_name = ?, site_address = ?, site_tel = ?, contact_url = ?, refused_text = ?,
       corporate_number = ?, match_confidence = ?, match_method = ?
     WHERE host = ?`,
  );
  const upsertProfile = db.prepare(
    `INSERT INTO company_profiles
       (corporate_number, website_url, website_confidence, website_checked_at,
        contact_form_url, contact_tel, solicitation_refused, refused_evidence, updated_at)
     VALUES (@n, @url, @conf, @at, @form, @tel, @refused, @evidence, @at)
     ON CONFLICT(corporate_number) DO UPDATE SET
       website_url = excluded.website_url,
       website_confidence = excluded.website_confidence,
       website_checked_at = excluded.website_checked_at,
       contact_form_url = COALESCE(excluded.contact_form_url, company_profiles.contact_form_url),
       contact_tel = COALESCE(excluded.contact_tel, company_profiles.contact_tel),
       solicitation_refused = MAX(excluded.solicitation_refused, company_profiles.solicitation_refused),
       refused_evidence = COALESCE(excluded.refused_evidence, company_profiles.refused_evidence),
       updated_at = excluded.updated_at`,
  );

  const result: CrawlResult = {
    visited: 0, ok: 0, failed: 0, disallowed: 0, matched: 0, refusedFound: 0, contactFound: 0,
  };

  for (const { host } of hosts) {
    result.visited++;
    const origin = `https://${host}`;
    const now = new Date().toISOString();

    if (!(await robotsAllows(origin, ['/', ...PROFILE_PATHS]))) {
      result.disallowed++;
      update.run('disallowed', now, null, 'robots.txt により不可', null, null, null, null, null, null, null, null, host);
      await sleep(delayMs);
      continue;
    }

    const top = await fetchText(`${origin}/`);
    if (!top || top.body === '') {
      result.failed++;
      update.run('failed', now, top?.status ?? null, top ? 'HTML を取得できません' : '接続できません',
        null, null, null, null, null, null, null, null, host);
      await sleep(delayMs);
      continue;
    }

    let info = extractFromHtml(top.body, `${origin}/`);

    // 会社概要ページがあれば、そちらの方が正確
    if (!info.name || !info.address) {
      for (const path of PROFILE_PATHS) {
        const page = await fetchText(`${origin}${path}`);
        if (!page || page.body === '') continue;
        const more = extractFromHtml(page.body, `${origin}${path}`);
        info = {
          name: info.name ?? more.name,
          address: info.address ?? more.address,
          tel: info.tel ?? more.tel,
          contactUrl: info.contactUrl ?? more.contactUrl,
          refusedText: info.refusedText ?? more.refusedText,
        };
        break; // 1 サイトにつき追加 1 ページまで
      }
    }

    // 営業お断りの表示は問い合わせページに書かれていることが多い。
    // トップと会社概要だけを見ていたとき、279 サイトで検出 0 件だった。
    // 見落とすと断られている相手に送ることになるので、ここは必ず確かめる。
    if (info.contactUrl && !info.refusedText) {
      const contactPage = await fetchText(info.contactUrl);
      if (contactPage && contactPage.body !== '') {
        const onContact = extractFromHtml(contactPage.body, info.contactUrl);
        if (onContact.refusedText) info.refusedText = onContact.refusedText;
      }
    }

    const match = matchCorporation(db, info);
    result.ok++;
    if (match) result.matched++;
    if (info.refusedText) result.refusedFound++;
    if (info.contactUrl) result.contactFound++;

    update.run(
      'ok', now, top.status, null,
      info.name, info.address, info.tel, info.contactUrl, info.refusedText,
      match?.corporateNumber ?? null, match?.confidence ?? null, match?.method ?? null,
      host,
    );

    if (match) {
      upsertProfile.run({
        n: match.corporateNumber,
        url: origin,
        conf: match.confidence,
        at: now,
        form: info.contactUrl,
        tel: info.tel,
        refused: info.refusedText ? 1 : 0,
        evidence: info.refusedText ? `${origin}: ${info.refusedText}` : null,
      });
    }

    options.onProgress?.(result.visited, result.matched);
    await sleep(delayMs);
  }

  // 付加情報を書き換えたので、画面の選択肢の控えを作り直しておく。
  // 捨てるだけにすると、次に画面を開いた人が 40 秒待たされる。
  if (result.matched > 0) {
    invalidateMeta(db);
    loadMeta(db);
  }

  return result;
}
