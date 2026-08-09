import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, rebuildFts, type Db } from '../../src/db/index.ts';
import { toProfile, enrichFromGbiz, importFromSearch, SOURCE } from '../../src/ingest/gbizinfo/ingest.ts';
import type { GbizClient, GbizHojin, GbizResult, GbizSearch } from '../../src/ingest/gbizinfo/client.ts';
import { countCompanies, searchCompanies } from '../../src/search/query.ts';
import { classifyAll } from '../../src/enrich/industry/classify.ts';

/** 決まった答えを返す偽の口。 */
function fakeClient(
  details: Record<string, GbizHojin>,
  searchPages: GbizHojin[][] = [],
): GbizClient {
  let page = 0;
  return {
    detail: async (n: string): Promise<GbizResult<GbizHojin>> => ({
      value: details[n] ?? null,
      status: 200,
    }),
    search: async (_p: GbizSearch): Promise<GbizResult<GbizHojin[]>> => ({
      value: searchPages[page++] ?? [],
      status: 200,
    }),
  } as unknown as GbizClient;
}

function insert(db: Db, n: string, name: string): void {
  db.prepare(
    `INSERT INTO corporations
       (corporate_number, name, kind, pref_name, city_name, street_number, pref_code, city_code,
        post_code, latest, search_excluded, name_normalized, name_core, corp_form, address_full,
        is_active, source_date, ingested_at)
     VALUES (?, ?, 301, '東京都', '港区', '1-1', '13', '103', '1070052', 1, 0, ?, ?, '株式会社', '東京都港区1-1', 1, '2026-07-31', 'now')`,
  ).run(n, name, name, name);
}

const A = '1000000000001';
const B = '1000000000002';

describe('gBizINFO の項目を手元の形に移す', () => {
  it('資本金・従業員数・URL・設立日を取る', () => {
    const p = toProfile({
      capital_stock: 740_000_000,
      employee_number: 51,
      company_url: 'https://example.co.jp/',
      date_of_establishment: '2003-05-01',
    });
    expect(p).toEqual({
      capital: 740_000_000, employees: 51,
      url: 'https://example.co.jp/', founded: '2003-05-01',
    });
  });

  it('創業年しか無ければ年初として扱う', () => {
    expect(toProfile({ founding_year: 1956 }).founded).toBe('1956-01-01');
  });

  it('0 や空は入っていないものとして扱う', () => {
    const p = toProfile({ capital_stock: 0, employee_number: 0, company_url: '' });
    expect(p).toEqual({ capital: null, employees: null, url: null, founded: null });
  });

  it('URL でないものは採らない', () => {
    expect(toProfile({ company_url: '準備中' }).url).toBeNull();
  });
});

describe('照会による補完', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    insert(db, A, '株式会社アルファ');
    insert(db, B, '株式会社ブラボー');
  });

  it('値が入っている先だけを取り込む', async () => {
    const client = fakeClient({
      [A]: { corporate_number: A, capital_stock: 100_000_000, employee_number: 50 },
      [B]: { corporate_number: B }, // 中身が空
    });
    const r = await enrichFromGbiz(db, client, { limit: 10 });
    expect(r.queried).toBe(2);
    expect(r.filled.capital).toBe(1);
    expect(r.filled.employees).toBe(1);
    expect(r.empty).toBe(1);
    expect(countCompanies(db, { employeesMin: 50 })).toBe(1);
  });

  it('出典を gbizinfo として残す', async () => {
    await enrichFromGbiz(db, fakeClient({ [A]: { capital_stock: 1_000_000 } }), { limit: 1 });
    const row = db.prepare('SELECT scale_source FROM company_profiles WHERE corporate_number = ?').get(A) as
      | { scale_source: string }
      | undefined;
    expect(row?.scale_source).toBe(SOURCE);
  });

  it('gBizINFO が入っている先を推定で上書きしない', async () => {
    // 業種の出典も同じ考え方。権威ある出典が推定に負けてはいけない
    db.prepare(
      `INSERT INTO company_profiles (corporate_number, industry_code, industry_name, industry_source, industry_confidence, updated_at)
       VALUES (?, '39', 'ソフトウェア業', 'gbizinfo', 1.0, 'now')`,
    ).run(A);
    classifyAll(db);
    const row = db.prepare('SELECT industry_code, industry_source FROM company_profiles WHERE corporate_number = ?').get(A) as
      | { industry_code: string; industry_source: string };
    expect(row.industry_code).toBe('39');
    expect(row.industry_source).toBe('gbizinfo');
  });

  it('範囲を絞れる', async () => {
    rebuildFts(db); // 語での絞り込みは全文検索を使うため
    const client = fakeClient({
      [A]: { capital_stock: 1_000_000 },
      [B]: { capital_stock: 2_000_000 },
    });
    const r = await enrichFromGbiz(db, client, { scope: { keyword: 'アルファ' }, limit: 10 });
    expect(r.queried).toBe(1);
  });
});

describe('検索による取り込み', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    insert(db, A, '株式会社アルファ');
  });

  it('検索の応答は概要だけなので、詳細を引き直して取り込む', async () => {
    // ここを怠ると「22 件見つかったが 0 件取り込み」になる (実際になった)
    const client = fakeClient(
      { [A]: { corporate_number: A, capital_stock: 740_000_000, employee_number: 51 } },
      [[{ corporate_number: A, name: '株式会社アルファ' }]], // 概要には資本金が無い
    );
    const r = await importFromSearch(db, client, { employee_number_from: 40 }, { maxPages: 1 });
    expect(r.found).toBe(1);
    expect(r.inMaster).toBe(1);
    expect(r.imported).toBe(1);
    expect(searchCompanies(db, {})[0]?.employees).toBe(51);
  });

  it('手元のマスタに無い法人は取り込まない', async () => {
    // 国税庁のデータが唯一の正。gBizINFO 側にしか無い先は入れない
    const unknown = '9999999999999';
    const client = fakeClient(
      { [unknown]: { capital_stock: 1_000_000 } },
      [[{ corporate_number: unknown, name: '株式会社知らない' }]],
    );
    const r = await importFromSearch(db, client, {}, { maxPages: 1 });
    expect(r.found).toBe(1);
    expect(r.inMaster).toBe(0);
    expect(r.imported).toBe(0);
  });

  it('応答が尽きたら止まる', async () => {
    const client = fakeClient({}, [[{ corporate_number: A }], []]);
    const r = await importFromSearch(db, client, {}, { maxPages: 5 });
    expect(r.pages).toBe(1);
  });

  it('取込を監査記録に残す', async () => {
    await importFromSearch(db, fakeClient({}, [[]]), {}, { maxPages: 1 });
    const run = db.prepare("SELECT source, status FROM ingest_runs WHERE source = 'gbizinfo'").get() as
      | { source: string; status: string }
      | undefined;
    expect(run?.status).toBe('ok');
  });
});
