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

/**
 * 営業の宛先として使ってはいけないアドレス。
 *
 * 実データで拾ってしまったもの:
 *   sample@address.com  … 雛形のまま公開されている見本
 *   recruit@…           … 応募者向けの窓口。営業を送る先ではない
 *   noreply@…           … 送信専用。届かない
 */
const EMAIL_REJECT: ReadonlyArray<readonly [reason: string, pattern: RegExp]> = [
  // `mail@…` を見本扱いしてはいけない。`mail@kaisha.co.jp` は日本の会社で
  // 普通に使われている実在のアドレスで、実データで 31 件を誤って捨てていた。
  // 見本かどうかは **ドメイン側** で判じる (@example. など)
  ['見本', /^(sample|example|test|dummy|hoge|foo|bar|aaa|xxx|yourname|your-?mail)@|@(example|sample|test|dummy|address|domain|yourdomain|mailaddress)\./i],
  ['送信専用', /^(noreply|no-reply|donotreply|do-not-reply|auto|automail|system|bounce|postmaster|mailer-daemon)@/i],
  // 語の後ろに続きが付く形がある。実測 (2026-08-12、採用ページ 117 件):
  // `entrysheet@` が素通りしていた。`@` 直前までを語の続きとして許す。
  // 語で始まっていることは変えない (`alta-career@` のような社名由来は残す)
  ['採用専用', /^(recruit|saiyo|saiyou|jinji|entry|career|job|kyujin)[a-z0-9._-]*@/i],
  ['ファイル', /\.(png|jpe?g|gif|webp|svg|css|js|woff2?)$/i],
  ['計測', /@(sentry|wixpress|sentry\.io)/i],
];

/** そのアドレスを営業の宛先として使ってよいか。使えないなら理由を返す。 */
export function emailRejectReason(email: string): string | null {
  const value = email.trim();
  if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value)) return '形が違う';
  for (const [reason, pattern] of EMAIL_REJECT) {
    if (pattern.test(value)) return reason;
  }
  return null;
}

/**
 * 難読化して書かれたメールアドレスを読み取る。
 *
 * 迷惑メール避けに `info [at] example.jp` のような書き方をするサイトがある。
 * これは **公開されているアドレス** であって、推測でも生成でもない。
 * 書き方を戻すだけで、無いものを作り出してはいけない。
 *
 * 実測 (メールが取れなかった 120 社): 34 件見つかったうち 2 件がこの形。
 */
/** アットマークの書き換え。 */
const AT_MARK = String.raw`(?:\[\s*at\s*\]|\(\s*at\s*\)|＠|&#0*64;|&#x40;|\s+at\s+|＜at＞|%40)`;
/** ドットの書き換え。 */
const DOT_MARK = String.raw`(?:\[\s*dot\s*\]|\(\s*dot\s*\)|&#0*46;|\s+dot\s+|\.)`;

/**
 * ドメイン部は区切りが何回も現れる (`kaisha (dot) co (dot) jp`)。
 * 1 回だけを見ると `kaisha.co` で切れてしまうため、繰り返しとして受ける。
 */
const OBFUSCATED_RE = new RegExp(
  String.raw`([a-zA-Z0-9._%+-]{1,64})\s*${AT_MARK}\s*` +
    String.raw`((?:[a-zA-Z0-9-]{1,63}\s*${DOT_MARK}\s*)+[a-zA-Z]{2,12})(?![a-zA-Z])`,
  'i',
);
const DOT_MARK_G = new RegExp(DOT_MARK, 'gi');

export function findObfuscatedEmail(text: string): string | null {
  const m = text.match(OBFUSCATED_RE);
  if (!m?.[1] || !m[2]) return null;
  const domain = m[2].replace(DOT_MARK_G, '.').replace(/\s+/g, '');
  const candidate = `${m[1]}@${domain}`.toLowerCase();
  return emailRejectReason(candidate) ? null : candidate;
}

