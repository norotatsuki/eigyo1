/**
 * 企業サイトの HTML から、営業に必要な事実を取り出す。
 *
 * 取り出すのは 会社名 / 所在地 / 電話番号 / 問い合わせページ / 営業お断り の 5 つ。
 * 相手の書き方は千差万別なので、確実に取れるものだけを狙い、
 * 迷ったら取らない (誤った宛先を作るより、空欄の方がましである)。
 */

/** 会社概要ページで会社名が置かれる見出し。長いものから照合する。 */
const NAME_LABELS = ['商号又は名称', '会社名・商号', '法人名', '会社名', '商号', '名称', '社名'];
const ADDRESS_LABELS = ['本社所在地', '本店所在地', '所在地', '住所', '本社', '本店'];
const TEL_LABELS = ['電話番号', 'TEL', 'Tel', '電話', '代表電話'];

/**
 * 営業お断りの表示。
 *
 * これを見つけたら送信前ゲートが止める。取りこぼすより拾いすぎる方が安全なので、
 * 判断に迷う表現も入れてある。
 */
const REFUSAL_PATTERNS = [
  '営業目的のお問い合わせはお断り',
  '営業目的のお問合せはお断り',
  '営業のお問い合わせはお断り',
  '営業・勧誘目的',
  '営業目的でのご利用',
  '営業メールはお断り',
  '売り込み目的',
  '勧誘目的のお問い合わせ',
  '営業に関するお問い合わせはご遠慮',
  '営業行為はお断り',
  '営業のご連絡はお断り',
  'セールス目的',
  '営業目的のご連絡',
];

export interface Extracted {
  name: string | null;
  address: string | null;
  tel: string | null;
  contactUrl: string | null;
  refusedText: string | null;
}

/** タグを落として本文だけにする。 */
export function toText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 定義リストや表から「見出し → 値」を拾う。
 *
 * 会社概要は <table><tr><th>商号</th><td>株式会社○○</td></tr> か
 * <dl><dt>商号</dt><dd>…</dd></dl> で書かれていることが多い。
 */
function fromLabeledCell(html: string, labels: readonly string[]): string | null {
  for (const label of labels) {
    const patterns = [
      new RegExp(`<t[hd][^>]*>\\s*${label}\\s*[：:]?\\s*</t[hd]>\\s*<t[hd][^>]*>([\\s\\S]{1,300}?)</t[hd]>`, 'i'),
      new RegExp(`<dt[^>]*>\\s*${label}\\s*[：:]?\\s*</dt>\\s*<dd[^>]*>([\\s\\S]{1,300}?)</dd>`, 'i'),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      const value = m?.[1] ? toText(m[1]) : '';
      if (value.length > 0 && value.length <= 200) return value;
    }
  }
  return null;
}

const CORP_FORM_RE = '株式会社|有限会社|合同会社|合資会社|合名会社';

/** 題名を区切る記号。「◯◯の△△なら□□株式会社｜公式サイト」を分ける。 */
const TITLE_SEPARATORS = /[|｜│/／\-–—:：·・･«»【】\[\]()（）,、]/;

/**
 * 会社名らしき文字列を選ぶ。
 *
 * 題名から拾うと宣伝文句を巻き込みやすい。実測した失敗例:
 *   「千歳烏山の不動産なら株式会社」… 後株として前半を丸ごと拾った
 *   「福岡の業務用厨房機器の導入ならサンキュウ株式会社」… 同上
 *
 * そこで
 *   - 前株 (株式会社◯◯) は文中のどこにあっても拾える。こちらを優先する
 *   - 後株 (◯◯株式会社) は、その区切りがほぼ社名だけのときに限る
 * とする。迷ったら取らない。
 */
export function pickCompanyName(title: string): string | null {
  const segments = title.split(TITLE_SEPARATORS).map((s) => s.trim()).filter((s) => s.length > 0);

  // 前株: 「株式会社」以降を社名とみなす。助詞や記号の手前で切る
  for (const seg of segments) {
    const m = seg.match(new RegExp(`(${CORP_FORM_RE})([^\\s。、,，!！?？]{1,24})`));
    if (m?.[2]) {
      const tail = m[2].replace(/(の|は|が|を|で|と|へ|より|から).*$/u, '');
      if (tail.length >= 1) return `${m[1]}${tail}`;
    }
  }

  // 後株: 区切りの全体がほぼ社名のときだけ採る (宣伝文句を巻き込まないため)
  for (const seg of segments) {
    const m = seg.match(new RegExp(`^(.{1,16}?)(${CORP_FORM_RE})$`));
    if (m?.[1]) return `${m[1]}${m[2]}`;
  }
  return null;
}

