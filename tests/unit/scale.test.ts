import { describe, expect, it } from 'vitest';
import { extractScale, formatAmount, parseHeadcount, parseJapaneseAmount } from '../../src/enrich/site/scale.ts';

describe('金額の読み取り', () => {
  // 実データで見た書かれ方
  it('円まで書かれた数字', () => {
    expect(parseJapaneseAmount('3,000,000円')).toBe(3_000_000);
    expect(parseJapaneseAmount('100,000,000円')).toBe(100_000_000);
  });

  it('万・億の単位', () => {
    expect(parseJapaneseAmount('1,000万円')).toBe(10_000_000);
    expect(parseJapaneseAmount('9,500万円')).toBe(95_000_000);
    expect(parseJapaneseAmount('3,800 万円')).toBe(38_000_000);
  });

  it('億と万が混ざる書き方', () => {
    // 「30億220万円」は 30億 + 220万 であって 30億2200万ではない
    expect(parseJapaneseAmount('30億220万円')).toBe(3_002_200_000);
    expect(parseJapaneseAmount('1億円')).toBe(100_000_000);
  });

  it('全角の数字', () => {
    expect(parseJapaneseAmount('１，０００万円')).toBe(10_000_000);
  });

  it('金額と読めないものは取らない', () => {
    expect(parseJapaneseAmount('非公開')).toBeNull();
    expect(parseJapaneseAmount('—')).toBeNull();
    expect(parseJapaneseAmount('2026年')).toBeNull(); // 年号を金額にしない
  });
});

describe('人数の読み取り', () => {
  it('名でも人でも読む', () => {
    expect(parseHeadcount('70名（2026年4月現在）')).toBe(70);
    expect(parseHeadcount('従業員12名')).toBe(12);
    expect(parseHeadcount('約150人')).toBe(150);
    expect(parseHeadcount('1,200名')).toBe(1200);
  });

  it('人数と読めないものは取らない', () => {
    expect(parseHeadcount('非公開')).toBeNull();
    expect(parseHeadcount('熊本エリア')).toBeNull();
  });
});

describe('会社概要からの規模の取り出し', () => {
  it('実データの並びから 3 つとも取る', () => {
    const text = '代表者 加藤 憲造 従業員数 従業員12名 資本金 9,500万円 売上高 30億220万円（2025年度実績）';
    const s = extractScale(text);
    expect(s.employees).toBe(12);
    expect(s.capital).toBe(95_000_000);
    expect(s.revenue).toBe(3_002_200_000);
  });

  it('資本金だけの会社概要', () => {
    const s = extractScale('設立 2022年3月9日 資本金 3,000,000円 事業内容 学習動画オンライン配信');
    expect(s.capital).toBe(3_000_000);
    expect(s.employees).toBeNull();
    expect(s.revenue).toBeNull();
  });

  it('資本金を売上高と取り違えない', () => {
    // 桁が違うものを混ぜると、300万円の会社が売上300万円に見える
    const s = extractScale('資本金 3,000,000円');
    expect(s.capital).toBe(3_000_000);
    expect(s.revenue).toBeNull();
  });

  it('売上高が資本金より小さすぎる場合は採らない', () => {
    // 「売上 50万円」は書き間違いか別の意味。規模の判断に使えない
    expect(extractScale('売上高 50万円').revenue).toBeNull();
  });

  it('記載が無ければ全て null', () => {
    const s = extractScale('当社は地域に根ざした企業です。お気軽にお問い合わせください。');
    expect(s).toEqual({ capital: null, employees: null, revenue: null });
  });

  it('年号を人数として拾わない', () => {
    expect(extractScale('設立 1956年7月 代表者 竹下 裕助').employees).toBeNull();
  });
});

describe('金額の表示', () => {
  it('桁に応じて読みやすくする', () => {
    expect(formatAmount(3_002_200_000)).toBe('30.0億円');
    expect(formatAmount(100_000_000)).toBe('1億円');
    expect(formatAmount(95_000_000)).toBe('9,500万円');
    expect(formatAmount(3_000_000)).toBe('300万円');
  });
});
