import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/index.ts';
import { requeueStale, runToCompletion } from '../../src/pipeline/complete.ts';

function host(db: Db, name: string, status: string, sources: string | null = null): void {
  db.prepare(
    `INSERT INTO web_hosts (host, source, discovered_at, crawl_status, field_sources)
     VALUES (?, 'test', 'now', ?, ?)`,
  ).run(name, status, sources);
}

describe('古い抽出のまま集めた先を訪ね直す', () => {
  it('出典が入っていない先だけを戻す', () => {
    const db = openDb(':memory:');
    host(db, 'old.co.jp', 'ok', null);            // 抽出を足す前に集めた
    host(db, 'new.co.jp', 'ok', '{"name":"x"}');  // 足した後に集めた
    host(db, 'dead.co.jp', 'failed', null);       // 繋がらなかった先は対象外

    expect(requeueStale(db)).toBe(1);
    const status = (h: string): string =>
      (db.prepare('SELECT crawl_status AS s FROM web_hosts WHERE host = ?').get(h) as { s: string }).s;
    expect(status('old.co.jp')).toBe('pending');
    expect(status('new.co.jp')).toBe('ok');
    expect(status('dead.co.jp')).toBe('failed');
  });
});

describe('完了まで回す', () => {
  it('目標に達していれば何も訪ねない', async () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO corporations
         (corporate_number, name, kind, pref_name, city_name, street_number, pref_code, city_code,
          post_code, latest, search_excluded, name_normalized, name_core, corp_form, address_full,
          is_active, source_date, ingested_at)
       VALUES ('1000000000001', 'あ', 301, '東京都', '港区', '1-1', '13', '103', '1000001', 1, 0,
               'あ', 'あ', '株式会社', '東京都港区1-1', 1, '2026-07-31', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO company_profiles (corporate_number, contact_email, updated_at)
       VALUES ('1000000000001', 'info@example.co.jp', 'now')`,
    ).run();
    host(db, 'a.co.jp', 'pending');

    const r = await runToCompletion(db, { target: 1, batchSize: 10 });
    expect(r.stoppedAtTarget).toBe(true);
    expect(r.visited).toBe(0);
  });

  it('訪ねる先が無ければ後処理だけ走る', async () => {
    const db = openDb(':memory:');
    const r = await runToCompletion(db, { revisit: false });
    expect(r.visited).toBe(0);
    expect(r.stoppedAtTarget).toBe(false);
    expect(r.qualified).toBe(0);
  });
});
