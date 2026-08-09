import { describe, expect, it } from 'vitest';
import { withWholeCities } from '../../src/web/server.ts';

describe('政令指定都市をまとめて選べるようにする', () => {
  const yokohama = [
    { code: '101', label: '横浜市鶴見区', count: 10541 },
    { code: '102', label: '横浜市神奈川区', count: 11686 },
    { code: '201', label: '藤沢市', count: 8000 },
  ];

  it('区を束ねた見出しを先に置く', () => {
    const out = withWholeCities(yokohama);
    expect(out[0]).toEqual({ code: '101,102', label: '横浜市 (全2区)', count: 22227 });
  });

  it('区ごとの選択肢も残す', () => {
    const labels = withWholeCities(yokohama).map((c) => c.label);
    expect(labels).toContain('横浜市鶴見区');
    expect(labels).toContain('横浜市神奈川区');
  });

  it('区の無い市はそのまま', () => {
    const out = withWholeCities(yokohama);
    expect(out.filter((c) => c.label === '藤沢市')).toHaveLength(1);
  });

  it('区が 1 つしかなければ束ねない', () => {
    const one = [{ code: '301', label: '仙台市青葉区', count: 100 }];
    expect(withWholeCities(one).map((c) => c.label)).toEqual(['仙台市青葉区']);
  });
});
