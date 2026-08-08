import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/index.ts';
import { normalizeCompanyName } from '../../src/normalize/company-name.ts';
import { classifyAll, inferIndustry } from '../../src/enrich/industry/classify.ts';
import { divisionName, majorDivisionOf } from '../../src/enrich/industry/classification.ts';
import { countCompanies } from '../../src/search/query.ts';

/** 商号から推定する (正規化を挟むので実運用と同じ経路になる) */
function infer(name: string) {
  const { core, corpForm } = normalizeCompanyName(name);
  return inferIndustry(core, corpForm);
}

describe('inferIndustry', () => {
  it('業種を強く示す語を拾う', () => {
    expect(infer('株式会社山田建設')?.code).toBe('06');
    expect(infer('有限会社佐藤運送')?.code).toBe('44');
    expect(infer('株式会社ABCシステム開発')?.code).toBe('39');
    expect(infer('合同会社みどり介護サービス')?.code).toBe('85');
    expect(infer('株式会社北海酒造')?.code).toBe('10');
  });

  it('長い語を短い語より優先する', () => {
    // 「不動産鑑定」は不動産取引業(68)ではなく専門サービス業(72)
    expect(infer('株式会社中央不動産鑑定')?.code).toBe('72');
    expect(infer('株式会社中央不動産')?.code).toBe('68');
  });

  it('法人格だけからでも推定する', () => {
    expect(infer('医療法人社団けやき会')?.code).toBe('83');
    expect(infer('学校法人あおば学園')?.code).toBe('81');
    expect(infer('宗教法人常光寺')?.code).toBe('94');
    expect(infer('税理士法人さくら')?.code).toBe('72');
  });

  it('商号の語より法人格の方が確かならそちらを採る', () => {
    // 「教室」(0.6) より 学校法人 (0.9) が勝つ
    const r = infer('学校法人みらい教室');
    expect(r?.code).toBe('81');
    expect(r?.matched).toBe('学校法人');
  });

  it('全角英数の商号でも推定できる', () => {
    expect(infer('株式会社ＡＢＣシステム')?.code).toBe('39');
  });

  it('手がかりが無ければ推定しない', () => {
    expect(infer('株式会社さくら')).toBeNull();
    expect(infer('合同会社ABC')).toBeNull();
  });

  it('根拠になった語を返す', () => {
    expect(infer('株式会社山田工務店')?.matched).toBe('工務店');
  });
});

describe('分類マスタ', () => {
  it('中分類から大分類を導く', () => {
    expect(majorDivisionOf('06')).toBe('D'); // 建設業
    expect(majorDivisionOf('39')).toBe('G'); // 情報通信業
    expect(majorDivisionOf('83')).toBe('P'); // 医療，福祉
    expect(majorDivisionOf('95')).toBe('R'); // サービス業
  });

  it('中分類の名称を返す', () => {
    expect(divisionName('39')).toBe('情報サービス業');
    expect(divisionName('83')).toBe('医療業');
  });
});

describe('classifyAll', () => {
  let db: Db;

  function insert(number: string, name: string, active = true): void {
    const { normalized, core, corpForm } = normalizeCompanyName(name);
    db.prepare(
      `INSERT INTO corporations
         (corporate_number, name, kind, pref_name, city_name, street_number,
          pref_code, city_code, post_code, latest, search_excluded,
          name_normalized, name_core, corp_form, address_full, is_active,
          source_date, ingested_at)
       VALUES (?, ?, 301, '', '', '', '13', '100', '', 1, 0, ?, ?, ?, '', ?, '2026-07-31', 'now')`,
    ).run(number, name, normalized, core, corpForm, active ? 1 : 0);
  }

  beforeEach(() => {
    db = openDb(':memory:');
    insert('1000000000001', '株式会社山田建設');
    insert('1000000000002', '有限会社佐藤運送');
    insert('1000000000003', '株式会社さくら'); // 手がかり無し
    insert('1000000000004', '医療法人社団けやき会');
    insert('1000000000005', '株式会社閉鎖済建設', false);
  });

  it('推定できた先だけを書き込む', () => {
    const r = classifyAll(db);
    expect(r.scanned).toBe(4); // 閉鎖済みは対象外
    expect(r.inferred).toBe(3); // 「さくら」は推定できない
    expect(r.byCode.get('06')).toBe(1);
    expect(r.byCode.get('44')).toBe(1);
    expect(r.byCode.get('83')).toBe(1);
  });

  it('書き込んだ内容で絞り込めるようになる', () => {
    classifyAll(db);
    expect(countCompanies(db, { industryCodes: ['06'] })).toBe(1);
    expect(countCompanies(db, { industryCodes: ['83'] })).toBe(1);
  });

  it('出典と確信度を残す', () => {
    classifyAll(db);
    const row = db
      .prepare('SELECT industry_source, industry_confidence FROM company_profiles WHERE corporate_number = ?')
      .get('1000000000001') as { industry_source: string; industry_confidence: number };
    expect(row.industry_source).toBe('name_inference');
    expect(row.industry_confidence).toBeGreaterThan(0.5);
  });

  it('何度実行しても結果が変わらない', () => {
    const first = classifyAll(db);
    const second = classifyAll(db);
    expect(second.inferred).toBe(first.inferred);
    const n = db.prepare('SELECT COUNT(*) AS n FROM company_profiles').get() as { n: number };
    expect(n.n).toBe(3);
  });

  it('権威ある出典が入っている行は上書きしない', () => {
    db.prepare(
      `INSERT INTO company_profiles
         (corporate_number, industry_code, industry_name, industry_source, industry_confidence, updated_at)
       VALUES ('1000000000001', '39', 'ソフトウェア業', 'gbizinfo', 1.0, 'now')`,
    ).run();

    const r = classifyAll(db);
    const row = db
      .prepare('SELECT industry_code, industry_source FROM company_profiles WHERE corporate_number = ?')
      .get('1000000000001') as { industry_code: string; industry_source: string };

    expect(row.industry_code).toBe('39'); // 建設(06)で上書きされていない
    expect(row.industry_source).toBe('gbizinfo');
    expect(r.skippedAuthoritative).toBe(1);
  });

  it('読み取りが複数回に分かれても最後まで処理する', () => {
    // 分割読み取りの境界で書き込みが走る経路。1 ページに収まる件数だと通らない
    for (let i = 0; i < 25; i++) {
      insert(`200000000${String(i).padStart(4, '0')}`, `株式会社テスト${i}運送`);
    }
    const r = classifyAll(db, { pageSize: 4 });
    expect(r.scanned).toBe(29); // 既存 4 件 + 追加 25 件
    expect(r.byCode.get('44')).toBe(26); // 佐藤運送 + 追加 25 件
    const stored = db.prepare(
      "SELECT COUNT(*) AS n FROM company_profiles WHERE industry_code = '44'",
    ).get() as { n: number };
    expect(stored.n).toBe(26);
  });

  it('確信度の下限を指定できる', () => {
    const r = classifyAll(db, { minConfidence: 0.85 });
    expect(r.byCode.get('06')).toBeUndefined(); // 建設は 0.8 なので落ちる
    expect(r.byCode.get('44')).toBe(1); // 運送は 0.9 なので残る
  });
});
