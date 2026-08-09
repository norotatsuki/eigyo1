import { describe, expect, it } from 'vitest';
import { appearsIn, keepGrounded, looksLikeEmail, looksLikeTel, looksLikeUrl, normalizeForMatch } from '../../src/enrich/llm/grounding.ts';
import { classifyWithLlm, extractWithLlm, trimForLlm } from '../../src/enrich/llm/extract.ts';
import { emptyUsage, estimateCost, roughTokens, type Llm, type LlmResult } from '../../src/enrich/llm/client.ts';

/** 決まった答えを返す偽の LLM。嘘をつかせる場面を作るために使う。 */
function fakeLlm(answer: unknown): Llm {
  return {
    askJson: async <T>(): Promise<LlmResult<T>> => ({
      value: answer as T,
      usage: { promptTokens: 100, completionTokens: 20, calls: 1 },
    }),
  };
}

const SITE_TEXT = `株式会社サンプル建設
〒680-0011 鳥取県鳥取市東町2-223
TEL 0857-12-3456
お問い合わせは info@sample-kensetsu.co.jp まで
当社は総合建設業として地域に根ざしています。`;

describe('照合のための正規化', () => {
  it('全角半角と空白と横棒を揃える', () => {
    expect(normalizeForMatch('０８５７－１２－３４５６')).toBe('0857-12-3456');
    expect(normalizeForMatch('鳥取県 鳥取市')).toBe('鳥取県鳥取市');
    expect(normalizeForMatch('ＡＢＣ')).toBe('abc');
  });

  it('書き方が違っても同じものと見なす', () => {
    expect(appearsIn('0857-12-3456', 'TEL ０８５７－１２－３４５６')).toBe(true);
    expect(appearsIn('〒680-0011', '〒６８０－００１１ 鳥取県')).toBe(true);
  });

  it('原文に無いものは無いと言う', () => {
    expect(appearsIn('0120-999-999', SITE_TEXT)).toBe(false);
  });
});

describe('接地の検証 — LLM が作った値を捨てる', () => {
  it('原文にある値は残す', () => {
    const { grounded, rejected } = keepGrounded(
      { name: '株式会社サンプル建設', tel: '0857-12-3456' },
      SITE_TEXT,
      ['name', 'tel'],
    );
    expect(grounded.name).toBe('株式会社サンプル建設');
    expect(grounded.tel).toBe('0857-12-3456');
    expect(rejected).toEqual([]);
  });

  it('原文に無い値は捨てて理由を残す', () => {
    const { grounded, rejected } = keepGrounded(
      { name: '株式会社サンプル建設', email: 'ceo@sample-kensetsu.co.jp' }, // それらしいが本文に無い
      SITE_TEXT,
      ['name', 'email'],
    );
    expect(grounded.name).toBe('株式会社サンプル建設');
    expect(grounded.email).toBeUndefined();
    expect(rejected[0]?.field).toBe('email');
    expect(rejected[0]?.reason).toContain('原文に見当たらない');
  });

  it('空や null は検証の対象にしない', () => {
    const { grounded, rejected } = keepGrounded({ name: null, tel: '' }, SITE_TEXT, ['name', 'tel']);
    expect(Object.keys(grounded)).toEqual([]);
    expect(rejected).toEqual([]);
  });
});

describe('形の検め', () => {
  it('メールアドレスらしさ', () => {
    expect(looksLikeEmail('info@example.co.jp')).toBe(true);
    expect(looksLikeEmail('info@example')).toBe(false);
    expect(looksLikeEmail('お問い合わせフォームより')).toBe(false);
  });

  it('電話番号らしさ', () => {
    expect(looksLikeTel('0857-12-3456')).toBe(true);
    expect(looksLikeTel('090-1234-5678')).toBe(true);
    expect(looksLikeTel('123')).toBe(false);
  });

  it('URL らしさ', () => {
    expect(looksLikeUrl('https://example.co.jp')).toBe(true);
    expect(looksLikeUrl('example.co.jp')).toBe(false);
  });
});

