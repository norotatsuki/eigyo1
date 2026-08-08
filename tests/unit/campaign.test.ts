import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../src/db/index.ts';
import { checkChannelReady, loadConfig, type OutreachConfig } from '../../src/outreach/config.ts';
import { checkTemplate, render, placeholdersIn, EMAIL_TEMPLATE_SKELETON, type Template } from '../../src/outreach/template.ts';
import { runCampaign, sentToday, varsFor } from '../../src/outreach/campaign.ts';
import { recordOutreach } from '../../src/outreach/gate.ts';
import { addSuppression } from '../../src/outreach/store.ts';
import { searchCompanies } from '../../src/search/query.ts';

const IDENTITY = {
  name: '株式会社テスト送信元',
  address: '東京都港区1-1-1',
  optOutUrl: 'https://example.com/optout',
  inquiryContact: 'info@example.com',
};

const CONFIG: OutreachConfig = {
  identity: IDENTITY,
  form: { senderCompany: '株式会社テスト送信元', senderPerson: '営業 太郎', senderEmail: 's@example.com', senderTel: '03-1234-5678' },
  caps: { form: { perDay: 10, perHour: 5 }, postal: { perDay: 100, perHour: 100 }, email: { perDay: 10, perHour: 5 } },
};

function tmpConfig(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'eigyo-conf-'));
  const p = join(dir, 'outreach.config.json');
  writeFileSync(p, JSON.stringify(body), 'utf8');
  return p;
}

describe('設定の検め', () => {
  it('ファイルが無ければその旨を返す', () => {
    expect(loadConfig('/nonexistent/outreach.config.json').missing[0]).toContain('設定ファイルがありません');
  });

  it('法定表示の 4 項目が欠けていれば挙げる', () => {
    const { missing } = loadConfig(tmpConfig({ identity: { name: 'X' } }));
    expect(missing.join(' ')).toContain('identity.address');
    expect(missing.join(' ')).toContain('identity.optOutUrl');
    expect(missing.join(' ')).toContain('identity.inquiryContact');
    expect(missing.join(' ')).toContain('特定電子メール法');
  });

  it('4 項目が揃えば通る', () => {
    expect(loadConfig(tmpConfig({ identity: IDENTITY })).missing).toEqual([]);
  });

  it('経路ごとに足りないものを挙げる', () => {
    expect(checkChannelReady(CONFIG, 'form')).toEqual([]);
    // メールは送信元と認証情報が要る
    expect(checkChannelReady(CONFIG, 'email').join(' ')).toContain('email.fromAddress');
  });
});

describe('文面の検め', () => {
  it('差し込みを埋める', () => {
    expect(render('{{会社名}} {{宛名}}', { 会社名: '株式会社サンプル', 宛名: 'ご担当者様' }))
      .toBe('株式会社サンプル ご担当者様');
  });

  it('値の無い差し込みは中括弧を残さず空にする', () => {
    // 中括弧が相手に届くのが一番みっともない
    expect(render('{{会社名}}/{{業種}}', { 会社名: 'A' })).toBe('A/');
  });

  it('使っている差し込み名を挙げる', () => {
    expect(placeholdersIn('{{会社名}} {{ 業種 }}')).toEqual(['会社名', '業種']);
  });

  it('メールは法定表示が本文に出ていないと通さない', () => {
    const bad: Template = { name: 'x', channel: 'email', subject: 'ご案内', body: '本文だけ' };
    const r = checkTemplate(bad, CONFIG);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toContain('送信者の名称');
    expect(r.problems.join(' ')).toContain('受信拒否の通知先');
    expect(r.problems.join(' ')).toContain('特定電子メール法 4 条');
  });

  it('ひな形の骨格は法定表示を満たす', () => {
    expect(checkTemplate(EMAIL_TEMPLATE_SKELETON, CONFIG).ok).toBe(true);
  });

  it('フォームには法定表示を求めない (特電法の対象外のため)', () => {
    const t: Template = { name: 'x', channel: 'form', subject: 'ご案内', body: '本文' };
    expect(checkTemplate(t, CONFIG).ok).toBe(true);
  });

  it('知らない差し込み名は拒む', () => {
    const t: Template = { name: 'x', channel: 'form', subject: '{{存在しない}}', body: '本文' };
    expect(checkTemplate(t, CONFIG).problems.join(' ')).toContain('使えない差し込み名');
  });
});

