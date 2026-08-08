/**
 * 国税庁 法人番号公表サイト の全件ダウンロード目録。
 *
 * ダウンロードは画面の JavaScript から POST される仕組みで、固定の URL がない。
 *   1. 画面を取得して、使い捨ての token と、地域ごとのファイル番号を読む
 *   2. token + ファイル番号を POST して zip を受け取る
 *
 * ファイル番号は毎月の更新で振り直されるため、控えずに毎回読み直す。
 * (実測 2026-08-08: 全国 CSV Unicode = 27660 だが、翌月には変わる)
 */

const BASE = 'https://www.houjin-bangou.nta.go.jp';
export const ZENKEN_URL = `${BASE}/download/zenken/`;
const POST_URL = `${BASE}/download/zenken/index.html`;
const TOKEN_FIELD = 'jp.go.nta.houjin_bangou.framework.web.common.CNSFWTokenProcessor.request.token';
const USER_AGENT = 'eigyo1-ingest/0.1 (internal sales list builder)';

/** 画面に用意されている 3 つの形式。 */
export type FileFormat = 'csv-sjis' | 'csv-unicode' | 'xml-unicode';

export const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県',
  '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県',
  '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
] as const;

/** 地域の指定。全国 1 本か、都道府県名か、国外。 */
export type Region = '全国' | '国外' | (typeof PREFECTURES)[number];

const REGION_LABELS: readonly string[] = ['全国', '国外', ...PREFECTURES];

export interface Catalog {
  token: string;
  cookies: string;
  /** 形式 → 地域 → ファイル番号の並び (東京都のように分割されている場合は複数) */
  files: Record<FileFormat, Map<string, string[]>>;
}

/** 画面を取得し、token と地域ごとのファイル番号を読み取る。 */
export async function fetchCatalog(): Promise<Catalog> {
  const res = await fetch(ZENKEN_URL, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`目録の取得に失敗しました: HTTP ${res.status}`);
  const html = await res.text();

  const tokenMatch = html.match(
    new RegExp(`${TOKEN_FIELD.replace(/\./g, '\\.')}"\\s+value="([^"]+)"`),
  );
  if (!tokenMatch?.[1]) {
    throw new Error('画面から token を読み取れませんでした。画面構成が変わった可能性があります');
  }

  const cookies = res.headers
    .getSetCookie()
    .map((c) => c.split(';', 1)[0])
    .filter((c): c is string => Boolean(c))
    .join('; ');

  return { token: tokenMatch[1], cookies, files: parseSections(html) };
}

/** 形式ごとの区画に切り、区画内で「地域名 → ファイル番号」を出現順に対応づける。 */
function parseSections(html: string): Catalog['files'] {
  const anchors: FileFormat[] = ['csv-sjis', 'csv-unicode', 'xml-unicode'];
  const bounds: Array<{ format: FileFormat; start: number }> = [];
  for (const format of anchors) {
    const idx = html.indexOf(`id="${format}"`);
    if (idx !== -1) bounds.push({ format, start: idx });
  }
  bounds.sort((a, b) => a.start - b.start);

  const files = {
    'csv-sjis': new Map<string, string[]>(),
    'csv-unicode': new Map<string, string[]>(),
    'xml-unicode': new Map<string, string[]>(),
  } satisfies Catalog['files'];

  for (let i = 0; i < bounds.length; i++) {
    const { format, start } = bounds[i]!;
    const end = bounds[i + 1]?.start ?? html.length;
    files[format] = parseRegionFileNumbers(html.slice(start, end));
  }
  return files;
}

/**
 * 区画の HTML を先頭から走査し、地域名とファイル番号を出現順に拾う。
 * ファイル番号は、直前に現れた地域名に属するものとみなす。
 */
function parseRegionFileNumbers(section: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const pattern = new RegExp(`(${REGION_LABELS.join('|')})|doDownload\\((\\d+)\\)`, 'g');
  let current: string | null = null;

  for (const m of section.matchAll(pattern)) {
    const label = m[1];
    const fileNo = m[2];
    if (label) {
      current = label;
    } else if (fileNo && current) {
      const list = map.get(current);
      if (list) list.push(fileNo);
      else map.set(current, [fileNo]);
    }
  }
  return map;
}

/** 目録から 1 地域分のファイル番号を取り出す。 */
export function fileNumbersFor(catalog: Catalog, format: FileFormat, region: Region): string[] {
  const nos = catalog.files[format].get(region);
  if (!nos || nos.length === 0) {
    throw new Error(`目録に見つかりません: format=${format} region=${region}`);
  }
  return nos;
}

export interface DownloadedFile {
  /** content-disposition が示すファイル名。例: 00_zenkoku_all_20260731.zip */
  fileName: string;
  body: ReadableStream<Uint8Array>;
}

/** ファイル番号を指定して zip を要求する。本体は流したまま返す。 */
export async function requestFile(catalog: Catalog, fileNo: string): Promise<DownloadedFile> {
  const body = new URLSearchParams();
  body.set(TOKEN_FIELD, catalog.token);
  body.set('event', 'download');
  body.set('selDlFileNo', fileNo);

  const res = await fetch(POST_URL, {
    method: 'POST',
    headers: {
      'user-agent': USER_AGENT,
      'content-type': 'application/x-www-form-urlencoded',
      referer: ZENKEN_URL,
      ...(catalog.cookies ? { cookie: catalog.cookies } : {}),
    },
    body,
  });

  if (!res.ok) throw new Error(`ダウンロードに失敗しました: HTTP ${res.status} (fileNo=${fileNo})`);
  if (!res.body) throw new Error(`応答に本体がありません (fileNo=${fileNo})`);

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    throw new Error(
      `zip ではなく画面が返りました (fileNo=${fileNo})。token の期限切れの可能性があります`,
    );
  }

  return { fileName: parseFileName(res.headers.get('content-disposition')), body: res.body };
}

/** content-disposition: attachment; filename*=utf-8'jp'00_zenkoku_all_20260731.zip */
function parseFileName(disposition: string | null): string {
  if (!disposition) return 'download.zip';
  const star = disposition.match(/filename\*=[^']*'[^']*'([^;]+)/i);
  if (star?.[1]) return decodeURIComponent(star[1].trim());
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain?.[1]?.trim() ?? 'download.zip';
}

/** ファイル名から基準日を取り出す。例: 00_zenkoku_all_20260731.zip → 2026-07-31 */
export function sourceDateFromFileName(fileName: string): string | null {
  const m = fileName.match(/_(\d{4})(\d{2})(\d{2})\./);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
