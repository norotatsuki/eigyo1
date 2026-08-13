/**
 * URL の問い合わせ文字列から絞り込みを組み立てるところ。
 *
 * ここが項目を落とすと、SQL 側は正しくても **絞り込み無し** の結果が返る。
 * 利用者は「京都のホテル」を見ているつもりで 500 万社を見ることになり、
 * その名簿で営業をかけてしまう。落としていないことを 1 項目ずつ確かめる。
 *
 * 実測 (2026-08-13) で見つかっていた落ち:
 *   capitalMax / employeesMax / revenueMin / revenueMax / hiring / hiringRole
 *   … 型にも SQL にもあるのに、ここだけが読んでいなかった。
 *   capitalMin は読んでいたため、範囲指定が下限だけ効き、上限 5000 万の
 *   指定に対して資本金 5 億 2705 万の会社が返っていた。
 */
import { describe, expect, it } from 'vitest';
import { filterFromParams } from '../../src/web/server.ts';

const f = (qs: string) => filterFromParams(new URLSearchParams(qs));

describe('絞り込みの受け口', () => {
  it('規模の上限と下限を対で読む', () => {
    expect(f('capitalMin=1000000&capitalMax=50000000')).toMatchObject({
      capitalMin: 1_000_000, capitalMax: 50_000_000,
    });
    expect(f('employeesMin=10&employeesMax=30')).toMatchObject({
      employeesMin: 10, employeesMax: 30,
    });
    expect(f('revenueMin=100000000&revenueMax=300000000')).toMatchObject({
      revenueMin: 100_000_000, revenueMax: 300_000_000,
    });
  });

  it('採用の有無と募集職種を読む', () => {
    expect(f('hiring=1').hiring).toBe(true);
    expect(f('hiring=0').hiring).toBeUndefined();
    expect(f('hiringRole=営業&hiringRole=施工管理').hiringRoles).toEqual(['営業', '施工管理']);
  });

  it('宛先の有無を読む', () => {
    expect(f('hasEmail=1').hasEmail).toBe(true);
    expect(f('hasContactForm=1').hasContactForm).toBe(true);
    expect(f('reachable=1').reachable).toBe(true);
    expect(f('hasWebsite=1').hasWebsite).toBe(true);
    expect(f('hasRepresentative=1').hasRepresentative).toBe(true);
  });

  it('地域は県と市区町村を組で読む', () => {
    expect(f('pref=26').prefCodes).toEqual(['26']);
    expect(f('city=26104').cityKeys).toEqual(['26104']);
    // 3 桁は、県が 1 つに決まっているときだけ繋ぐ
    expect(f('pref=26&city=104').cityKeys).toEqual(['26104']);
  });

  it('県が決まらない市区町村指定は、全件に化けさせず 0 件にする', () => {
    // 落とすと「絞り込み無し」になり、全社が返る
    expect(f('city=104').cityKeys).toEqual(['-']);
    expect(f('pref=26&pref=13&city=104').cityKeys).toEqual(['-']);
  });

  it('業種と確からしさを読む (確からしさは業種と併せたときだけ)', () => {
    expect(f('industry=75&industryConfidence=0.7')).toMatchObject({
      industryCodes: ['75'], industryMinConfidence: 0.7,
    });
    expect(f('industryConfidence=0.7').industryMinConfidence).toBeUndefined();
  });

  it('種別・法人格・語・期間を読む', () => {
    expect(f('kind=301&kind=305').kinds).toEqual([301, 305]);
    expect(f('form=株式会社').corpForms).toEqual(['株式会社']);
    expect(f('keyword=建設').keyword).toBe('建設');
    expect(f('assignedFrom=2020-01-01&assignedTo=2020-12-31')).toMatchObject({
      assignedFrom: '2020-01-01', assignedTo: '2020-12-31',
    });
  });

  it('帯は複数選べる', () => {
    expect(f('capitalBand=cap:100&capitalBand=cap:500').capitalBands).toEqual(['cap:100', 'cap:500']);
    expect(f('employeeBand=emp:30-50').employeeBands).toEqual(['emp:30-50']);
    expect(f('revenueBand=rev:1-3').revenueBands).toEqual(['rev:1-3']);
  });

  it('既定では活動中のみ・営業お断りを除く', () => {
    expect(f('')).toMatchObject({ activeOnly: true, excludeRefused: true });
    expect(f('includeInactive=1&includeRefused=1')).toMatchObject({
      activeOnly: false, excludeRefused: false,
    });
  });

  /*
   * 型に定義した項目が、全部ここを通れること。
   * 新しい項目を足したときに、受け口だけ書き忘れる事故を止める。
   */
  it('型にある項目が 1 つ残らず読まれる', () => {
    const all = f([
      'keyword=建設', 'pref=26', 'city=26104', 'kind=301', 'form=株式会社',
      'industry=75', 'industryConfidence=0.7',
      'capitalMin=1', 'capitalMax=2', 'employeesMin=3', 'employeesMax=4',
      'revenueMin=5', 'revenueMax=6',
      'assignedFrom=2020-01-01', 'assignedTo=2020-12-31',
      'hasWebsite=1', 'hasContactForm=1', 'hasEmail=1', 'reachable=1', 'hasRepresentative=1',
      'employeeBand=emp:0-10', 'capitalBand=cap:100', 'revenueBand=rev:0-1',
      'hiring=1', 'hiringRole=営業',
    ].join('&'));
    const expected = [
      'keyword', 'prefCodes', 'cityKeys', 'kinds', 'corpForms', 'industryCodes',
      'industryMinConfidence', 'capitalMin', 'capitalMax', 'employeesMin', 'employeesMax',
      'revenueMin', 'revenueMax', 'assignedFrom', 'assignedTo', 'hasWebsite',
      'hasContactForm', 'hasEmail', 'reachable', 'hasRepresentative',
      'employeeBands', 'capitalBands', 'revenueBands', 'hiring', 'hiringRoles',
      'activeOnly', 'excludeRefused',
    ];
    expect(Object.keys(all).sort()).toEqual(expected.sort());
  });
});
