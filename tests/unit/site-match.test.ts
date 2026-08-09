import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/index.ts';
import { matchCorporation, postalCodeOf } from '../../src/enrich/site/crawl.ts';
import { trimmedNameVariants } from '../../src/enrich/site/extract.ts';
import { hostOf, hostsFromIndexPage } from '../../src/ingest/commoncrawl/hosts.ts';
import { normalizeCompanyName } from '../../src/normalize/company-name.ts';

function insert(
  db: Db, number: string, name: string, pref: string, address: string, post = '', city = '',
): void {
  const { normalized, core, corpForm } = normalizeCompanyName(name);
  db.prepare(
    `INSERT INTO corporations
       (corporate_number, name, kind, pref_name, city_name, street_number,
        pref_code, city_code, post_code, latest, search_excluded,
        name_normalized, name_core, corp_form, address_full, is_active, source_date, ingested_at)
     VALUES (?, ?, 301, ?, ?, '', '13', '101', ?, 1, 0, ?, ?, ?, ?, 1, '2026-07-31', 'now')`,
  ).run(number, name, pref, city, post, normalized, core, corpForm, address);
}

const bare = { tel: null, email: null, contactUrl: null, refusedText: null };

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

describe('postalCodeOf', () => {
  it('いろいろな書き方から 7 桁を取り出す', () => {
    expect(postalCodeOf('〒107-0062 東京都港区')).toBe('1070062');
    expect(postalCodeOf('〒1070062')).toBe('1070062');
    expect(postalCodeOf('107-0062')).toBe('1070062');
    expect(postalCodeOf('〒１０７−００６２')).toBe('1070062');
  });

  it('郵便番号が無ければ取らない', () => {
    expect(postalCodeOf('東京都港区南青山2-2-15')).toBeNull();
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
    name, address, tel: null, email: null, contactUrl: null, refusedText: null,
  });

  it('郵便番号が一致すれば書き方の違いに関わらず特定する', () => {
    // 国税庁側は全角、サイト側は半角で書かれることが多い。番号なら揺れない
    insert(db, '1000000000010', '株式会社ゆれ', '東京都', '東京都港区南青山２丁目２－１５', '1070062');
    insert(db, '1000000000011', '株式会社ゆれ', '東京都', '東京都渋谷区渋谷１－１', '1500002');
    const r = matchCorporation(db, site('株式会社ゆれ', '〒107-0062 東京都港区南青山2-2-15'));
    expect(r?.corporateNumber).toBe('1000000000010');
    expect(r?.method).toBe('name_postal');
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

describe('紐付けの取り違えを防ぐ', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  // 実データで 45 件を取り違えていた。名寄せキーは法人格を落とすので
  // 「合同会社スリー」と「株式会社スリー」が同じキーになる
  it('法人格が違えば別の法人として扱う', () => {
    insert(db, '1000000000001', '株式会社スリー', '東京都', '東京都港区1-1');
    const m = matchCorporation(db, { name: '合同会社スリー', address: null, ...bare });
    expect(m).toBeNull();
  });

  it('法人格が同じなら紐付ける', () => {
    insert(db, '1000000000001', '株式会社スリー', '東京都', '東京都港区1-1');
    expect(matchCorporation(db, { name: '株式会社スリー', address: null, ...bare })?.method).toBe('name_only');
  });

  it('サイトに法人格が書かれていなければ問わない', () => {
    insert(db, '1000000000001', '株式会社スリー', '東京都', '東京都港区1-1');
    expect(matchCorporation(db, { name: 'スリー', address: null, ...bare })).not.toBeNull();
  });

  // 「株式会社ＺＥＲＯ」は全国に 497 社ある。手元に 50 件だけ読み出して
  // 絞り込んでいたため、正しい 1 社が候補に入らないまま落ちていた
  it('同名が読み出しの上限を超えても郵便番号で特定できる', () => {
    for (let i = 0; i < 120; i++) {
      insert(db, `10000000${String(i).padStart(5, '0')}`, '株式会社ゼロ', '東京都', '東京都港区1-1', `100${String(i).padStart(4, '0')}`);
    }
    const m = matchCorporation(db, {
      name: '株式会社ゼロ', address: '〒100-0119 東京都港区1-1', ...bare,
    });
    expect(m?.corporateNumber).toBe('1000000000119');
    expect(m?.method).toBe('name_postal');
  });

  // 「大阪市中央区城見1-2-27」のように 都道府県を書かないサイトは多い
  it('都道府県が書かれていなくても市区町村で絞れる', () => {
    insert(db, '1000000000001', '株式会社アートプラス', '大阪府', '大阪府大阪市中央区城見1-2', '', '大阪市中央区');
    insert(db, '1000000000002', '株式会社アートプラス', '東京都', '東京都港区5-5', '', '港区');
    const m = matchCorporation(db, {
      name: 'アートプラス株式会社', address: '大阪市中央区城見1-2-27 クリスタルタワー16F', ...bare,
    });
    expect(m?.corporateNumber).toBe('1000000000001');
    expect(m?.method).toBe('name_city');
  });
});

describe('題名に残った宣伝文句を削る', () => {
  it('助詞のうしろを社名の候補にする', () => {
    expect(trimmedNameVariants('事務所をお探しならバイリンク株式会社')).toContain('バイリンク株式会社');
    expect(trimmedNameVariants('UAV測量の塩見測量設計株式会社')).toContain('塩見測量設計株式会社');
  });

  it('社名の一部を削り落とさない', () => {
    // 「の」を含む後株の実在社名は 3,684 社ある。短すぎる切り方はしない
    expect(trimmedNameVariants('みのり株式会社')).toEqual([]);
    expect(trimmedNameVariants('株式会社ものづくり')).toEqual([]);
  });

  it('削った形は住所で裏が取れたときだけ採る', () => {
    const db = openDb(':memory:');
    insert(db, '1000000000001', '株式会社バイリンク', '東京都', '東京都港区1-1', '1050001');

    // 住所が無ければ採らない (削り方が正しい保証がないため)
    expect(matchCorporation(db, { name: '事務所をお探しならバイリンク株式会社', address: null, ...bare })).toBeNull();

    // 郵便番号まで一致すれば採る。確信度は元より下げる
    const m = matchCorporation(db, {
      name: '事務所をお探しならバイリンク株式会社', address: '〒105-0001 東京都港区1-1', ...bare,
    });
    expect(m?.corporateNumber).toBe('1000000000001');
    expect(m?.method).toBe('trimmed_name_postal');
    expect(m!.confidence).toBeLessThan(0.97);
  });
});
