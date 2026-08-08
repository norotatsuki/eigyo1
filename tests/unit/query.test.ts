import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, rebuildFts, type Db } from '../../src/db/index.ts';
import { countCompanies, searchCompanies, toCsvLines } from '../../src/search/query.ts';
import { normalizeCompanyName } from '../../src/normalize/company-name.ts';

interface Seed {
  number: string;
  name: string;
  prefCode: string;
  cityCode?: string;
  kind?: number;
  active?: boolean;
  assigned?: string;
}

function insert(db: Db, s: Seed): void {
  const { normalized, core, corpForm } = normalizeCompanyName(s.name);
  db.prepare(
    `INSERT INTO corporations (
       corporate_number, name, kind, pref_name, city_name, street_number,
       pref_code, city_code, post_code, latest, search_excluded, assignment_date,
       name_normalized, name_core, corp_form, address_full, is_active,
       source_date, ingested_at
     ) VALUES (?, ?, ?, '', '', '', ?, ?, '', 1, 0, ?, ?, ?, ?, '', ?, '2026-07-31', 'now')`,
  ).run(
    s.number, s.name, s.kind ?? 301, s.prefCode, s.cityCode ?? '100',
    s.assigned ?? '2015-10-05', normalized, core, corpForm, (s.active ?? true) ? 1 : 0,
  );
}

function setProfile(db: Db, number: string, p: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO company_profiles
       (corporate_number, industry_code, industry_name, capital, employees,
        website_url, solicitation_refused, updated_at)
     VALUES (@n, @industry_code, @industry_name, @capital, @employees,
             @website_url, @refused, 'now')`,
  ).run({
    n: number,
    industry_code: p['industry_code'] ?? null,
    industry_name: p['industry_name'] ?? null,
    capital: p['capital'] ?? null,
    employees: p['employees'] ?? null,
    website_url: p['website_url'] ?? null,
    refused: p['refused'] ?? 0,
  });
}

describe('絞り込み検索', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    insert(db, { number: '1000000000001', name: '株式会社サンプル商事', prefCode: '13' });
    insert(db, { number: '1000000000002', name: '合同会社テスト製作所', prefCode: '13', cityCode: '104' });
    insert(db, { number: '1000000000003', name: '株式会社大阪工業', prefCode: '27' });
    insert(db, { number: '1000000000004', name: '株式会社閉鎖済', prefCode: '13', active: false });
    insert(db, { number: '1000000000005', name: '鳥取市役所', prefCode: '31', kind: 201 });
    rebuildFts(db);

    setProfile(db, '1000000000001', {
      industry_code: '391', industry_name: 'ソフトウェア業', capital: 10_000_000,
      employees: 50, website_url: 'https://example.co.jp',
    });
    setProfile(db, '1000000000002', { industry_code: '091', capital: 3_000_000, employees: 5 });
    setProfile(db, '1000000000003', { refused: 1 });
  });

  it('既定では閉鎖済みの法人を含めない', () => {
    expect(countCompanies(db, {})).toBe(3); // 5件 - 閉鎖1 - お断り1
  });

  it('include-inactive 相当で閉鎖済みも数える', () => {
    expect(countCompanies(db, { activeOnly: false, excludeRefused: false })).toBe(5);
  });

  it('既定で営業お断りの先を落とす', () => {
    const names = searchCompanies(db, {}).map((r) => r.name);
    expect(names).not.toContain('株式会社大阪工業');
    expect(searchCompanies(db, { excludeRefused: false }).map((r) => r.name))
      .toContain('株式会社大阪工業');
  });

  it('都道府県コードで絞り込む', () => {
    expect(countCompanies(db, { prefCodes: ['13'] })).toBe(2);
    expect(countCompanies(db, { prefCodes: ['13', '31'] })).toBe(3);
  });

  it('法人種別で絞り込む', () => {
    expect(countCompanies(db, { kinds: [301] })).toBe(2);
    expect(countCompanies(db, { kinds: [201] })).toBe(1);
  });

  it('法人格で絞り込む', () => {
    expect(countCompanies(db, { corpForms: ['合同会社'] })).toBe(1);
  });

  it('業種コードは前方一致で照合し、中分類の指定を許す', () => {
    expect(countCompanies(db, { industryCodes: ['391'] })).toBe(1);
    expect(countCompanies(db, { industryCodes: ['39'] })).toBe(1);
    expect(countCompanies(db, { industryCodes: ['09'] })).toBe(1);
    expect(countCompanies(db, { industryCodes: ['39', '09'] })).toBe(2);
  });

  it('業種の確信度の下限で絞り込む', () => {
    db.prepare("UPDATE company_profiles SET industry_confidence = 0.5 WHERE corporate_number = '1000000000002'").run();
    db.prepare("UPDATE company_profiles SET industry_confidence = 0.9 WHERE corporate_number = '1000000000001'").run();
    expect(countCompanies(db, { industryMinConfidence: 0.7 })).toBe(1);
    expect(countCompanies(db, { industryMinConfidence: 0.4 })).toBe(2);
  });

  it('資本金と従業員数の下限で絞り込む', () => {
    expect(countCompanies(db, { capitalMin: 5_000_000 })).toBe(1);
    expect(countCompanies(db, { employeesMin: 10 })).toBe(1);
    expect(countCompanies(db, { employeesMin: 1 })).toBe(2);
  });

  it('サイトが判明している先だけに絞る', () => {
    expect(countCompanies(db, { hasWebsite: true })).toBe(1);
  });

  it('3 文字以上の語は全文検索で部分一致する', () => {
    const rows = searchCompanies(db, { keyword: 'サンプル' });
    expect(rows.map((r) => r.name)).toEqual(['株式会社サンプル商事']);
  });

  it('2 文字の語でも照合できる', () => {
    const rows = searchCompanies(db, { keyword: '製作' });
    expect(rows.map((r) => r.name)).toEqual(['合同会社テスト製作所']);
  });

  it('半角の検索語で全角英数の商号に当たる', () => {
    insert(db, { number: '1000000000007', name: '株式会社ＡＩシステム開発', prefCode: '13' });
    rebuildFts(db);
    expect(searchCompanies(db, { keyword: 'AIシステム' }).map((r) => r.name))
      .toEqual(['株式会社ＡＩシステム開発']);
    // 全角で打っても同じ結果になる
    expect(searchCompanies(db, { keyword: 'ＡＩシステム' }).map((r) => r.name))
      .toEqual(['株式会社ＡＩシステム開発']);
  });

  it('条件を重ねると積み上げで絞られる', () => {
    expect(countCompanies(db, { prefCodes: ['13'], corpForms: ['株式会社'] })).toBe(1);
    expect(countCompanies(db, { prefCodes: ['13'], corpForms: ['株式会社'], employeesMin: 100 })).toBe(0);
  });

  it('書き出しは見出し行と本体行を返す', () => {
    const lines = [...toCsvLines(searchCompanies(db, { prefCodes: ['13'] }))];
    expect(lines[0]).toContain('法人番号');
    expect(lines).toHaveLength(3); // 見出し + 2 件
  });

  it('書き出しで区切り文字を含む値を引用符で囲む', () => {
    insert(db, { number: '1000000000006', name: '株式会社A,B', prefCode: '40' });
    const lines = [...toCsvLines(searchCompanies(db, { prefCodes: ['40'] }))];
    expect(lines[1]).toContain('"株式会社A,B"');
  });
});
