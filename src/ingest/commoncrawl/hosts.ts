/**
 * Common Crawl の索引から企業サイトのホスト名を集める。
 *
 * 国税庁のデータに URL は無く、gBizINFO はトークンが要る。
 * 一方 Common Crawl の索引は公開・無料で、`*.co.jp` を引けば
 * 実在する日本企業のサイトが列挙できる (実測 2026-08-09: 1153 ページ /
 * 1 ページあたり固有ホスト 187 前後 / 全体で 21 万ホスト前後)。
 *
 * ここで集めるのはホスト名だけ。中身の収集は src/enrich/site/ が行う。
 */
import type { Db } from '../../db/index.ts';

const INDEX_BASE = 'https://index.commoncrawl.org';
const USER_AGENT = 'eigyo1-host-discovery/0.1 (internal sales list builder)';
export const SOURCE = 'commoncrawl';

/** 索引の版。混雑時に 504 を返すことがあるため、動く版を選べるようにする。 */
export const DEFAULT_COLLECTION = 'CC-MAIN-2025-05';
export const DEFAULT_PATTERN = '*.co.jp';

/** URL からホスト名を取り出す。www は落として揃える。 */
export function hostOf(url: string): string | null {
  const afterScheme = url.split('//', 2)[1] ?? url;
  const host = (afterScheme.split('/', 1)[0] ?? '').toLowerCase().split(':', 1)[0] ?? '';
  const bare = host.startsWith('www.') ? host.slice(4) : host;
  return bare.includes('.') ? bare : null;
}

/** 索引の 1 ページ分の本文から、条件に合うホスト名を集める。 */
export function hostsFromIndexPage(body: string, suffix: string): Set<string> {
  const hosts = new Set<string>();
  for (const line of body.split('\n')) {
    if (line.length === 0) continue;
    let url: string;
    try {
      url = (JSON.parse(line) as { url?: string }).url ?? '';
    } catch {
      continue; // 索引が稀に壊れた行を返す。1 行落ちても支障はない
    }
    const host = hostOf(url);
    if (host && host.endsWith(suffix)) hosts.add(host);
  }
  return hosts;
}

export interface DiscoverOptions {
  collection?: string;
  pattern?: string;
  /** 取得するページ数。索引全体は 1153 ページある */
  pages?: number;
  /** 何ページ目から始めるか。未指定なら未取得の続きから */
  fromPage?: number;
  /** 要求の間隔 (ミリ秒)。公開サービスに負荷をかけない */
  delayMs?: number;
  onProgress?: (page: number, hostsFound: number, totalHosts: number) => void;
}

export interface DiscoverResult {
  collection: string;
  pattern: string;
  pagesFetched: number;
  hostsInserted: number;
  totalHosts: number;
  failures: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 索引のページ総数を尋ねる。 */
export async function fetchPageCount(collection: string, pattern: string): Promise<number> {
  const url = `${INDEX_BASE}/${collection}-index?url=${encodeURIComponent(pattern)}&output=json&showNumPages=true`;
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`索引のページ数を取得できません: HTTP ${res.status}`);
  const body = (await res.json()) as { pages?: number };
  if (typeof body.pages !== 'number') throw new Error('索引の応答にページ数がありません');
  return body.pages;
}

/**
 * ホスト名を集めて web_hosts に積む。
 *
 * 取得済みのページは host_discovery_pages に記録し、次回はその続きから始める。
 * 1153 ページを一度に取る必要はなく、何回かに分けて構わない。
 */
export async function discoverHosts(db: Db, options: DiscoverOptions = {}): Promise<DiscoverResult> {
  const collection = options.collection ?? DEFAULT_COLLECTION;
  const pattern = options.pattern ?? DEFAULT_PATTERN;
  const suffix = pattern.replace(/^\*\./, '.');
  const pages = options.pages ?? 10;
  const delayMs = options.delayMs ?? 1000;

  const done = new Set(
    (
      db
        .prepare(
          'SELECT page FROM host_discovery_pages WHERE source = ? AND collection = ? AND pattern = ?',
        )
        .all(SOURCE, collection, pattern) as Array<{ page: number }>
    ).map((r) => r.page),
  );

  const insertHost = db.prepare(
    `INSERT INTO web_hosts (host, source, discovered_at) VALUES (?, ?, ?)
     ON CONFLICT(host) DO NOTHING`,
  );
  const markPage = db.prepare(
    `INSERT INTO host_discovery_pages (source, collection, pattern, page, hosts_found, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, collection, pattern, page) DO UPDATE SET
       hosts_found = excluded.hosts_found, fetched_at = excluded.fetched_at`,
  );
  const writeBatch = db.transaction((hosts: Set<string>, page: number, at: string) => {
    let inserted = 0;
    for (const h of hosts) inserted += insertHost.run(h, SOURCE, at).changes;
    markPage.run(SOURCE, collection, pattern, page, hosts.size, at);
    return inserted;
  });

  let pagesFetched = 0;
  let hostsInserted = 0;
  let failures = 0;
  let page = options.fromPage ?? 0;

  while (pagesFetched < pages) {
    if (done.has(page)) {
      page++;
      continue;
    }
    const url = `${INDEX_BASE}/${collection}-index?url=${encodeURIComponent(pattern)}&output=json&page=${page}`;
    try {
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      // 混雑時は本文が HTML のエラーページになる。JSON でなければ失敗として扱う
      if (!body.startsWith('{')) throw new Error('索引が JSON を返しませんでした (混雑の可能性)');

      const hosts = hostsFromIndexPage(body, suffix);
      const inserted = writeBatch(hosts, page, new Date().toISOString());
      hostsInserted += inserted;
      pagesFetched++;
      options.onProgress?.(page, hosts.size, hostsInserted);
    } catch (err) {
      failures++;
      process.stderr.write(
        `[発見] ページ ${page} を飛ばします: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      // 連続して失敗するなら索引側の問題。無限に叩かない
      if (failures >= 5 && pagesFetched === 0) break;
    }
    page++;
    await sleep(delayMs);
  }

  const total = db.prepare('SELECT COUNT(*) AS n FROM web_hosts').get() as { n: number };
  return { collection, pattern, pagesFetched, hostsInserted, totalHosts: total.n, failures };
}
