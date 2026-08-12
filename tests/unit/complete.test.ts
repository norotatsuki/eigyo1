import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/index.ts';
import { requeueIncomplete, requeueStale, runToCompletion } from '../../src/pipeline/complete.ts';

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

describe('項目が欠けている先を掘り直す対象に戻す', () => {
  /** 5 項目を指定して 1 件入れる。null にした項目が「欠けている」 */
  function withFields(
    db: Db,
    name: string,
    f: { email?: string; form?: string; rep?: string; sns?: string; tel?: string },
  ): void {
    db.prepare(
      `INSERT INTO web_hosts
         (host, source, discovered_at, crawl_status, corporate_number,
          site_email, contact_url, site_representative, social_links, site_tel)
       VALUES (?, 'test', 'now', 'ok', '1000000000001', ?, ?, ?, ?, ?)`,
    ).run(name, f.email ?? null, f.form ?? null, f.rep ?? null, f.sns ?? null, f.tel ?? null);
  }
  const full = {
    email: 'info@example.co.jp',
    form: 'https://example.co.jp/contact',
    rep: '山田太郎',
    sns: '{"x":"https://x.com/example"}',
    tel: '03-0000-0000',
  };
  const status = (db: Db, h: string): string =>
    (db.prepare('SELECT crawl_status AS s FROM web_hosts WHERE host = ?').get(h) as { s: string }).s;

  it('問い合わせフォームだけ欠けている先も戻す', () => {
    // 実測 (2026-08-12): 他の 4 項目が揃っていてフォームだけ無い先が 656 件あり、
    // 条件に無いため一度も掘り直されずに残っていた
    const db = openDb(':memory:');
    withFields(db, 'form-missing.co.jp', { ...full, form: undefined });
    expect(requeueIncomplete(db)).toBe(1);
    expect(status(db, 'form-missing.co.jp')).toBe('pending');
  });

  it('メール・SNS が欠けている先も戻す', () => {
    const db = openDb(':memory:');
    withFields(db, 'mail-missing.co.jp', { ...full, email: undefined });
    withFields(db, 'sns-missing.co.jp', { ...full, sns: undefined });
    expect(requeueIncomplete(db)).toBe(2);
  });

  it('5 項目が揃っている先は戻さない (何度も訪ねない)', () => {
    const db = openDb(':memory:');
    withFields(db, 'complete.co.jp', full);
    expect(requeueIncomplete(db)).toBe(0);
    expect(status(db, 'complete.co.jp')).toBe('ok');
  });

  it('法人に紐付いていない先は、掘っても宛先にならないので戻さない', () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO web_hosts (host, source, discovered_at, crawl_status, corporate_number)
       VALUES ('unmatched.co.jp', 'test', 'now', 'ok', NULL)`,
    ).run();
    expect(requeueIncomplete(db)).toBe(0);
  });

  it('繋がらなかった先は対象外 (再挑戦の段が別に見る)', () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO web_hosts (host, source, discovered_at, crawl_status, corporate_number)
       VALUES ('dead.co.jp', 'test', 'now', 'failed', '1000000000001')`,
    ).run();
    expect(requeueIncomplete(db)).toBe(0);
    expect(status(db, 'dead.co.jp')).toBe('failed');
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
