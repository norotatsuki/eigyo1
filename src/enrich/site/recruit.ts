/**
 * 採用ページから、営業に効く手がかりを取り出す。
 *
 * 採用情報は 3 つの意味で効く。
 *   1. 募集していること自体が「動いている」印である
 *   2. 募集職種から、いま人が足りていない部署が分かる
 *      → 「情報システム部門ご担当者様」ではなく、根拠を持って部署を選べる
 *   3. 勤務地から事業所の広がりが読める
 *
 * 当初から本丸だと言っていた「誰に当てるか」に、ここで初めて根拠が付く。
 */

/** 採用ページが置かれがちな場所。 */
export const RECRUIT_PATHS = [
  '/recruit/', '/recruit.html', '/saiyo/', '/careers/', '/career/',
  '/recruitment/', '/jobs/', '/entry/',
];

/** 採用ページへのリンクを示す語。 */
const RECRUIT_HINTS = ['採用', '求人', 'リクルート', 'recruit', 'careers', '募集', 'エントリー'];

/**
 * 募集職種 → 当てるべき部署。
 *
 * 「施工管理を募集している」なら工事部門に人が足りない、という読み方をする。
 * 長い語から照合するため、並び順に意味がある。
 */
const ROLE_RULES: ReadonlyArray<readonly [role: string, keywords: readonly string[]]> = [
  ['施工管理', ['施工管理', '現場監督', '工事管理']],
  ['設計', ['設計士', '設計職', '意匠設計', '構造設計', 'cadオペレータ', '設計']],
  ['営業', ['営業職', '法人営業', 'ルート営業', '営業スタッフ', '営業']],
  ['技術・開発', ['エンジニア', 'プログラマ', '開発職', 'システム開発', '技術職']],
  ['情報システム', ['社内se', '情報システム', 'インフラエンジニア', '情シス']],
  ['製造・生産', ['製造職', '生産管理', '組立', '機械オペレータ', '工場']],
  ['職人・技能', ['職人', '技能職', '大工', '電気工事士', '溶接', 'とび']],
  ['ドライバー', ['ドライバー', '運転手', '配送スタッフ', 'トラック']],
  ['医療・介護', ['看護師', '介護職', '介護スタッフ', '理学療法士', '薬剤師', 'ヘルパー']],
  ['販売・接客', ['販売スタッフ', '接客', 'ホールスタッフ', '店舗スタッフ', '販売職']],
  ['事務', ['一般事務', '営業事務', '事務職', '経理', '総務', '人事']],
  ['企画・マーケティング', ['マーケティング', '広報', '企画職', 'webデザイナー']],
];

/** 「募集していない」ことを示す文言。あればそちらを優先する。 */
const NOT_HIRING = ['現在募集はしておりません', '募集を行っておりません', '現在採用は行っておりません', '募集停止'];

/** 募集していることを示す文言。 */
const HIRING_NOW = ['募集中', '募集要項', 'エントリー', '応募資格', '新卒採用', '中途採用', '経験者募集', '積極採用'];

export interface Recruit {
  /** 募集していると読めるか */
  hiring: boolean;
  /** 見つかった募集職種 (部署の手がかり) */
  roles: string[];
  /** 新卒 / 中途 の別 */
  newGrad: boolean;
  midCareer: boolean;
  /** 判断の根拠になった文言 */
  evidence: string | null;
}

/** 採用ページへのリンクを本文から探す。 */
export function findRecruitUrl(html: string, baseUrl: string): string | null {
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,80}?)<\/a>/gi)) {
    const href = (m[1] ?? '').toLowerCase();
    const text = (m[2] ?? '').replace(/<[^>]+>/g, '');
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) continue;
    if (!RECRUIT_HINTS.some((h) => href.includes(h) || text.includes(h))) continue;
    try {
      return new URL(m[1] as string, baseUrl).toString();
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 採用ページの本文から募集の様子を読む。
 *
 * 「募集していない」の文言が先。載せたまま止めているサイトが多いため、
 * 職種名が並んでいるだけで募集中と決めつけない。
 */
export function extractRecruit(text: string): Recruit {
  const body = text.normalize('NFKC').toLowerCase();

  const stopped = NOT_HIRING.find((p) => body.includes(p.toLowerCase()));
  if (stopped) {
    return { hiring: false, roles: [], newGrad: false, midCareer: false, evidence: stopped };
  }

  const roles: string[] = [];
  for (const [role, keywords] of ROLE_RULES) {
    if (keywords.some((k) => body.includes(k))) roles.push(role);
  }

  const nowHiring = HIRING_NOW.find((p) => body.includes(p.toLowerCase()));
  // 職種が並んでいるだけでは足りない。募集を示す文言と併せて判断する
  const hiring = Boolean(nowHiring) && roles.length > 0;

  return {
    hiring,
    roles,
    newGrad: body.includes('新卒'),
    midCareer: body.includes('中途') || body.includes('経験者'),
    evidence: nowHiring ?? null,
  };
}
