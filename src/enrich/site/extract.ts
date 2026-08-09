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
  email: string | null;
  contactUrl: string | null;
  refusedText: string | null;
}

/**
 * 公開されているメールアドレスを拾う。
 *
 * 特定電子メール法 3条1項4号 は「自己の電子メールアドレスを公表している団体」への
 * 送信を同意なしで認めている。ここで拾えるのは、まさにその公表アドレスである。
 *
 * 画像やサイト運用会社のアドレスを拾わないよう、mailto: を最優先にし、
 * 明らかに無関係なもの (example / noreply / 拡張子が画像) は落とす。
 */
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const EMAIL_REJECT = /(example\.|@sentry|noreply|no-reply|donotreply|\.(png|jpe?g|gif|webp|svg|css|js)$)/i;

export function findEmail(html: string, text: string, host?: string): string | null {
  const candidates: string[] = [];
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    if (m[1]) candidates.push(decodeURIComponent(m[1]));
  }
  candidates.push(...(text.match(EMAIL_RE) ?? []));

  const usable = candidates.map((c) => c.trim()).filter((c) => EMAIL_RE.test(c) && !EMAIL_REJECT.test(c));
  if (usable.length === 0) return null;
  // そのサイトのドメインのアドレスがあれば、それが本命
  if (host) {
    const bare = host.replace(/^www\./, '');
    const own = usable.find((c) => c.toLowerCase().endsWith(`@${bare}`) || c.toLowerCase().endsWith(`.${bare}`));
    if (own) return own;
  }
  return usable[0] ?? null;
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

/** 文の切れ目になる助詞。社名の中にも現れうるので、これだけで捨ててはいけない。 */
const PARTICLES = /(なら|をお探し|はこちら|のための|による|への|の|を|は|で|へ|から|より)/g;

/**
 * 後株の社名から宣伝文句を削った形を、短い順に返す。
 *
 * 「事務所をお探しならバイリンク株式会社」の題名から
 * 「バイリンク株式会社」を得るためのもの。
 *
 * ただし助詞は社名の中にも現れる (「の」を含む後株の実在社名は 3,684 社ある)。
 * 削った形が正しいかは呼び出す側が国税庁のデータで確かめること。
 * ここは候補を出すだけで、正しさは保証しない。
 */
export function trimmedNameVariants(name: string): string[] {
  const m = name.match(new RegExp(`^(.+?)(${CORP_FORM_RE})$`));
  if (!m?.[1]) return [];
  const [, prefix, form] = m;

  const variants: string[] = [];
  for (const hit of prefix!.matchAll(PARTICLES)) {
    const cut = hit.index + hit[0].length;
    const rest = prefix!.slice(cut);
    // 削る側も残る側も 2 文字以上あること。
    // 「みのり株式会社」を「り株式会社」にしてしまわないための下限
    if (cut >= 2 && rest.length >= 2) variants.push(`${rest}${form}`);
  }
  // 短い (= よく削れた) ものから試す
  return variants.sort((a, b) => a.length - b.length);
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

/** 営業の宛先にしてはいけない外部サービス。 */
const SNS_HOSTS = ['facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'line.me', 'youtube.com', 'tiktok.com'];

/** 資料や画像。フォームではない。 */
const FILE_EXT = /\.(pdf|jpe?g|png|gif|zip|xlsx?|docx?)$/i;

/** 問い合わせではない案内ページ。 */
const OTHER_PAGE = /(privacy|policy|sitemap|login|mypage|faq)/i;

/** 採用の窓口を指す語。ホスト名の下位部分と経路のどちらかに出たら採用向けとみなす。 */
const RECRUIT_WORDS = ['recruit', 'saiyo', 'jinji', 'career', '採用', '求人'];

/** entry 単体は曖昧なので、応募用紙とわかる形だけを採用向けとみなす。 */
const ENTRY_FORM = /entry[-_]?form|new[-_]?entry/i;

/**
 * 登録できる範囲のドメインを返す。それより左が下位部分 (subdomain)。
 *
 * `recruit.example.co.jp` の recruit は採用専用サイトの印だが、
 * `alta-career.co.jp` の career は社名の一部にすぎない。
 * この 2 つを区別するために、どこまでが会社の名前かを見る。
 */
function splitHost(host: string): { sub: string; registrable: string } {
  const labels = host.toLowerCase().replace(/^www\./, '').split('.');
  // co.jp / or.jp / ne.jp などは 3 つで 1 社分、それ以外は 2 つで 1 社分
  const depth = labels.length >= 3 && /^(co|or|ne|ac|go|gr|ed|lg)$/.test(labels[labels.length - 2] ?? '') ? 3 : 2;
  return {
    sub: labels.slice(0, Math.max(0, labels.length - depth)).join('.'),
    registrable: labels.slice(Math.max(0, labels.length - depth)).join('.'),
  };
}

/**
 * その行き先を営業の問い合わせ先として使ってよいか。使えないなら理由を返す。
 *
 * 実データで見つけた誤り:
 *   LINE や Instagram の口を問い合わせ先にしていた (9 件)
 *     → 営業文を SNS に投稿する形になる。送ってよい相手ではない
 *   採用応募の窓口を問い合わせ先にしていた (98 件)
 *     → 応募者向けの窓口に営業を送るのは相手に迷惑で、こちらの印象も悪い
 *
 * 語がどこに出たかを見る。単なる文字列の一致では
 * `3-ex.com` を x.com と、`alta-career.co.jp` を採用サイトと取り違える
 * (どちらも実データにあった)。
 */
export function contactUrlRejectReason(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '不正な形';
  }
  const { sub, registrable } = splitHost(parsed.hostname);
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`.toLowerCase();

  if (SNS_HOSTS.includes(registrable)) return 'SNS';
  if (FILE_EXT.test(parsed.pathname)) return 'ファイル';

  // 採用専用の下位ドメイン (recruit.example.co.jp) と、経路上の採用区画 (/recruit/)
  const pathSegments = path.split(/[/?#&=]/);
  const inSub = RECRUIT_WORDS.some((w) => sub.includes(w));
  const inPath = RECRUIT_WORDS.some((w) => pathSegments.some((seg) => seg.includes(w)));
  if (inSub || inPath || ENTRY_FORM.test(path)) return '採用向け';

  if (OTHER_PAGE.test(path)) return '別ページ';
  return null;
}

function findContactUrl(html: string, baseUrl: string): string | null {
  const links = [...html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)];
  for (const m of links) {
    const href = m[1] ?? '';
    const text = toText(m[2] ?? '');
    const haystack = `${href.toLowerCase()} ${text}`;
    if (!CONTACT_HINTS.some((h) => haystack.includes(h))) continue;
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) continue;
    try {
      const abs = new URL(href, baseUrl).toString();
      // 採用窓口や SNS を営業の宛先にしない。次の候補を探す
      if (contactUrlRejectReason(abs)) continue;
      return abs;
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

  let host: string | undefined;
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    host = undefined;
  }

  return {
    name: name?.trim() || null,
    address: address?.trim() || null,
    tel: tel?.trim() || null,
    email: findEmail(html, text, host),
    contactUrl: findContactUrl(html, pageUrl),
    refusedText: findRefusal(text),
  };
}