describe('施策の実行', () => {
  let db: Db;
  const FORM_TEMPLATE: Template = {
    name: 'form', channel: 'form',
    subject: 'ご提案', body: '{{会社名}} ご担当者様\n{{自社名}}でございます。',
  };

  function insert(db: Db, n: string, name: string, form: string | null): void {
    db.prepare(
      `INSERT INTO corporations
         (corporate_number, name, kind, pref_name, city_name, street_number, pref_code, city_code,
          post_code, latest, search_excluded, name_normalized, name_core, corp_form, address_full,
          is_active, source_date, ingested_at)
       VALUES (?, ?, 301, '東京都', '港区', '1-1', '13', '103', '1070052', 1, 0, ?, ?, '株式会社', '東京都港区1-1', 1, '2026-07-31', 'now')`,
    ).run(n, name, name, name);
    if (form) {
      db.prepare(
        `INSERT INTO company_profiles (corporate_number, contact_form_url, updated_at) VALUES (?, ?, 'now')`,
      ).run(n, form);
    }
  }

  beforeEach(() => {
    db = openDb(':memory:');
    insert(db, '1000000000001', '株式会社アルファ', 'https://a.example.com/contact');
    insert(db, '1000000000002', '株式会社ブラボー', 'https://b.example.com/contact');
    insert(db, '1000000000003', '株式会社チャーリー', null);
  });

  it('下見では 1 件も送らず、中身を見せる', async () => {
    const r = await runCampaign(db, {}, 'form', FORM_TEMPLATE, CONFIG, { campaign: 'T1' });
    expect(r.live).toBe(false);
    expect(r.sent).toBe(0);
    expect(r.preview?.body).toContain('株式会社アルファ');
    expect(r.preview?.body).toContain('株式会社テスト送信元');
    const sent = db.prepare("SELECT COUNT(*) AS n FROM outreach_log WHERE outcome = 'sent'").get() as { n: number };
    expect(sent.n).toBe(0);
  });

  it('設定が無ければ実行しない', async () => {
    const r = await runCampaign(db, {}, 'form', FORM_TEMPLATE, null, { campaign: 'T1' });
    expect(r.blockers[0]).toContain('設定がありません');
  });

  it('法定表示を欠いたメールの文面では実行しない', async () => {
    const bad: Template = { name: 'x', channel: 'email', subject: 'ご案内', body: '本文だけ' };
    const r = await runCampaign(db, {}, 'email', bad, CONFIG, { campaign: 'T1' });
    expect(r.blockers.join(' ')).toContain('特定電子メール法 4 条');
    expect(r.sent).toBe(0);
  });

  it('ひな形の経路と指定が食い違えば実行しない', async () => {
    const r = await runCampaign(db, {}, 'email', FORM_TEMPLATE, CONFIG, { campaign: 'T1' });
    expect(r.blockers.join(' ')).toContain('ひな形の経路が違います');
  });

  it('除外リストの先は候補にすら上がらない', async () => {
    // 守りは二重。検索の時点で消えるので、ゲートまで届かない
    addSuppression(db, { corporateNumber: '1000000000001', reason: 'opt_out' });
    const r = await runCampaign(db, {}, 'form', FORM_TEMPLATE, CONFIG, { campaign: 'T1' });
    expect(r.candidates).toBe(2);
    expect(r.preview?.body).toContain('株式会社ブラボー'); // 次の候補が先頭になる
    expect(r.preview?.body).not.toContain('アルファ');
  });

  it('営業お断りの先も候補に上がらない', async () => {
    db.prepare("UPDATE company_profiles SET solicitation_refused = 1 WHERE corporate_number = '1000000000001'").run();
    const r = await runCampaign(db, {}, 'form', FORM_TEMPLATE, CONFIG, { campaign: 'T1' });
    expect(r.preview?.body).not.toContain('アルファ');
  });

  it('問い合わせ先が分からない先はゲートで落ちる', async () => {
    // こちらは検索では消えない (郵送なら送れるため)。経路の判定はゲートが行う
    const r = await runCampaign(db, {}, 'form', FORM_TEMPLATE, CONFIG, { campaign: 'T1' });
    expect(r.blockedByReason['no_destination']).toBe(1); // チャーリー
    expect(r.blockedByGate).toBe(1);
  });

  it('同じ相手に二度送らない', async () => {
    recordOutreach(db, { corporateNumber: '1000000000001', channel: 'form', outcome: 'sent' });
    const r = await runCampaign(db, {}, 'form', FORM_TEMPLATE, CONFIG, { campaign: 'T1' });
    expect(r.blockedByReason['already_sent']).toBe(1);
    expect(r.preview?.body).not.toContain('アルファ');
  });

  it('本日の上限に達していれば実行しない', async () => {
    for (let i = 0; i < 10; i++) {
      recordOutreach(db, { corporateNumber: '9000000000000', channel: 'form', outcome: 'sent' });
    }
    const r = await runCampaign(db, {}, 'form', FORM_TEMPLATE, CONFIG, { campaign: 'T1', live: true });
    expect(r.blockers.join(' ')).toContain('本日の上限');
    expect(r.sent).toBe(0);
  });

  it('今日の送信数だけを数える (昨日の分は含めない)', () => {
    const yesterday = new Date(Date.now() - 26 * 3600 * 1000);
    recordOutreach(db, { corporateNumber: '9000000000000', channel: 'form', outcome: 'sent', occurredAt: yesterday });
    recordOutreach(db, { corporateNumber: '9000000000001', channel: 'form', outcome: 'sent' });
    expect(sentToday(db, 'form')).toBe(1);
  });

  it('差し込みの値を会社ごとに組み立てる', () => {
    const row = searchCompanies(db, {}, { limit: 1 })[0]!;
    const vars = varsFor(row, CONFIG);
    expect(vars.会社名).toBe('株式会社アルファ');
    expect(vars.自社名).toBe('株式会社テスト送信元');
    expect(vars.配信停止).toBe('https://example.com/optout');
  });
});

