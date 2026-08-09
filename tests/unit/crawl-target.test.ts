import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/index.ts';
import { crawlPendingHosts } from '../../src/enrich/site/crawl.ts';

/** 送れる先を n 件だけ入れておく。 */
function seed(db: Db, reachable: number, pendingHosts: number): void {
  for (let i = 0; i < reachable; i++) {
    const n = String(1_000_000_000_000 + i);
    // company_profiles は corporations を参照するので、先に法人を入れる
    db.prepare(
      `INSERT INTO corporations
         (corporate_number, name, kind, pref_name, city_name, street_number, pref_code, city_code,
          post_code, latest, search_excluded, name_normalized, name_core, corp_form, address_full,
          is_active, source_date, ingested_at)
       VALUES (?, ?, 301, '東京都', '港区', '1-1', '13', '103', '1070052', 1, 0, ?, ?, '株式会社',
               '東京都港区1-1', 1, '2026-07-31', 'now')`,
    ).run(n, `株式会社テスト${i}`, `株式会社テスト${i}`, `テスト${i}`);
    db.prepare(
      `INSERT INTO company_profiles (corporate_number, contact_email, updated_at)
       VALUES (?, ?, 'now')`,
    ).run(n, `info${i}@example.co.jp`);
  }
  for (let i = 0; i < pendingHosts; i++) {
    db.prepare("INSERT INTO web_hosts (host, source, discovered_at) VALUES (?, 'test', 'now')")
      .run(`h${i}.co.jp`);
  }
}

describe('目標件数で止める', () => {
  it('達していれば 1 件も訪ねない', async () => {
    const db = openDb(':memory:');
    seed(db, 5, 10);
    const r = await crawlPendingHosts(db, { limit: 10, target: 5 });
    expect(r.stoppedAtTarget).toBe(true);
    expect(r.visited).toBe(0); // 相手に無駄な要求を出さない
    expect(r.qualified).toBe(5);
  });

  it('達していなければ訪ねる', async () => {
    const db = openDb(':memory:');
    seed(db, 2, 1);
    // 実在しないホストなので失敗するが、訪ねたこと自体は数える
    const r = await crawlPendingHosts(db, { limit: 1, target: 100, delayMs: 0 });
    expect(r.stoppedAtTarget).toBe(false);
    expect(r.visited).toBe(1);
  });

  it('目標を指定しなければ数えない', async () => {
    const db = openDb(':memory:');
    seed(db, 5, 0);
    const r = await crawlPendingHosts(db, { limit: 1 });
    expect(r.stoppedAtTarget).toBe(false);
    expect(r.qualified).toBe(0);
  });
});
