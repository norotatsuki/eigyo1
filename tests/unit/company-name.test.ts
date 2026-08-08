import { describe, expect, it } from 'vitest';
import { normalizeCompanyName } from '../../src/normalize/company-name.ts';

describe('normalizeCompanyName', () => {
  it('丸括弧つきの略記を法人格に展開する', () => {
    expect(normalizeCompanyName('㈱サンプル商事').normalized).toBe('株式会社サンプル商事');
    expect(normalizeCompanyName('(株)サンプル商事').normalized).toBe('株式会社サンプル商事');
    expect(normalizeCompanyName('（株）サンプル商事').normalized).toBe('株式会社サンプル商事');
  });

  it('前株と後株のどちらでも中核名を同じに揃える', () => {
    const mae = normalizeCompanyName('株式会社サンプル商事');
    const ato = normalizeCompanyName('サンプル商事株式会社');
    expect(mae.core).toBe('サンプル商事');
    expect(ato.core).toBe('サンプル商事');
    expect(mae.corpForm).toBe('株式会社');
    expect(ato.corpForm).toBe('株式会社');
  });

  it('全角英数を半角に揃える', () => {
    expect(normalizeCompanyName('株式会社ＡＢＣ１２３').normalized).toBe('株式会社ABC123');
  });

  it('照合キーでは記号と空白を落とす', () => {
    expect(normalizeCompanyName('株式会社 エヌ・ティ・ティ').core).toBe('エヌティティ');
    expect(normalizeCompanyName('株式会社A-B_C').core).toBe('abc');
  });

  it('照合キーでは異体字を統一するが、表示名は変えない', () => {
    const a = normalizeCompanyName('株式会社髙橋商店');
    const b = normalizeCompanyName('株式会社高橋商店');
    expect(a.core).toBe(b.core);
    expect(a.normalized).toBe('株式会社髙橋商店'); // 正式表記は保つ
  });

  it('長い法人格を短い法人格より先に切り出す', () => {
    expect(normalizeCompanyName('一般社団法人サンプル協会').corpForm).toBe('一般社団法人');
    expect(normalizeCompanyName('医療法人社団サンプル会').corpForm).toBe('医療法人社団');
    expect(normalizeCompanyName('特定非営利活動法人サンプル').corpForm).toBe('特定非営利活動法人');
  });

  it('法人格しかない商号でも照合キーを空にしない', () => {
    const r = normalizeCompanyName('協同組合');
    expect(r.core.length).toBeGreaterThan(0);
  });

  it('法人格が無い名称はそのまま扱う', () => {
    const r = normalizeCompanyName('鳥取簡易裁判所');
    expect(r.corpForm).toBeNull();
    expect(r.core).toBe('鳥取簡易裁判所');
  });
});
