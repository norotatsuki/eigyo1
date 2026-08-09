/**
 * 規模で切るときの帯。
 *
 * 画面の選択肢と、絞り込みの条件と、集計の見出しを **同じ定義から作る**。
 * 別々に書くと、画面に「50〜100 名」と出しているのに条件は 50〜99 だった、
 * というずれが必ず起きる。
 *
 * min は「以上」、max は「未満」。max が null なら上限なし。
 */
export interface Band {
  /** 絞り込みで受け渡す名前。増減しても既存の指定が壊れないよう、値で名付ける */
  id: string;
  label: string;
  min: number | null;
  max: number | null;
}

/** 従業員数 (人)。実測が無ければ推定を使って判定する。 */
export const EMPLOYEE_BANDS: readonly Band[] = [
  { id: 'emp:0-10', label: '10 名未満', min: null, max: 10 },
  { id: 'emp:10-30', label: '10〜30 名', min: 10, max: 30 },
  { id: 'emp:30-50', label: '30〜50 名', min: 30, max: 50 },
  { id: 'emp:50-100', label: '50〜100 名', min: 50, max: 100 },
  { id: 'emp:100-', label: '100 名以上', min: 100, max: null },
  { id: 'emp:300-', label: '300 名以上', min: 300, max: null },
];

/** 資本金 (円)。会社概要に書かれていた実測値だけで判定する。 */
export const CAPITAL_BANDS: readonly Band[] = [
  { id: 'cap:100', label: '100 万円以上', min: 1_000_000, max: null },
  { id: 'cap:300', label: '300 万円以上', min: 3_000_000, max: null },
  { id: 'cap:500', label: '500 万円以上', min: 5_000_000, max: null },
  { id: 'cap:1000', label: '1000 万円以上', min: 10_000_000, max: null },
  { id: 'cap:3000', label: '3000 万円以上', min: 30_000_000, max: null },
  { id: 'cap:5000', label: '5000 万円以上', min: 50_000_000, max: null },
  { id: 'cap:10000', label: '1 億円以上', min: 100_000_000, max: null },
];

/** 年商 (円)。実測が無ければ推定を使って判定する。 */
export const REVENUE_BANDS: readonly Band[] = [
  { id: 'rev:0-1', label: '1 億円未満', min: null, max: 100_000_000 },
  { id: 'rev:1-3', label: '1〜3 億円', min: 100_000_000, max: 300_000_000 },
  { id: 'rev:3-5', label: '3〜5 億円', min: 300_000_000, max: 500_000_000 },
  { id: 'rev:5-10', label: '5〜10 億円', min: 500_000_000, max: 1_000_000_000 },
  { id: 'rev:10-', label: '10 億円以上', min: 1_000_000_000, max: null },
  { id: 'rev:30-50', label: '30〜50 億円', min: 3_000_000_000, max: 5_000_000_000 },
  { id: 'rev:100-', label: '100 億円以上', min: 10_000_000_000, max: null },
];

/** 名前から帯を引く。知らない名前は無視する (古い指定で落とさないため)。 */
export function findBand(bands: readonly Band[], id: string): Band | undefined {
  return bands.find((b) => b.id === id);
}
