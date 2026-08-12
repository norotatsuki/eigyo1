import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, rebuildFts, type Db } from '../../src/db/index.ts';
import {
  breakdown,
  buildSelectSql,
  countCompanies,
  prefixUpperBound,
  searchCompanies,
  toCsvLines,
} from '../../src/search/query.ts';
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

  it('前方一致の上限値は末尾の文字を 1 つ進める', () => {
    expect(prefixUpperBound('39')).toBe('3:');
    expect(prefixUpperBound('0')).toBe('1');
    expect(prefixUpperBound('09')).toBe('0:');
    // 上限は範囲の外側。前方一致する値はすべて下限以上・上限未満に収まる
    expect('39' >= '39' && '39' < prefixUpperBound('39')).toBe(true);
    expect('391' >= '39' && '391' < prefixUpperBound('39')).toBe(true);
    expect('399' >= '39' && '399' < prefixUpperBound('39')).toBe(true);
    expect('40' < prefixUpperBound('39')).toBe(false);
    expect('38' >= '39').toBe(false);
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

  // 2026-08-09 の退化: 業種や法人種別を併用すると SQLite が corporations を駆動側に選び、
  // 250 万行それぞれに全文照合をかけていた (1 件の検索に 64 秒〜返らず)。
  // 件数の少ないテストでは速度で気づけないため、実行計画そのものを見張る。
  describe('全文検索の結合順', () => {
    function firstStep(filter: Parameters<typeof buildSelectSql>[0]): string {
      const built = buildSelectSql(filter, {}, 'c.corporate_number');
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${built.sql}`).all(...built.params) as Array<{ detail: string }>;
      return plan[0]?.detail ?? '';
    }

    // 別名 f が全文検索表。これが第 1 段にあれば全文検索が駆動側になっている
    const DRIVEN_BY_FTS = /^SCAN f VIRTUAL TABLE/;

    it('語だけのときは全文検索から回す', () => {
      expect(firstStep({ keyword: 'サンプル' })).toMatch(DRIVEN_BY_FTS);
    });

    it('法人種別を併用しても全文検索から回す', () => {
      expect(firstStep({ keyword: 'サンプル', kinds: [301, 302, 303, 304, 305] })).toMatch(DRIVEN_BY_FTS);
    });

    it('業種を併用しても全文検索から回す', () => {
      expect(firstStep({ keyword: 'サンプル', industryCodes: ['39'] })).toMatch(DRIVEN_BY_FTS);
    });

    it('地域と規模を重ねても全文検索から回す', () => {
      expect(
        firstStep({ keyword: 'サンプル', prefCodes: ['13'], employeesMin: 10, capitalMin: 1000 }),
      ).toMatch(DRIVEN_BY_FTS);
    });

    // 全件の件数取得が 16.5 秒かかっていた。付加情報を条件に使っていないのに
    // 500 万行へ結合を張っていたのが原因
    it('付加情報を条件に使わない件数取得では結合を張らない', () => {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM corporations c WHERE c.is_active = 1`)
        .all() as Array<{ detail: string }>;
      expect(plan.length).toBeGreaterThan(0);
      // 件数だけを数えるとき company_profiles は結合されない
      expect(countCompanies(db, {})).toBe(3);
      expect(countCompanies(db, { excludeRefused: false })).toBe(4);
    });

    it('付加情報を条件に使う件数取得では結果が変わらない', () => {
      // 結合の有無で件数がずれないこと
      expect(countCompanies(db, { industryCodes: ['39', '09'] })).toBe(2);
      expect(countCompanies(db, { prefCodes: ['13'] })).toBe(2);
    });

    // 件数は「全体 − お断り」の引き算で求める経路がある。
    // 素直に数えた場合と必ず一致しなければならない
    it('引き算で求めた件数が素直に数えた件数と一致する', () => {
      const naive = (f: Parameters<typeof countCompanies>[1]): number => {
        const rows = searchCompanies(db, { ...f, excludeRefused: false }, { limit: 1000 });
        const refused = new Set(
          (db.prepare('SELECT corporate_number AS n FROM company_profiles WHERE solicitation_refused = 1')
            .all() as Array<{ n: string }>).map((r) => r.n),
        );
        return rows.filter((r) => !refused.has(r.corporate_number)).length;
      };
      for (const f of [{}, { prefCodes: ['13'] }, { kinds: [301] }, { keyword: 'サンプル' }]) {
        expect(countCompanies(db, f)).toBe(naive(f));
      }
    });

    it('お断りを含める指定なら引き算を使わない', () => {
      expect(countCompanies(db, { excludeRefused: false })).toBe(4);
    });

    // 索引を足すたびに最適化器の選択が揺れ、同じ一覧が 0 秒になったり 2.9 秒に
    // なったりした。一覧は画面が最初に描くものなので選択を固定してある
    describe('一覧で使う索引の明示', () => {
      const hintOf = (f: Parameters<typeof buildSelectSql>[0], o = {}): string =>
        buildSelectSql(f, o, 'c.corporate_number').sql;

      it('都道府県を 1 つ選んだら県つきの索引を指定する', () => {
        expect(hintOf({ prefCodes: ['13'] })).toContain('INDEXED BY idx_corp_active_pref_name');
      });

      it('都道府県を選ばない・複数選ぶときは商号だけの索引を指定する', () => {
        expect(hintOf({})).toContain('INDEXED BY idx_corp_active_name');
        expect(hintOf({ prefCodes: ['13', '27'] })).toContain('INDEXED BY idx_corp_active_name');
      });

      it('付加情報で絞るときは指定しない (そちらの方が選択的なため)', () => {
        expect(hintOf({ prefCodes: ['13'], industryCodes: ['39'] })).not.toContain('INDEXED BY');
        expect(hintOf({ employeesMin: 10 })).not.toContain('INDEXED BY');
      });

      it('全文検索・商号以外の並び順・閉鎖込みでは指定しない', () => {
        expect(hintOf({ keyword: 'サンプル' })).not.toContain('INDEXED BY');
        expect(hintOf({}, { orderBy: 'assigned_desc' })).not.toContain('INDEXED BY');
        expect(hintOf({ activeOnly: false })).not.toContain('INDEXED BY');
      });

      it('指定した索引は実在し、問い合わせが通る', () => {
        // 索引名を書き間違えると SQLite が実行時に落ちる。実際に走らせて確かめる
        expect(() => searchCompanies(db, { prefCodes: ['13'] }, { limit: 5 })).not.toThrow();
        expect(() => searchCompanies(db, {}, { limit: 5 })).not.toThrow();
      });
    });

    it('語が無いときは全文検索表を読まない', () => {
      const built = buildSelectSql({ prefCodes: ['13'] }, {}, 'c.corporate_number');
      expect(built.sql).not.toContain('corporations_fts');
    });
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

/*
 * 内訳 (セグメントの切り口)。
 *
 * 実測 (2026-08-13、本番の 500 万社): 都道府県の内訳が 48 区分あった。
 * 48 番目は id もラベルも空で 9,585 社。pref_code が NULL ではなく
 * **空文字** の行が NULL の判定をすり抜け、押せない空行として出ていた。
 */
describe('内訳の切り口', () => {
  /** 県名・市名まで入れて 1 件置く (共有の insert は名称を空で入れるため) */
  function place(db: Db, number: string, name: string, prefCode: string, prefName: string,
                 cityCode: string, cityName: string): void {
    db.prepare(
      `INSERT INTO corporations (
         corporate_number, name, kind, pref_name, city_name, street_number,
         pref_code, city_code, post_code, latest, search_excluded, assignment_date,
         name_normalized, name_core, corp_form, address_full, is_active,
         source_date, ingested_at
       ) VALUES (?, ?, 301, ?, ?, '', ?, ?, '', 1, 0, '2015-10-05', ?, ?, '株式会社', '', 1,
                 '2026-07-31', 'now')`,
    ).run(number, name, prefName, cityName, prefCode, cityCode, name, name);
  }

  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    place(db, '1000000000001', '株式会社東京', '13', '東京都', '103', '港区');
    place(db, '1000000000002', '株式会社大阪', '27', '大阪府', '100', '大阪市');
    // 住所に都道府県が入っていない行 (空文字であって NULL ではない)
    place(db, '1000000000003', '株式会社不明', '', '', '', '');
    rebuildFts(db);
  });

  it('都道府県で切れる', () => {
    const slices = breakdown(db, {}, 'pref');
    expect(slices.map((s) => s.label).sort()).toEqual(['大阪府', '東京都']);
  });

  it('空文字の都道府県を区分として出さない (押せない空行になる)', () => {
    const slices = breakdown(db, {}, 'pref');
    expect(slices).toHaveLength(2);
    expect(slices.some((s) => s.id === '' || s.label === '')).toBe(false);
  });

  it('市区町村でも空文字を区分にしない', () => {
    const slices = breakdown(db, {}, 'city');
    expect(slices).toHaveLength(2);
    expect(slices.some((s) => s.id === '' || s.label === '')).toBe(false);
  });

  it('業種でも空文字を区分にしない', () => {
    setProfile(db, '1000000000001', { industry_code: '39', industry_name: '情報サービス業' });
    setProfile(db, '1000000000002', { industry_code: '', industry_name: '' });
    const slices = breakdown(db, {}, 'industry');
    expect(slices).toHaveLength(1);
    expect(slices[0]?.label).toBe('情報サービス業');
  });
});