/** 著作権表示から社名を拾う。題名が使えないサイトでも footer には出ていることが多い。 */
export function nameFromCopyright(text: string): string | null {
  const m = text.match(
    new RegExp(`(?:©|Copyright|COPYRIGHT|\\(c\\))[^。\\n]{0,60}?((?:${CORP_FORM_RE})[^\\s,，.。|｜]{1,24}|[^\\s,，.。|｜]{1,16}(?:${CORP_FORM_RE}))`),
  );
  return m?.[1] ?? null;
}

/**
 * 日本の電話番号。市外局番の区切りに全角が混ざることがある。
 *
 * 前後に数字や区切りが続く場合は拾わない。これが無いと郵便番号
 * 「〒100-0001」の中から「00-0001」を電話番号として取ってしまう
 * (実測で見つけた不具合)。
 */
const TEL_RE = /(?<![\d\-－〒])0\d{1,4}[-－(（]?\d{1,4}[-－)）]?\d{3,4}(?![\d\-－])/g;

/** 市外局番から始まる 10 桁または 11 桁であること。 */
function isPlausibleTel(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  return (digits.length === 10 || digits.length === 11) && digits.startsWith('0');
}

/** 本文から電話番号らしいものを 1 つ選ぶ。 */
export function findTel(text: string): string | null {
  for (const m of text.matchAll(TEL_RE)) {
    if (isPlausibleTel(m[0])) return m[0];
  }
  return null;
}

/** 郵便番号つきの住所。会社概要以外の場所にもよく書かれている */
const ADDRESS_RE =
  /(?:〒\s*)?\d{3}[-－]?\d{4}\s*((?:北海道|東京都|(?:京都|大阪)府|.{2,3}県)[^\s<>「」]{4,60})/;

/** 問い合わせページらしいリンク。 */
const CONTACT_HINTS = ['contact', 'inquiry', 'toiawase', 'otoiawase', 'form', 'お問い合わせ', 'お問合せ', '問い合わせ'];

function findContactUrl(html: string, baseUrl: string): string | null {
  const links = [...html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)];
  for (const m of links) {
    const href = m[1] ?? '';
    const text = toText(m[2] ?? '');
    const haystack = `${href.toLowerCase()} ${text}`;
    if (!CONTACT_HINTS.some((h) => haystack.includes(h))) continue;
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) continue;
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
  }
  return null;
}

/** 営業お断りの文言を探す。見つけた文言をそのまま返す (根拠として残す)。 */
export function findRefusal(text: string): string | null {
  for (const p of REFUSAL_PATTERNS) {
    const i = text.indexOf(p);
    if (i !== -1) return text.slice(Math.max(0, i - 20), i + p.length + 30).trim();
  }
  return null;
}

/** 1 ページから取れるものを取る。 */
export function extractFromHtml(html: string, pageUrl: string): Extracted {
  const text = toText(html);

  // 会社概要の表 → 題名 → 著作権表示 の順に確からしい
  let name = fromLabeledCell(html, NAME_LABELS);
  if (!name) {
    const title = html.match(/<title[^>]*>([\s\S]{1,200}?)<\/title>/i)?.[1];
    name = title ? pickCompanyName(toText(title)) : null;
  }
  if (!name) name = nameFromCopyright(text);

  const address = fromLabeledCell(html, ADDRESS_LABELS) ?? text.match(ADDRESS_RE)?.[0] ?? null;
  const telCell = fromLabeledCell(html, TEL_LABELS);
  const tel = (telCell ? findTel(telCell) : null) ?? findTel(text);

  return {
    name: name?.trim() || null,
    address: address?.trim() || null,
    tel: tel?.trim() || null,
    contactUrl: findContactUrl(html, pageUrl),
    refusedText: findRefusal(text),
  };
}