describe('差し込みが埋まらない先には送らない', () => {
  let db: Db;
  const TPL: Template = {
    name: 't', channel: 'form', subject: 'ご提案',
    body: '{{会社名}} ご担当者様\n{{都道府県}}の{{業種}}の皆さまへ、{{自社名}}よりご連絡です。',
  };

  beforeEach(() => {
    db = openDb(':memory:');
    for (const [n, name, ind] of [
      ['1000000000001', '株式会社業種あり', '総合工事業'],
      ['1000000000002', '株式会社業種なし', null],
    ] as const) {
      db.prepare(
        `INSERT INTO corporations
           (corporate_number, name, kind, pref_name, city_name, street_number, pref_code, city_code,
            post_code, latest, search_excluded, name_normalized, name_core, corp_form, address_full,
            is_active, source_date, ingested_at)
         VALUES (?, ?, 301, '東京都', '港区', '1-1', '13', '103', '1070052', 1, 0, ?, ?, '株式会社', '東京都港区1-1', 1, '2026-07-31', 'now')`,
      ).run(n, name, name, name);
      db.prepare(
        `INSERT INTO company_profiles (corporate_number, contact_form_url, industry_code, industry_name, updated_at)
         VALUES (?, 'https://x.example.com/contact', ?, ?, 'now')`,
      ).run(n, ind ? '06' : null, ind);
    }
  });

  it('業種が空の先は候補から外し、理由を挙げる', async () => {
    const r = await runCampaign(db, {}, 'form', TPL, CONFIG, { campaign: 'T' });
    expect(r.emptyPlaceholder).toBe(1);
    expect(Object.keys(r.skipReasons).join(' ')).toContain('業種');
    expect(r.preview?.body).toContain('総合工事業');
    // 壊れた文章が相手に届かないこと
    expect(r.preview?.body).not.toContain('のの');
  });

  it('差し込みを使わない文面なら全件が対象になる', async () => {
    const plain: Template = { name: 't', channel: 'form', subject: 'ご提案', body: '{{会社名}} ご担当者様' };
    const r = await runCampaign(db, {}, 'form', plain, CONFIG, { campaign: 'T' });
    expect(r.emptyPlaceholder).toBe(0);
    expect(r.attempted).toBe(2);
  });
});