/**
 * 文字列の中からアドレスの形をした部分だけを取り出す。
 *
 * mailto: の中身をそのまま使うと、見出しや複数のアドレスが混ざる。
 * 実データで拾ったもの:
 *   `アドレス：pr@indent.co.jp`               見出しが付いている
 *   `E-mail：media-pr@cc-main.co.jp`          同上
 *   `info@leap-ai.co.jp\\`                    末尾に余計な記号
 *   `a@x.com,b@y.co.jp`                       2 つ並んでいる (先頭だけ採る)
 */
function firstAddress(raw: string): string | null {
  const m = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0] : null;
}

export function findEmail(html: string, text: string, host?: string): string | null {
  const candidates: string[] = [];
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    if (!m[1]) continue;
    let decoded = m[1];
    try {
      decoded = decodeURIComponent(m[1]);
    } catch {
      // 壊れた符号化はそのまま扱う。取り出しでどのみち弾かれる
    }
    const only = firstAddress(decoded);
    if (only) candidates.push(only);
  }
  // 数値文字参照で書かれたアドレス (&#105;&#110;… ) を戻してから探す
  const decoded = text.replace(/&#(\d{1,4});/g, (_, d: string) => String.fromCharCode(Number(d)));
  candidates.push(...(decoded.match(EMAIL_RE) ?? []));

  const usable = candidates.map((c) => c.trim()).filter((c) => emailRejectReason(c) === null);
  if (usable.length > 0) {
    // そのサイトのドメインのアドレスがあれば、それが本命
    if (host) {
      const bare = host.replace(/^www\./, '');
      const own = usable.find((c) => c.toLowerCase().endsWith(`@${bare}`) || c.toLowerCase().endsWith(`.${bare}`));
      if (own) return own;
    }
    return usable[0] ?? null;
  }
  // 普通の書き方で無ければ、難読化された書き方を探す
  return findObfuscatedEmail(decoded);
}

/**
 * 代表者名を拾う。
 *
 * 会社概要の「代表取締役　山田 太郎」を狙う。役職だけの行や、
 * 「代表取締役社長室」のような部署名を人名と取り違えないよう、
 * 姓名の形になっているものだけを採る。
 */
const REP_TITLES = [
  '代表取締役社長', '代表取締役会長', '代表取締役', '代表社員', '代表理事',
  '取締役社長', '理事長', '代表者名', '代表者', '園長', '院長', '所長', '社長',
];
/** 人名に使う文字。ここに無い文字が混ざったら人名ではない */
const NAME_CHARS = '[一-龥々ぁ-んァ-ヶー]';
/**
 * 人名に見えて人名でないもの。
 *
 * 「代表取締役社長室のご案内」から「室のご案内」を人名として取っていた。
 * 部署・組織を表す語と、人名にはまず現れない助詞で弾く。
 */
const NOT_A_NAME =
  /(部|課|室|係|会社|法人|組合|グループ|センター|事業|本部|支店|営業所|工場|一同|挨拶|紹介|案内|情報|名鑑|一覧|目次|概要|詳細|各位|より|から|まで|の|を|は|が|に|で|と|も|ご|お|様|御)/;

/**
 * 会社概要の見出し語。代表者名の直後にはこれが続くことが多い。
 *
 * 実データ: 「代表者 宇佐美浩一 設立」から「宇佐美浩一 設立」を人名として取っていた。
 * 表を字面で読んでいる以上、隣の見出しに食い込むことは避けられないので、
 * 見出し語だったら切り落とす。
 */
const PROFILE_LABELS = [
  '設立', '創業', '資本金', '所在地', '住所', '電話', '本社', '従業員', '事業', '業務', '沿革',
  '許可', '免許', '登録', '取引', '売上', '決算', '役員', '主要', '加盟', '認証', '営業', '代表',
  // 役職と、代表者名の隣に置かれがちな見出し。
  // 「岡本篤 専務取締役」「奥野久美子 制定日」から姓名だけを残すために要る
  '専務', '常務', '監査', '取締', '制定', '改定', '施行', '理念', '方針', '沿革',
];