describe('サイトの抽出', () => {
  it('原文どおりの答えはそのまま採る', async () => {
    const llm = fakeLlm({
      name: '株式会社サンプル建設',
      address: '〒680-0011 鳥取県鳥取市東町2-223',
      tel: '0857-12-3456',
      email: 'info@sample-kensetsu.co.jp',
    });
    const r = await extractWithLlm(llm, SITE_TEXT);
    expect(r.extracted.name).toBe('株式会社サンプル建設');
    expect(r.extracted.email).toBe('info@sample-kensetsu.co.jp');
    expect(r.rejected).toEqual([]);
  });

  it('作られたメールアドレスは採らない', async () => {
    // ここが要。もっともらしいが本文に無いアドレス
    const llm = fakeLlm({ name: '株式会社サンプル建設', email: 'info@sample-kensetsu.com' });
    const r = await extractWithLlm(llm, SITE_TEXT);
    expect(r.extracted.name).toBe('株式会社サンプル建設');
    expect(r.extracted.email).toBeUndefined();
    expect(r.rejected.some((x) => x.field === 'email')).toBe(true);
  });

  it('作られた電話番号は採らない', async () => {
    const llm = fakeLlm({ tel: '03-0000-0000' });
    const r = await extractWithLlm(llm, SITE_TEXT);
    expect(r.extracted.tel).toBeUndefined();
    expect(r.rejected[0]?.field).toBe('tel');
  });

  it('形が崩れた値は採らない', async () => {
    // 本文に「お問い合わせ」はあるが、メールアドレスではない
    const llm = fakeLlm({ email: 'お問い合わせ' });
    const r = await extractWithLlm(llm, SITE_TEXT);
    expect(r.extracted.email).toBeUndefined();
  });

  it('答えが返らなくても落ちない', async () => {
    const llm: Llm = { askJson: async () => ({ value: null, usage: emptyUsage(), error: '応答が空です' }) };
    const r = await extractWithLlm(llm, SITE_TEXT);
    expect(r.extracted).toEqual({});
    expect(r.error).toBe('応答が空です');
  });

  it('本文が長すぎるときは切り詰める (費用がかさむため)', () => {
    // 目印が無ければ前半をそのまま使う
    expect(trimForLlm('あ'.repeat(9000)).length).toBe(1500);
  });

  it('会社情報の周辺だけを抜き出す (費用が 1/3 になる)', () => {
    const noise = 'ど'.repeat(3000);
    const text = `${noise}会社概要 株式会社サンプル 〒100-0001 東京都千代田区 TEL 03-1234-5678${noise}`;
    const out = trimForLlm(text);
    expect(out).toContain('株式会社サンプル');
    expect(out).toContain('03-1234-5678');
    expect(out.length).toBeLessThan(1600);
    // 無関係な部分を丸ごと持って行かないこと
    expect(out.split('ど').length - 1).toBeLessThan(400);
  });
});

describe('業種の分類', () => {
  it('一覧にあるコードは採る', async () => {
    const r = await classifyWithLlm(fakeLlm({ code: '06', confidence: 0.9, reason: '建設業' }), '株式会社山田建設');
    expect(r.code).toBe('06');
    expect(r.name).toBe('総合工事業');
    expect(r.confidence).toBe(0.9);
  });

  it('一覧に無いコードは採らない (作られた番号を弾く)', async () => {
    const r = await classifyWithLlm(fakeLlm({ code: '999', confidence: 0.95, reason: '' }), '株式会社謎');
    expect(r.code).toBeNull();
    expect(r.reason).toContain('一覧に無いコード');
  });

  it('判断がつかないときは null を通す', async () => {
    const r = await classifyWithLlm(fakeLlm({ code: null, confidence: 0, reason: '情報不足' }), '株式会社さくら');
    expect(r.code).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it('確信度は 0-1 に収める', async () => {
    const r = await classifyWithLlm(fakeLlm({ code: '06', confidence: 5, reason: '' }), '株式会社建設');
    expect(r.confidence).toBe(1);
  });
});

describe('費用の見積もり', () => {
  it('使用量と単価から金額を出す', () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 500_000, calls: 1000 };
    const cost = estimateCost(usage, { inputPerMillion: 0.15, outputPerMillion: 0.6, currency: 'USD' });
    expect(cost).toBeCloseTo(0.15 + 0.3, 5);
  });

  it('文字数からおおよそのトークン数を見る', () => {
    expect(roughTokens('あ'.repeat(1000))).toBe(900);
  });
});
