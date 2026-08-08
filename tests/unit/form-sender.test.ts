import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '@playwright/test';
import { openBrowser, sendToForm, valueForField, valuesFrom, type FormField } from '../../src/outreach/form-sender.ts';
import { startTestFormServer, type TestFormServer } from '../fixtures/test-form-server.ts';

const VALUES = valuesFrom(
  {
    senderCompany: '株式会社テスト送信元',
    senderPerson: '営業 太郎',
    senderEmail: 'sales@example.com',
    senderTel: '03-1234-5678',
  },
  'ご提案のご連絡',
  'はじめまして。ご提案のご連絡でございます。',
);

describe('valueForField', () => {
  const f = (kind: FormField['kind']): FormField =>
    ({ selector: 'x', kind, tag: 'input', type: 'text', required: false, label: '' });

  it('欄の意味に応じた値を返す', () => {
    expect(valueForField(f('company'), VALUES)).toBe('株式会社テスト送信元');
    expect(valueForField(f('person'), VALUES)).toBe('営業 太郎');
    expect(valueForField(f('email'), VALUES)).toBe('sales@example.com');
    expect(valueForField(f('email_confirm'), VALUES)).toBe('sales@example.com');
    expect(valueForField(f('message'), VALUES)).toContain('ご提案');
  });

  it('意味が分からない欄には何も入れない', () => {
    expect(valueForField(f('unknown'), VALUES)).toBeNull();
    expect(valueForField(f('address'), VALUES)).toBeNull();
  });
});

describe('フォーム送信 (手元に立てた試験用フォームに対して実際に送る)', () => {
  let server: TestFormServer;
  let browser: Browser;

  beforeAll(async () => {
    server = await startTestFormServer();
    browser = await openBrowser();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it('素直なフォームの欄を正しく読み取る', async () => {
    const { analysis } = await sendToForm(browser, `${server.url}/plain`, VALUES);
    expect(analysis?.found).toBe(true);
    expect(analysis?.hasCaptcha).toBe(false);
    const kinds = Object.fromEntries((analysis?.fields ?? []).map((f) => [f.selector, f.kind]));
    expect(kinds['[name="company"]']).toBe('company');
    expect(kinds['[name="yourname"]']).toBe('person');
    expect(kinds['[name="email"]']).toBe('email');
    expect(kinds['[name="email_confirm"]']).toBe('email_confirm');
    expect(kinds['[name="tel"]']).toBe('tel');
    expect(kinds['[name="message"]']).toBe('message');
  }, 60_000);

  it('下見では送信ボタンを押さない', async () => {
    const before = server.received.length;
    const { outcome } = await sendToForm(browser, `${server.url}/plain`, VALUES);
    expect(outcome.status).toBe('skipped');
    expect(server.received.length).toBe(before);
  }, 60_000);

  it('live を指定したときだけ実際に送る', async () => {
    const before = server.received.length;
    const { outcome } = await sendToForm(browser, `${server.url}/plain`, VALUES, { live: true });
    expect(outcome.status).toBe('sent');
    expect(server.received.length).toBe(before + 1);

    const got = server.received.at(-1)!.fields;
    expect(got['company']).toBe('株式会社テスト送信元');
    expect(got['yourname']).toBe('営業 太郎');
    expect(got['email']).toBe('sales@example.com');
    expect(got['email_confirm']).toBe('sales@example.com');
    expect(got['tel']).toBe('03-1234-5678');
    expect(got['message']).toContain('ご提案');
    // 必須の同意にも印が付いていること (付いていないと相手側で弾かれる)
    expect(got['agree']).toBeDefined();
  }, 60_000);

  it('CAPTCHA があれば送らない (突破しない)', async () => {
    const before = server.received.length;
    const { outcome, analysis } = await sendToForm(browser, `${server.url}/captcha`, VALUES, { live: true });
    expect(outcome.status).toBe('skipped');
    expect(outcome.status === 'skipped' && outcome.reason).toContain('CAPTCHA');
    expect(analysis?.hasCaptcha).toBe(true);
    expect(server.received.length).toBe(before); // 1 件も届いていないこと
  }, 60_000);

  it('意味を判じられない必須欄があれば送らない', async () => {
    const before = server.received.length;
    const { outcome } = await sendToForm(browser, `${server.url}/odd`, VALUES, { live: true });
    expect(outcome.status).toBe('skipped');
    expect(outcome.status === 'skipped' && outcome.reason).toContain('必須欄');
    expect(server.received.length).toBe(before);
  }, 60_000);

  it('開けないページは失敗として返す', async () => {
    const { outcome } = await sendToForm(browser, `${server.url}/not-exist`, VALUES, { live: true });
    expect(outcome.status).toBe('failed');
  }, 60_000);
});