/**
 * 人名の形をしているか。
 *
 * 日本人の姓名は漢字で 2〜6 字にほぼ収まる (「勅使河原太郎」で 6 字)。
 * カタカナだけの名前 (外国の方) もあるが、**漢字とカタカナが混ざった長い語**は
 * まず人名ではない。
 *
 * 実データ: 「代表者 発信力向上プログラム」から「発信力向上プログラム」を
 * 人名として取っていた。漢字 5 字 + カタカナ 5 字で、どの語も禁止語に無い。
 * 長さと字種の並びで弾く。
 */
function looksLikePersonName(name: string, separated: boolean): boolean {
  if (name.length < 2 || name.length > 6) return false;
  // 区切りが無い姓名は 3 字以上になる (「高橋渉」「山田太郎」)。
  // 2 字は姓だけか、そもそも人名でないことが多い
  // (実データ: 「令嬢」を代表者名として取っていた)
  if (!separated && name.length < 3) return false;
  const hasKanji = /[一-龥々]/.test(name);
  const hasKana = /[ァ-ヶー]/.test(name);
  // 漢字とカタカナが混ざるのは、社名や商品名にありがちな形
  if (hasKanji && hasKana) return false;
  // カタカナだけの人名は「ジョン・スミス」のように姓名を分けて書く。
  // 区切りが無いカタカナ語は、まず人名ではない (実データ: 「インタビュー」)
  if (hasKana && !hasKanji && !separated) return false;
  // ひらがなだけの語も同じ。会社概要で姓名をひらがなだけで書くことはまず無い
  // (実データ: 「など」を人名として取っていた)
  if (!hasKanji && !hasKana) return false;
  return true;
}

export function findRepresentative(text: string): string | null {
  for (const title of REP_TITLES) {
    // 「代表取締役 山田 太郎」「代表者：山田太郎」の形。
    // 区切りは原文のまま残す。姓と名の切れ目は書かれていない限り分からず、
    // 勝手に入れると「佐藤花子」を「佐藤花 子」にしてしまう
    const re = new RegExp(`${title}\\s*[:：]?\\s*(${NAME_CHARS}{1,5})([\\s　・]?)(${NAME_CHARS}{1,5})`);
    const m = text.match(re);
    if (!m?.[1] || !m[3]) continue;

    // 姓のうしろが見出し語なら、そこで切る (「宇佐美浩一 設立」→「宇佐美浩一」)
    let family = m[1];
    let given = m[3];
    // 見出し語そのもの、または見出し語の先頭 1 字が残った形 (「猪又晃晴 設」) を切る
    if (PROFILE_LABELS.some((w) => given === w || given.startsWith(w) || (given.length === 1 && w.startsWith(given)))) {
      if (family.length < 3) continue; // 姓だけでは短すぎる。人名と断定しない
      given = '';
    }
    for (const w of PROFILE_LABELS) {
      if (given.endsWith(w) && given.length > w.length) given = given.slice(0, -w.length);
      if (family.endsWith(w) && family.length > w.length) family = family.slice(0, -w.length);
    }

    const joined = `${family}${given}`;
    if (!looksLikePersonName(joined, m[2] !== '')) continue;
    if (NOT_A_NAME.test(joined)) continue;
    if (PROFILE_LABELS.some((w) => joined.includes(w))) continue;
    // 役職名がそのまま続いただけのものを弾く
    if (REP_TITLES.some((t) => joined.includes(t) || t.includes(joined))) continue;
    return given === '' ? family : `${family}${m[2]}${given}`;
  }
  return null;
}

/**
 * 事業内容の記述を、本文に書かれたまま取り出す。
 *
 * 業種を社名から推し量ると当てにならない (「株式会社丸十製陶」は陶器か焼肉か)。
 * 会社が自分で書いた事業内容があれば、それが根拠になる。
 * ここでは判定をせず、**原文をそのまま返す**。判定はこれを読んだ側が行う。
 */
const BUSINESS_LABELS = ['事業内容', '業務内容', '事業概要', '主な事業', '営業品目', '取扱品目', '事業領域'];

/** 次の見出しが始まる語。ここで切る。 */
const NEXT_HEADING = /(資本金|設立|従業員|代表者|所在地|電話|沿革|許可|加盟|取引銀行|主要取引)/;

