/**
 * Common Crawl のドメイン一覧から企業サイトを集める。
 *
 * 索引 (index.commoncrawl.org) はページ単位で引けるが、混雑すると
 * 502/504 を返し、応答そのものが返らないこともある
 * (実測 2026-08-09: 空の応答を返し続け、発見が 28 分間 1 件も進まなかった)。
 *
 * こちらは配信側 (data.commoncrawl.org) に置かれた 1 本のファイルで、
 * 巡回で見つかった全ドメインが入っている。索引の 1153 ページを
 * 1 枚ずつ引くより速く、取りこぼしもない。
 *
 * 形式は tab 区切り。ドメインは逆順で書かれる (`jp.co.example`)。
 *   #harmonicc_pos  #harmonicc_val  #pr_pos  #pr_val  #host_rev  #n_hosts
 *   1  3.2465568E7  3  0.0124878  com.facebook  3668
 */
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import type { Db } from '../../db/index.ts';

export const SOURCE = 'commoncrawl-domains';

/** 一覧の版。data.commoncrawl.org に置かれている名前。 */
export const DEFAULT_EDITION = 'cc-main-2025-may-jun-jul';

const BASE = 'https://data.commoncrawl.org/projects/hyperlinkgraph';

export function editionUrl(edition: string): string {
  return `${BASE}/${edition}/domain/${edition}-domain-ranks.txt.gz`;
}

/**
 * 逆順のドメインを普通の並びに戻す。
 *
 * `jp.co.example` → `example.co.jp`
 * 数値だけの見出し行や、区切りの無い行は取らない。
 */
export function unreverse(hostRev: string): string | null {
  const parts = hostRev.split('.');
  if (parts.length < 2) return null;
  return parts.reverse().join('.');
}

/** 1 行を読み、対象の接尾辞に当てはまるホスト名を返す。 */
export function hostFromLine(line: string, suffix: string): string | null {
  if (line.length === 0 || line.startsWith('#')) return null;
  const rev = line.split('\t')[4];
  if (!rev) return null;

  // 逆順のまま接尾辞を判定する。`.co.jp` なら `jp.co.` で始まる行
  const suffixLabels = suffix.replace(/^\./, '').split('.').reverse();
  if (!rev.startsWith(`${suffixLabels.join('.')}.`)) return null;
  // 接尾辞そのもの (`jp.co`) だけの行は会社ではない
  if (rev.split('.').length <= suffixLabels.length) return null;

  return unreverse(rev);
}

export interface DomainDiscoverOptions {
  edition?: string;
  /** 集める接尾辞。既定は日本の会社用ドメイン */
  suffix?: string;
  /** 上限。試すときに使う */
  limit?: number;
  onProgress?: (read: number, found: number, inserted: number) => void;
}

export interface DomainDiscoverResult {
  edition: string;
  suffix: string;
  linesRead: number;
  found: number;
  inserted: number;
  totalHosts: number;
}

/**
 * 一覧を流し読みしながら web_hosts に積む。
 *
 * ファイルは 2 GB あるので、手元には置かず流したまま絞り込む。
 * 何度実行しても同じ結果になる (既にある先は入れ直さない)。
 */
export async function discoverFromDomainList(
  db: Db,
  options: DomainDiscoverOptions = {},
): Promise<DomainDiscoverResult> {
  const edition = options.edition ?? DEFAULT_EDITION;
  const suffix = options.suffix ?? '.co.jp';
  const url = editionUrl(edition);

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`ドメイン一覧を取得できません: HTTP ${res.status} ${url}`);

  const lines = createInterface({
    input: Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]).pipe(createGunzip()),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  const insert = db.prepare(
    `INSERT INTO web_hosts (host, source, discovered_at) VALUES (?, ?, ?)
     ON CONFLICT(host) DO NOTHING`,
  );
  const flush = db.transaction((batch: readonly string[], at: string) => {
    let n = 0;
    for (const h of batch) n += insert.run(h, SOURCE, at).changes;
    return n;
  });

  const result: DomainDiscoverResult = {
    edition, suffix, linesRead: 0, found: 0, inserted: 0, totalHosts: 0,
  };
  let batch: string[] = [];
  const now = new Date().toISOString();

  for await (const line of lines) {
    result.linesRead++;
    const host = hostFromLine(line, suffix);
    if (host) {
      result.found++;
      batch.push(host);
      if (batch.length >= 5_000) {
        result.inserted += flush(batch, now);
        batch = [];
        options.onProgress?.(result.linesRead, result.found, result.inserted);
      }
    }
    if (options.limit && result.found >= options.limit) break;
  }
  if (batch.length > 0) result.inserted += flush(batch, now);

  // 途中で切り上げた場合、流し終えていない本体を捨てる
  lines.close();

  result.totalHosts = (db.prepare('SELECT COUNT(*) AS n FROM web_hosts').get() as { n: number }).n;
  return result;
}
