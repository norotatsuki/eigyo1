import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/index.ts';
import { applyGate, checkSendable, recordOutreach } from '../../src/outreach/gate.ts';
import { addSuppression, saveSegment, getSegment, listSegments, deleteSegment, countSuppressions, summarizeOutreach } from '../../src/outreach/store.ts';
import { countCompanies, searchCompanies } from '../../src/search/query.ts';

const NOW = new Date('2026-08-09T00:00:00.000Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

function insertCompany(db: Db, number: string, name: string, address = '東京都港区1-1-1'): void {
  db.prepare(
    `INSERT INTO corporations
       (corporate_number, name, kind, pref_name, city_name, street_number,
        pref_code, city_code, post_code, latest, search_excluded,
        name_normalized, name_core, corp_form, address_full, is_active, source_date, ingested_at)
     VALUES (?, ?, 301, '東京都', '港区', '1-1-1', '13', '103', '1070052', 1, 0, ?, ?, '株式会社', ?, 1, '2026-07-31', 'now')`,
  ).run(number, name, name, name, address);
}

function setProfile(db: Db, number: string, p: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO company_profiles
       (corporate_number, contact_email, contact_form_url, solicitation_refused, updated_at)
     VALUES (?, ?, ?, ?, 'now')
     ON CONFLICT(corporate_number) DO UPDATE SET
       contact_email = excluded.contact_email,
       contact_form_url = excluded.contact_form_url,
       solicitation_refused = excluded.solicitation_refused`,
  ).run(number, p['email'] ?? null, p['form'] ?? null, p['refused'] ?? 0);
}

const A = '1000000000001';
const B = '1000000000002';
const C = '1000000000003';
const D = '1000000000004';

describe('送信前ゲート', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    insertCompany(db, A, '株式会社アルファ');
    insertCompany(db, B, '株式会社ブラボー');
    insertCompany(db, C, '株式会社チャーリー');
    insertCompany(db, D, '株式会社デルタ');
  });

  it('除外リストに載っている先は止める', () => {
    addSuppression(db, { corporateNumber: B, reason: 'opt_out', note: '受信拒否の連絡あり' });
    const d = checkSendable(db, [A, B], 'postal', { now: NOW });
    expect(d[0]!.allowed).toBe(true);
    expect(d[1]!.allowed).toBe(false);
    expect(d[1]!.reason).toBe('suppressed');
    expect(d[1]!.detail).toBe('opt_out');
  });

  it('営業お断りを検出した先は止める', () => {
    setProfile(db, C, { refused: 1 });
    const d = checkSendable(db, [C], 'postal', { now: NOW });
    expect(d[0]!.reason).toBe('refused');
  });

  it('問い合わせフォームは 1 社 1 回まで', () => {
    setProfile(db, A, { form: 'https://example.com/contact' });
    expect(checkSendable(db, [A], 'form', { now: NOW })[0]!.allowed).toBe(true);

    recordOutreach(db, { corporateNumber: A, channel: 'form', outcome: 'sent', occurredAt: daysAgo(900) });
    const d = checkSendable(db, [A], 'form', { now: NOW })[0]!;
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('already_sent');
  });

  it('郵送とメールは冷却期間で判定する', () => {
    recordOutreach(db, { corporateNumber: A, channel: 'postal', outcome: 'sent', occurredAt: daysAgo(30) });
    expect(checkSendable(db, [A], 'postal', { now: NOW })[0]!.reason).toBe('cooling');

    recordOutreach(db, { corporateNumber: B, channel: 'postal', outcome: 'sent', occurredAt: daysAgo(120) });
    expect(checkSendable(db, [B], 'postal', { now: NOW })[0]!.allowed).toBe(true);
  });

  it('経路が違えば冷却は独立している', () => {
    setProfile(db, A, { email: 'info@example.com' });
    recordOutreach(db, { corporateNumber: A, channel: 'postal', outcome: 'sent', occurredAt: daysAgo(1) });
    expect(checkSendable(db, [A], 'postal', { now: NOW })[0]!.allowed).toBe(false);
    expect(checkSendable(db, [A], 'email', { now: NOW })[0]!.allowed).toBe(true);
  });

  it('止められた記録は冷却の起点にしない', () => {
    // 止めた記録まで数えると、一度止まった先へ永遠に送れなくなる
    recordOutreach(db, {
      corporateNumber: A, channel: 'postal', outcome: 'blocked',
      blockedReason: 'cooling', occurredAt: daysAgo(1),
    });
    expect(checkSendable(db, [A], 'postal', { now: NOW })[0]!.allowed).toBe(true);
  });

  it('宛先が分からない先は止める', () => {
    // メールは宛先が要る。プロフィール未取得なら送れない
    expect(checkSendable(db, [A], 'email', { now: NOW })[0]!.reason).toBe('no_destination');
    setProfile(db, A, { email: 'info@example.com' });
    expect(checkSendable(db, [A], 'email', { now: NOW })[0]!.allowed).toBe(true);
  });

  it('郵送は所在地さえあれば送れる', () => {
    // 国税庁の全件データに所在地は必ず入っているので、郵送だけは全社に届く
    expect(checkSendable(db, [A, B, C, D], 'postal', { now: NOW }).every((d) => d.allowed)).toBe(true);
  });

  it('判定の順序は 除外 → お断り → 送付済み → 冷却 → 宛先 で固定する', () => {
    // すべてに当てはまる先では、最も重い理由が返る
    addSuppression(db, { corporateNumber: A, reason: 'customer' });
    setProfile(db, A, { refused: 1 });
    recordOutreach(db, { corporateNumber: A, channel: 'postal', outcome: 'sent', occurredAt: daysAgo(1) });
    expect(checkSendable(db, [A], 'postal', { now: NOW })[0]!.reason).toBe('suppressed');
  });

  it('候補が多くても分割して照会する', () => {
    // 変数の上限を超える件数でも落ちないこと
    const many: string[] = [];
    for (let i = 0; i < 2500; i++) {
      const n = `2${String(i).padStart(12, '0')}`;
      insertCompany(db, n, `株式会社テスト${i}`);
      many.push(n);
    }
    addSuppression(db, { corporateNumber: many[1500]!, reason: 'competitor' });
    const d = checkSendable(db, many, 'postal', { now: NOW });
    expect(d).toHaveLength(2500);
    expect(d.filter((x) => !x.allowed)).toHaveLength(1);
    expect(d[1500]!.reason).toBe('suppressed');
  });
});

describe('applyGate', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    insertCompany(db, A, '株式会社アルファ');
    insertCompany(db, B, '株式会社ブラボー');
    insertCompany(db, C, '株式会社チャーリー');
    addSuppression(db, { corporateNumber: B, reason: 'opt_out' });
    setProfile(db, C, { refused: 1 });
  });

  it('送ってよい先だけを返す', () => {
    const r = applyGate(db, [A, B, C], 'postal', { now: NOW, campaign: '2026夏DM' });
    expect(r.allowed).toEqual([A]);
    expect(r.blocked).toHaveLength(2);
    expect(r.blockedByReason).toEqual({ suppressed: 1, refused: 1 });
  });

  it('止めた判断を記録に残す', () => {
    // 止めた事実が残らないと「なぜ送っていないのか」を後から説明できない
    applyGate(db, [A, B, C], 'postal', { now: NOW, campaign: '2026夏DM' });
    const rows = db
      .prepare("SELECT corporate_number AS n, blocked_reason AS r, campaign FROM outreach_log WHERE outcome = 'blocked' ORDER BY n")
      .all() as Array<{ n: string; r: string; campaign: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.n).toBe(B);
    expect(rows[0]!.r).toContain('suppressed');
    expect(rows[0]!.campaign).toBe('2026夏DM');
    expect(rows[1]!.r).toBe('refused');
  });

  it('送った分は呼び出し側が記録する (ゲートは勝手に送ったことにしない)', () => {
    const r = applyGate(db, [A, B, C], 'postal', { now: NOW });
    const sent = db.prepare("SELECT COUNT(*) AS n FROM outreach_log WHERE outcome = 'sent'").get() as { n: number };
    expect(sent.n).toBe(0);
    for (const n of r.allowed) recordOutreach(db, { corporateNumber: n, channel: 'postal', outcome: 'sent' });
    const after = db.prepare("SELECT COUNT(*) AS n FROM outreach_log WHERE outcome = 'sent'").get() as { n: number };
    expect(after.n).toBe(1);
  });

  it('二度流しても同じ先には送らない', () => {
    const first = applyGate(db, [A, B, C], 'postal', { now: NOW });
    for (const n of first.allowed) {
      recordOutreach(db, { corporateNumber: n, channel: 'postal', outcome: 'sent', occurredAt: NOW });
    }
    const second = applyGate(db, [A, B, C], 'postal', { now: NOW });
    expect(second.allowed).toEqual([]);
    expect(second.blockedByReason['cooling']).toBe(1);
  });
});

describe('除外リストと検索の連携', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    insertCompany(db, A, '株式会社アルファ');
    insertCompany(db, B, '株式会社ブラボー');
    insertCompany(db, C, '株式会社チャーリー');
  });

  it('除外リストに積んだ先は検索から消える', () => {
    expect(countCompanies(db, {})).toBe(3);
    addSuppression(db, { corporateNumber: B, reason: 'customer' });
    expect(countCompanies(db, {})).toBe(2);
    expect(searchCompanies(db, {}).map((r) => r.corporate_number)).not.toContain(B);
  });

  it('お断りと除外の両方に載っていても二重に引かない', () => {
    addSuppression(db, { corporateNumber: B, reason: 'refused' });
    setProfile(db, B, { refused: 1 });
    expect(countCompanies(db, {})).toBe(2);
  });

  it('件数と一覧の件数が食い違わない', () => {
    addSuppression(db, { corporateNumber: A, reason: 'opt_out' });
    setProfile(db, C, { refused: 1 });
    expect(countCompanies(db, {})).toBe(searchCompanies(db, {}, { limit: 100 }).length);
  });

  it('明示すれば除外を外して見られる', () => {
    addSuppression(db, { corporateNumber: B, reason: 'customer' });
    expect(countCompanies(db, { excludeRefused: false })).toBe(3);
  });
});

describe('除外リストと保存した条件', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('同じ法人を積み直すと理由が上書きされる', () => {
    addSuppression(db, { corporateNumber: A, reason: 'manual' });
    addSuppression(db, { corporateNumber: A, reason: 'opt_out', note: '拒否の申し出' });
    const rows = countSuppressions(db);
    expect(rows).toEqual([{ reason: 'opt_out', count: 1 }]);
  });

  it('条件に名前を付けて残せる', () => {
    saveSegment(db, '東京都のIT企業', { prefCodes: ['13'], industryCodes: ['39'] }, '主力の切り口');
    const s = getSegment(db, '東京都のIT企業');
    expect(s?.filter.prefCodes).toEqual(['13']);
    expect(s?.note).toBe('主力の切り口');
    expect(listSegments(db)).toHaveLength(1);

    saveSegment(db, '東京都のIT企業', { prefCodes: ['13', '14'] });
    expect(getSegment(db, '東京都のIT企業')?.filter.prefCodes).toEqual(['13', '14']);
    expect(listSegments(db)).toHaveLength(1);

    expect(deleteSegment(db, '東京都のIT企業')).toBe(true);
    expect(listSegments(db)).toHaveLength(0);
  });

  it('接触の内訳を集計できる', () => {
    insertCompany(db, A, '株式会社アルファ');
    recordOutreach(db, { corporateNumber: A, channel: 'postal', outcome: 'sent', campaign: 'DM1' });
    recordOutreach(db, { corporateNumber: A, channel: 'postal', outcome: 'replied', campaign: 'DM1' });
    expect(summarizeOutreach(db, 'DM1')).toEqual(
      expect.arrayContaining([
        { channel: 'postal', outcome: 'sent', count: 1 },
        { channel: 'postal', outcome: 'replied', count: 1 },
      ]),
    );
  });
});