/**
 * 案内メニューに現れる語。
 *
 * 「事業内容」はメニューの項目名でもあるため、本文より先にメニューに当たることがある。
 * 実データ: 「採用情報 お問い合わせ HOMEに戻る 会社概要 About us 事業内容 Service」を
 * 事業内容として拾っていた。これは会社が何をしているかを何も語っていない。
 */
const NAV_WORDS = [
  'HOME', 'ホーム', 'TOP', 'About', 'Service', 'Recruit', 'Contact', 'News',
  'お問い合わせ', 'お問合せ', '採用情報', 'サイトマップ', 'プライバシー', 'に戻る', 'MENU',
];

/** メニューらしいか。案内語が 2 つ以上あれば、それは本文ではない。 */
function looksLikeNavigation(text: string): boolean {
  let hits = 0;
  for (const w of NAV_WORDS) {
    if (text.includes(w)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

export function findBusinessDescription(text: string): string | null {
  for (const label of BUSINESS_LABELS) {
    // 同じ見出しが何度も出る (メニューと本文)。メニューでない最初のものを採る
    let from = 0;
    for (;;) {
      const i = text.indexOf(label, from);
      if (i === -1) break;
      from = i + label.length;

      const after = text.slice(from).replace(/^[\s　:：]+/, '');
      const value = (after.split(NEXT_HEADING)[0] ?? '').trim().slice(0, 200);
      if (value.length >= 8 && !looksLikeNavigation(value)) return value;
    }
  }
  return null;
}

/**
 * サイトに載っている SNS のリンクを集める。
 *
 * **会社のアカウントと、代表者個人のアカウントは別物である。**
 * 実測 (無作為 150 社): 何らかの SNS があるのは 45%、しかし
 * 代表者個人の LinkedIn (`/in/`) は **0 件**、代表者名が近くにある個人
 * プロフィールも 0 件だった。日本の企業サイトに代表者個人の SNS はまず載らない。
 *
 * したがってここで取れるものの大半は **会社の** アカウントである。
 * 代表者のものと言えるのは、個人プロフィールの形をしていて、かつ
 * その近くに代表者名が書かれている場合だけ。確認できないものを
 * 「代表者の」欄に入れてはいけない。
 */
export interface SocialLinks {
  /** 会社のアカウント。複数あればすべて残す */
  facebook: string[];
  instagram: string[];
  x: string[];
  linkedin: string[];
  /** 代表者本人と確認できたものだけ */
  representativeLinkedin: string[];
  representativeFacebook: string[];
  representativeInstagram: string[];
}

export type SocialKey = keyof SocialLinks;

const SOCIAL_KEYS: readonly SocialKey[] = [
  'facebook', 'instagram', 'x', 'linkedin',
  'representativeLinkedin', 'representativeFacebook', 'representativeInstagram',
];

export function emptySocialLinks(): SocialLinks {
  return {
    facebook: [], instagram: [], x: [], linkedin: [],
    representativeLinkedin: [], representativeFacebook: [], representativeInstagram: [],
  };
}

/**
 * 保存済みの値を、いまの形 (種類ごとの配列) に揃える。
 *
 * 初めは 1 種類につき 1 件しか持っていなかった (文字列か null)。
 * 途中で全件を残す形に変えたため、古い行と新しい行が混ざる。
 * 文字列のまま画面に渡すと 1 文字ずつ並べてしまうので、必ずここを通す。
 */
export function normalizeSocialLinks(value: unknown): SocialLinks {
  const out = emptySocialLinks();
  if (typeof value !== 'object' || value === null) return out;
  const record = value as Record<string, unknown>;
  for (const key of SOCIAL_KEYS) {
    const v = record[key];
    if (typeof v === 'string' && v.length > 0) out[key] = [v];
    else if (Array.isArray(v)) out[key] = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  }
  return out;
}

export function hasAnySocial(s: SocialLinks): boolean {
  return SOCIAL_KEYS.some((k) => s[k].length > 0);
}

/**
 * アカウントではない道筋。
 *
 * SNS のドメインに向いた URL のうち、会社のアカウントを指していないもの。
 * 実データで拾いかけたもの:
 *   facebook.com/tr?ev=…        計測タグ (Facebook ピクセル)
 *   platform.twitter.com/…      埋め込み用のスクリプト
 *   x.com/wix-html-editor-…     サイト作成ツールの部品
 *   instagram.com/p/…           個々の投稿。アカウントそのものではない
 */
const NOT_AN_ACCOUNT = new RegExp(
  [
    '/tr\\b', '/sharer', '/share\\b', '/dialog/', '/plugins/', '/2008/fbml', '/intent/',
    '/pin/create', 'widgets\\.js', '/embed', '/oembed',
    '/p/', '/reel/', '/reels/', '/explore/', '/accounts/', '/stories/',
    '/hashtag/', '/search', '/i/', '/home\\b', '/login', '/help\\b',
    '/shareArticle', '/sharing/', '/pub/dir/', '/feed/',
    'wix-', 'squarespace', 'shopify', 'wordpress',
  ].join('|'),
  'i',
);

/** 名前の部分が会員名になっていない (プラットフォーム側の予約語) もの。 */
const RESERVED_HANDLE = new Set([
  'home', 'about', 'login', 'signup', 'help', 'privacy', 'terms', 'legal', 'settings',
  'share', 'sharer', 'intent', 'search', 'explore', 'directory', 'business', 'developers',
  'studio', 'watch', 'events', 'marketplace', 'pages', 'profile.php',
]);

/** 埋め込み用の下位ドメイン。会社のアカウントではない */
const PLATFORM_SUBDOMAIN = /^(platform|developers?|connect|badge|apps|business|graph|static|cdn)\./i;

/** SNS の URL を種類ごとに振り分ける。アカウントでなければ null。 */
function classifySocial(raw: string, base: string): { key: 'facebook' | 'instagram' | 'x' | 'linkedin'; url: string; personal: boolean } | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (PLATFORM_SUBDOMAIN.test(host)) return null;
  const bare = host.replace(/^www\./, '');

  // 追跡用の飾りは宛先の一部ではない。落として揃える
  url.search = '';
  url.hash = '';
  const full = url.toString().replace(/\/$/, '');
  const path = url.pathname.replace(/\/$/, '');
  if (path === '' || path === '/') return null; // トップページはアカウントではない
  if (NOT_AN_ACCOUNT.test(url.pathname)) return null;

  const handle = (path.split('/').filter(Boolean)[0] ?? '').toLowerCase();
  if (RESERVED_HANDLE.has(handle)) return null;

  if (bare === 'linkedin.com') {
    if (/^\/in\//i.test(path)) return { key: 'linkedin', url: full, personal: true };
    if (/^\/(company|school|showcase)\//i.test(path)) return { key: 'linkedin', url: full, personal: false };
    return null;
  }
  if (bare === 'facebook.com' || bare === 'fb.com' || bare === 'fb.me') {
    return { key: 'facebook', url: full, personal: false };
  }
  if (bare === 'instagram.com') return { key: 'instagram', url: full, personal: false };
  if (bare === 'twitter.com' || bare === 'x.com') return { key: 'x', url: full, personal: false };
  return null;
}

/** リンクの近くに代表者名があるか。あればその人のものとみなしてよい */
function nearRepresentative(html: string, href: string, representative: string | null): boolean {
  if (!representative) return false;
  const i = html.indexOf(href);
  if (i === -1) return false;
  const around = html.slice(Math.max(0, i - 300), i + 300);
  // 「山田 太郎」と「山田太郎」のどちらの書き方でも拾えるように
  return around.includes(representative) || around.includes(representative.replace(/[\s　]/g, ''));
}

/**
 * サイトに載っている SNS のアカウントを集める。
 *
 * **会社のアカウントと、代表者個人のアカウントは別物である。**
 * 実測 (無作為 150 社): 何らかの SNS があるのは 45%、しかし
 * 代表者個人の LinkedIn (`/in/`) は 0 件、代表者名が近くにある個人
 * プロフィールも 0 件だった。日本の企業サイトに代表者個人の SNS はまず載らない。
 *
 * したがってここで取れるものの大半は **会社の** アカウントである。
 * 代表者のものと言えるのは、個人プロフィールの形をしていて、かつ
 * その近くに代表者名が書かれている場合だけ。確認できないものを
 * 「代表者の」欄に入れてはいけない。
 *
 * 探す場所は 2 つ:
 *   1. `href` のリンク (大半はここ)
 *   2. JSON-LD の `sameAs` — 会社が「これが公式です」と宣言している箇所。
 *      使っているのは 4% だが、宣言である分だけ確かで、リンクより信用できる
 */
export function findSocialLinks(html: string, representative: string | null = null): SocialLinks {
  const found = emptySocialLinks();
  const seen = new Set<string>();

  const add = (key: SocialKey, url: string): void => {
    if (seen.has(url)) return;
    seen.add(url);
    found[key].push(url);
  };

  const base = 'https://example.invalid';

  // ① 会社が宣言している公式アカウント (JSON-LD の sameAs)
  for (const block of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const m of (block[1] ?? '').matchAll(/"(https?:\/\/[^"\s]+)"/g)) {
      const c = classifySocial(m[1] ?? '', base);
      if (!c) continue;
      // 宣言に載るのは会社の公式アカウント。個人プロフィールでもここでは会社扱いにしない
      add(c.personal ? 'representativeLinkedin' : c.key, c.url);
    }
  }

  // ② 本文のリンク
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = (m[1] ?? '').trim();
    if (href.length === 0) continue;
    const c = classifySocial(href, base);
    if (!c) continue;

    if (c.personal) {
      // LinkedIn の個人プロフィール。代表者名が近くにあるときだけ代表者のものとする
      if (nearRepresentative(html, href, representative)) add('representativeLinkedin', c.url);
      continue;
    }
    if (nearRepresentative(html, href, representative)) {
      if (c.key === 'facebook') add('representativeFacebook', c.url);
      else if (c.key === 'instagram') add('representativeInstagram', c.url);
      else add(c.key, c.url);
      continue;
    }
    add(c.key, c.url);
  }

  return found;
}

/**
 * 会社の事実が載っていそうなページへのリンクを、案内から拾う。
 *
 * 決め打ちの道筋 (`/company/` 等) だけでは、その規約を使っていないサイトに
 * 届かない。実測 (サイトが判明した 115,376 社): メール無し 76% /
 * 代表者無し 41% / 事業内容無し 52% と、取りこぼしが大きかった。
 *
 * リンクの文字と行き先の両方を見る。同じ相手の中だけを辿り、
 * 外のサイトへは出ない。
 */
const PROFILE_LINK_WORDS = [
  '会社概要', '会社案内', '会社情報', '企業情報', '企業概要', '法人概要', '事業所概要',
  '代表挨拶', '代表者挨拶', 'ご挨拶', 'トップメッセージ', '役員', '経営陣', 'スタッフ紹介',
  '事業内容', '事業案内', '特定商取引', '特商法', 'プライバシー', '個人情報',
  'company', 'about', 'corporate', 'profile', 'outline', 'overview', 'message',
  'greeting', 'officer', 'staff', 'privacy', 'policy', 'tokushoho',
];

export function findProfileLinks(html: string, baseUrl: string, limit = 12): string[] {
  let origin = '';
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return [];
  }

  const found: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    const href = (m[1] ?? '').trim();
    if (href.length === 0 || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) continue;

    const haystack = `${href.toLowerCase()} ${toText(m[2] ?? '')}`;
    if (!PROFILE_LINK_WORDS.some((w) => haystack.includes(w))) continue;

    let url: URL;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    // 同じ相手の中だけを辿る。外のサイトに出ない
    if (url.origin !== origin) continue;
    if (/\.(pdf|jpe?g|png|gif|zip|xlsx?|docx?)$/i.test(url.pathname)) continue;
    url.hash = '';
    const full = url.toString();
    if (seen.has(full) || full === baseUrl) continue;
    seen.add(full);
    found.push(full);
    if (found.length >= limit) break;
  }
  return found;
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
