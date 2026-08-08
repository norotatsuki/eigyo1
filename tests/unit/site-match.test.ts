import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/index.ts';
import { matchCorporation } from '../../src/enrich/site/crawl.ts';
import { hostOf, hostsFromIndexPage } from '../../src/ingest/commoncrawl/hosts.ts';
import { normalizeCompanyName } from '../../src/normalize/company-name.ts';

function insert(db: Db, number: string, name: string, pref: string, address: string): void {
  const { normalized, core, corpForm } = normalizeCompanyName(name);
  db.prepare(
    `INSERT INTO corporations
       (corporate_number, name, kind, pref_name, city_name, street_number,
        pref_code, city_code, post_code, latest, search_excluded,
        name_normalized, name_core, corp_form, address_full, is_active, source_date, ingested_at)
     VALUES (?, ?, 301, ?, '', '', '13', '101', '', 1, 0, ?, ?, ?, ?, 1, '2026-07-31', 'now')`,
  ).run(number, name, pref, normalized, core, corpForm, address);
}

describe('hostOf', () => {
  it('URL からホスト名を取り出し www を落とす', () => {
    expect(hostOf('https://www.example.co.jp/company/')).toBe('example.co.jp');
    expect(hostOf('http://example.co.jp:8080/')).toBe('example.co.jp');
  });

  it('ホストとして成り立たないものは取らない', () => {
    expect(hostOf('https://localhost/')).toBeNull();
  });
});

describe('hostsFromIndexPage', () => {
  it('索引の行からホスト名だけを集める', () => {
    const body = [
      JSON.stringify({ url: 'https://a.co.jp/x' }),
      JSON.stringify({ url: 'https://www.a.co.jp/y' }), // www は同一とみなす
      JSON.stringify({ url: 'https://b.co.jp/' }),
      JSON.stringify({ url: 'https://c.example.com/' }), // 対象外
    ].join('\n');
    expect([...hostsFromIndexPage(body, '.co.jp')].sort()).toEqual(['a.co.jp', 'b.co.jp']);
  });

  it('壊れた行があっても止まらない', () => {
    const body = `{"url":"https://a.co.jp/"}\nこれは JSON ではない\n{"url":"https://b.co.jp/"}`;
    expect(hostsFromIndexPage(body, '.co.jp').size).toBe(2);
  });
});

describe('matchCorporation', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    // 同名の会社が全国に複数ある状況を作る (実際に頻発する)
    insert(db, '1000000000001', '株式会社サンプル', '東京都', '東京都港区1-1-1');
    insert(db, '1000000000002', '株式会社サンプル', '大阪府', '大阪府大阪市北区2-2-2');
    insert(db, '1000000000003', '株式会社ユニークな商号', '福岡県', '福岡県福岡市博多区3-3-3');
  });

  const site = (name: string | null, address: string | null = null) => ({
    name, address, tel: null, contactUrl: null, refusedText: null,
  });

  it('商号と住所が一致すれば高い確信度で紐付ける', () => {
    const r = matchCorporation(db, site('株式会社サンプル', '〒105-0001 東京都港区1-1-1'));
    expect(r?.corporateNumber).toBe('1000000000001');
    expect(r?.method).toBe('name_address');
    expect(r?.confidence).toBe(0.95);
  });

  it('住所が粗くても都道府県で 1 社に絞れれば紐付ける', () => {
    const r = matchCorporation(db, site('株式会社サンプル', '大阪府のどこか'));
    expect(r?.corporateNumber).toBe('1000000000002');
    expect(r?.method).toBe('name_pref');
  });

  it('同名が複数あって決められないときは紐付けない', () => {
    // 誤った宛先を作るより、空欄のままの方がよい
    expect(matchCorporation(db, site('株式会社サンプル'))).toBeNull();
    expect(matchCorporation(db, site('株式会社サンプル', '住所らしきものが無い文字列'))).toBeNull();
  });

  it('同じ県に同名が複数あるときも紐付けない', () => {
    insert(db, '1000000000004', '株式会社サンプル', '東京都', '東京都渋谷区9-9-9');
    expect(matchCorporation(db, site('株式会社サンプル', '東京都のどこか'))).toBeNull();
  });

  it('全国で 1 社しかない商号なら住所が無くても紐付ける', () => {
    const r = matchCorporation(db, site('株式会社ユニークな商号'));
    expect(r?.corporateNumber).toBe('1000000000003');
    expect(r?.method).toBe('name_only');
    expect(r?.confidence).toBe(0.6);
  });

  it('表記のゆれを吸収して照合する', () => {
    // サイト側が ㈱ や全角で書いていても当たること
    expect(matchCorporation(db, site('㈱ユニークな商号'))?.corporateNumber).toBe('1000000000003');
    expect(matchCorporation(db, site('ユニークな商号株式会社'))?.corporateNumber).toBe('1000000000003');
  });

  it('会社名が取れていなければ紐付けない', () => {
    expect(matchCorporation(db, site(null))).toBeNull();
    expect(matchCorporation(db, site('株'))).toBeNull();
  });

  it('法人マスタに無い会社名は紐付けない', () => {
    expect(matchCorporation(db, site('株式会社存在しない会社', '東京都港区'))).toBeNull();
  });
});
