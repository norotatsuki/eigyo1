import { describe, expect, it } from 'vitest';
import {
  estimateEmployees, estimateRevenue, formatYen, scaleWithEstimates,
} from '../../src/enrich/estimate.ts';

describe('従業員数の推定', () => {
  it('資本金の帯ごとの中央値を返す', () => {
    expect(estimateEmployees(5_000_000)?.value).toBe(14);
    expect(estimateEmployees(30_000_000)?.value).toBe(45);
    expect(estimateEmployees(100_000_000)?.value).toBe(130);
    expect(estimateEmployees(1_000_000_000)?.value).toBe(266);
  });

  it('何を根拠にしたかを添える', () => {
    expect(estimateEmployees(30_000_000)?.basis).toContain('実測 n=1250');
  });

  // 何も無いところから数字を作らない
  it('資本金が分からなければ推定しない', () => {
    expect(estimateEmployees(null)).toBeNull();
    expect(estimateEmployees(0)).toBeNull();
  });
});

describe('年商の推定', () => {
  it('従業員数に一人当たり売上高を掛ける', () => {
    expect(estimateRevenue(10)?.value).toBe(297_000_000);
  });

  it('元が推定なら、推定の推定であることを隠さない', () => {
    expect(estimateRevenue(10, false)?.compounded).toBe(false);
    expect(estimateRevenue(10, true)?.compounded).toBe(true);
    expect(estimateRevenue(10, true)?.basis).toContain('推定従業員数');
  });

  it('従業員数が分からなければ推定しない', () => {
    expect(estimateRevenue(null)).toBeNull();
  });
});

describe('実測と推定の使い分け', () => {
  it('実測値があれば推定しない', () => {
    const s = scaleWithEstimates(30_000_000, 7, 500_000_000);
    expect(s.employees).toEqual({ value: 7, estimated: false });
    expect(s.revenue).toEqual({ value: 500_000_000, estimated: false });
  });

  it('従業員数が実測なら、年商はその実測値から推定する', () => {
    const s = scaleWithEstimates(30_000_000, 7, null);
    expect(s.employees?.estimated).toBe(false);
    expect(s.revenue?.estimated).toBe(true);
    expect(s.revenue?.value).toBe(7 * 29_700_000);
    // 元が実測なので、推定の推定ではない
    expect(s.revenue && 'compounded' in s.revenue && s.revenue.compounded).toBe(false);
  });

  it('資本金しか無ければ、従業員数も年商も推定になる', () => {
    const s = scaleWithEstimates(30_000_000, null, null);
    expect(s.employees?.estimated).toBe(true);
    expect(s.revenue?.estimated).toBe(true);
    expect(s.revenue && 'compounded' in s.revenue && s.revenue.compounded).toBe(true);
  });

  it('何も無ければ何も出さない', () => {
    expect(scaleWithEstimates(null, null, null)).toEqual({ employees: null, revenue: null });
  });
});

describe('金額の書き方', () => {
  it('億・万で短く書く', () => {
    expect(formatYen(1_200_000_000)).toBe('12億円');
    expect(formatYen(150_000_000)).toBe('1.5億円');
    expect(formatYen(30_000_000)).toBe('3,000万円');
    expect(formatYen(5_000)).toBe('5,000円');
  });
});
