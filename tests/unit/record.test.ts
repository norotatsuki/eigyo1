import { describe, expect, it } from 'vitest';
import { splitRecord } from '../../src/ingest/csv.ts';
import { isActive, toRow } from '../../src/ingest/nta/record.ts';

// 国税庁 31_tottori_all_20260731.csv の実データ 1 行 (2026-08-08 取得)
const REAL_LINE =
  '1,1000013050238,01,1,2018-04-02,2015-10-05,"鳥取簡易裁判所",,101,"鳥取県","鳥取市",' +
  '"東町２丁目２２３",,31,201,6800011,,,,,,,2015-10-05,1,"Tottori Summary Court","Tottori",' +
  '"2-223, Higashimachi, Tottori shi",,"トットリカンイサイバンショ",0';

describe('toRow', () => {
  it('実データの 30 列を対応する項目へ移す', () => {
    const row = toRow(splitRecord(REAL_LINE), '2026-07-31', '2026-08-09T00:00:00.000Z');
    expect(row).not.toBeNull();
    expect(row!.corporate_number).toBe('1000013050238');
    expect(row!.name).toBe('鳥取簡易裁判所');
    expect(row!.kind).toBe(101);
    expect(row!.pref_name).toBe('鳥取県');
    expect(row!.city_name).toBe('鳥取市');
    expect(row!.pref_code).toBe('31');
    expect(row!.post_code).toBe('6800011');
    expect(row!.assignment_date).toBe('2015-10-05');
    expect(row!.latest).toBe(1);
    expect(row!.search_excluded).toBe(0);
    expect(row!.furigana).toBe('トットリカンイサイバンショ');
    // 住所は郵送にも使うため、国税庁の正式表記をそのまま保つ (全角のまま)
    expect(row!.address_full).toBe('鳥取県鳥取市東町２丁目２２３');
    expect(row!.is_active).toBe(1);
  });

  it('列が足りない行は取り込まない', () => {
    expect(toRow(['1', '2', '3'], '2026-07-31', 'now')).toBeNull();
  });

  it('法人番号が 13 桁でない行は取り込まない', () => {
    const fields = splitRecord(REAL_LINE);
    fields[1] = 'ABC';
    expect(toRow(fields, '2026-07-31', 'now')).toBeNull();
  });

  it('所在地は正式表記のまま保ち、商号だけを正規化する', () => {
    const row = toRow(splitRecord(REAL_LINE), '2026-07-31', 'now');
    expect(row!.street_number).toBe('東町２丁目２２３');
    expect(row!.name_normalized).toBe('鳥取簡易裁判所');
  });
});

describe('isActive', () => {
  const base = { search_excluded: 0, close_date: null as string | null, latest: 1 };

  it('公表対象で登記が生きている最新行だけを営業対象とする', () => {
    expect(isActive(base)).toBe(true);
  });

  it('検索対象除外は営業対象にしない', () => {
    expect(isActive({ ...base, search_excluded: 1 })).toBe(false);
  });

  it('登記記録が閉鎖されていれば営業対象にしない', () => {
    expect(isActive({ ...base, close_date: '2020-03-31' })).toBe(false);
  });

  it('過去の履歴行は営業対象にしない', () => {
    expect(isActive({ ...base, latest: 0 })).toBe(false);
  });
});
