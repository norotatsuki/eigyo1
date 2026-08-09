import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/index.ts';
import { breakdown } from '../../src/search/query.ts';

function add(
  db: Db, n: string, name: string,
  o: { pref: string; prefCode: string; city: string; cityCode: string;
       employees?: number; capital?: number; revenue?: number; industry?: [string, string];
       email?: string } = {} as never,
): void {
  db.prepare(
    `INSERT INTO corporations
       (corporate_number, name, kind, pref_name, city_name, street_number, pref_code, city_code,
        post_code, latest, search_excluded, name_normalized, name_core, corp_form, address_full,
        is_active, source_date, ingested_at)
     VALUES (?, ?, 301, ?, ?, '1-1', ?, ?, '1000001', 1, 0, ?, ?, '株式会社', ?, 1, '2026-07-31', 'now')`,
  ).run(n, name, o.pref, o.city, o.prefCode, o.cityCode, name, name, `${o.pref}${o.city}1-1`);
  db.prepare(
    `INSERT INTO company_profiles
       (corporate_number, employees, capital, revenue, industry_code, industry_name, contact_email, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'now')`,
  ).run(n, o.employees ?? null, o.capital ?? null, o.revenue ?? null,
        o.industry?.[0] ?? null, o.industry?.[1] ?? null, o.email ?? 'info@example.co.jp');
}

describe('セグメントの内訳', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  // 市区町村コードは県ごとに振り直される。「201」は 42 県に存在する。
  // コードだけで束ねると鳥取市と札幌市中央区が同じ塊になった (実際になった)
  it('同じ市区町村コードでも県が違えば別に数える', () => {
    add(db, '1000000000001', 'あ', { pref: '鳥取県', prefCode: '31', city: '鳥取市', cityCode: '201' });
    add(db, '1000000000002', 'い', { pref: '北海道', prefCode: '01', city: '札幌市中央区', cityCode: '201' });
    const s = breakdown(db, { reachable: true }, 'city');
    expect(s.map((x) => x.label).sort()).toEqual(['北海道札幌市中央区', '鳥取県鳥取市']);
    expect(s.every((x) => x.count === 1)).toBe(true);
  });

  // corporations には id 列がある。別名を id にすると HAVING がそちらを見て
  // 絞り込みが効かず、業種が空の行が「None」として出ていた
  it('業種が空の先を内訳に混ぜない', () => {
    add(db, '1000000000001', 'あ', { pref: '東京都', prefCode: '13', city: '港区', cityCode: '103', industry: ['39', '情報サービス業'] });
    add(db, '1000000000002', 'い', { pref: '東京都', prefCode: '13', city: '港区', cityCode: '103' });
    const s = breakdown(db, { reachable: true }, 'industry');
    expect(s).toEqual([{ id: '39', label: '情報サービス業', count: 1 }]);
  });

  it('従業員数の帯ごとに数える (実測が無ければ推定を使う)', () => {
    add(db, '1000000000001', 'あ', { pref: '東京都', prefCode: '13', city: '港区', cityCode: '103', employees: 5 });
    add(db, '1000000000002', 'い', { pref: '東京都', prefCode: '13', city: '港区', cityCode: '103', employees: 40 });
    // 資本金だけの先は推定 (1000万〜5000万 → 45 人) で 30〜50 名に入る
    add(db, '1000000000003', 'う', { pref: '東京都', prefCode: '13', city: '港区', cityCode: '103', capital: 30_000_000 });
    const byLabel = Object.fromEntries(breakdown(db, { reachable: true }, 'employees').map((s) => [s.label, s.count]));
    expect(byLabel['10 名未満']).toBe(1);
    expect(byLabel['30〜50 名']).toBe(2);
  });

  it('重なる帯は両方で数える (100名以上 と 300名以上)', () => {
    add(db, '1000000000001', 'あ', { pref: '東京都', prefCode: '13', city: '港区', cityCode: '103', employees: 500 });
    const byLabel = Object.fromEntries(breakdown(db, { reachable: true }, 'employees').map((s) => [s.label, s.count]));
    expect(byLabel['100 名以上']).toBe(1);
    expect(byLabel['300 名以上']).toBe(1);
  });

  it('条件に合う先が無ければ 0 を返す', () => {
    expect(breakdown(db, { reachable: true }, 'city')).toEqual([]);
    expect(breakdown(db, { reachable: true }, 'employees').every((s) => s.count === 0)).toBe(true);
  });
});
