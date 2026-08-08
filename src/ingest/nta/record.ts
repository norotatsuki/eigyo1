/**
 * 国税庁 全件データ (CSV 30列・ヘッダ無し) の 1 行を、保存する形へ移す。
 *
 * 列の並びは国税庁の公表仕様に従う。実測で確認した並び (2026-08-08 / 鳥取県分):
 *   1 一連番号 / 2 法人番号 / 3 処理区分 / 4 訂正区分 / 5 更新年月日 / 6 変更年月日 /
 *   7 商号又は名称 / 8 商号又は名称イメージID / 9 法人種別 /
 *   10-12 国内所在地(都道府県/市区町村/丁目番地等) / 13 国内所在地イメージID /
 *   14 都道府県コード / 15 市区町村コード / 16 郵便番号 /
 *   17 国外所在地 / 18 国外所在地イメージID /
 *   19 登記記録の閉鎖等年月日 / 20 登記記録の閉鎖等の事由 / 21 承継法人等の法人番号 /
 *   22 変更事由の詳細 / 23 法人番号指定年月日 / 24 最新履歴等 /
 *   25-28 英語表記 / 29 フリガナ / 30 検索対象除外
 */
import { normalizeCompanyName } from '../../normalize/company-name.ts';

export const COLUMN_COUNT = 30;

/**
 * 法人種別。国税庁の区分値。
 *
 * 301-305 と 399 の対応は 鳥取県分の実データで法人格と突き合わせて確認した
 * (2026-08-08 / 基準日 2026-07-31)。401 は鳥取県分に出現しなかった。
 */
export const CORP_KIND = {
  国の機関: 101,
  地方公共団体: 201,
  株式会社: 301,
  有限会社: 302,
  合名会社: 303,
  合資会社: 304,
  合同会社: 305,
  その他の設立登記法人: 399,
  外国会社等: 401,
  その他: 499,
} as const;

/** 法人種別コード → 表示名。 */
export const CORP_KIND_LABEL: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(CORP_KIND).map(([label, code]) => [code, label]),
);

/** 会社 (営業先の本命)。一般社団法人や医療法人を含めたい場合は 399 を足す。 */
export const COMPANY_KINDS: readonly number[] = [301, 302, 303, 304, 305];

export interface CorporationRow {
  corporate_number: string;
  process_kind: string;
  correction_kind: string;
  update_date: string | null;
  change_date: string | null;
  name: string;
  kind: number | null;
  pref_name: string;
  city_name: string;
  street_number: string;
  pref_code: string;
  city_code: string;
  post_code: string;
  address_outside: string;
  close_date: string | null;
  close_cause: string;
  successor_number: string;
  change_cause: string;
  assignment_date: string | null;
  latest: number;
  name_en: string;
  pref_en: string;
  city_en: string;
  address_outside_en: string;
  furigana: string;
  search_excluded: number;
  name_normalized: string;
  name_core: string;
  corp_form: string | null;
  address_full: string;
  is_active: number;
  source_date: string;
  ingested_at: string;
}

const blankToNull = (s: string | undefined): string | null => {
  const v = s?.trim() ?? '';
  return v === '' ? null : v;
};
const str = (s: string | undefined): string => s?.trim() ?? '';
const int = (s: string | undefined): number | null => {
  const v = s?.trim() ?? '';
  if (v === '') return null;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

/**
 * 営業対象になりうるかの判定。
 *
 * 法人番号は登記された全法人に振られるため、清算結了や合併で消えた法人も含まれる。
 * この 3 条件で落とさないと、届かない宛先を大量に抱えることになる。
 *   - 検索対象除外 = 1 … 国税庁が公表対象から外したもの
 *   - 登記記録の閉鎖等年月日あり … 清算結了・合併消滅など
 *   - 最新履歴等 ≠ 1 … 過去の履歴行
 *
 * 法人種別は絞り込み条件として別に扱う。
 * 地方公共団体や国の機関も営業先になりうるため、ここでは落とさない。
 */
export function isActive(r: {
  search_excluded: number;
  close_date: string | null;
  latest: number;
}): boolean {
  return r.search_excluded === 0 && r.close_date === null && r.latest === 1;
}

/** 30 列の配列を 1 件の保存対象へ。列数が合わない行は null を返す。 */
export function toRow(
  fields: string[],
  sourceDate: string,
  ingestedAt: string,
): CorporationRow | null {
  if (fields.length < COLUMN_COUNT) return null;

  const corporateNumber = str(fields[1]);
  if (!/^\d{13}$/.test(corporateNumber)) return null;

  const name = str(fields[6]);
  const { normalized, core, corpForm } = normalizeCompanyName(name);

  const prefName = str(fields[9]);
  const cityName = str(fields[10]);
  const streetNumber = str(fields[11]);

  const searchExcluded = int(fields[29]) ?? 0;
  const closeDate = blankToNull(fields[18]);
  const latest = int(fields[23]) ?? 0;

  return {
    corporate_number: corporateNumber,
    process_kind: str(fields[2]),
    correction_kind: str(fields[3]),
    update_date: blankToNull(fields[4]),
    change_date: blankToNull(fields[5]),
    name,
    kind: int(fields[8]),
    pref_name: prefName,
    city_name: cityName,
    street_number: streetNumber,
    pref_code: str(fields[13]),
    city_code: str(fields[14]),
    post_code: str(fields[15]),
    address_outside: str(fields[16]),
    close_date: closeDate,
    close_cause: str(fields[19]),
    successor_number: str(fields[20]),
    change_cause: str(fields[21]),
    assignment_date: blankToNull(fields[22]),
    latest,
    name_en: str(fields[24]),
    pref_en: str(fields[25]),
    city_en: str(fields[26]),
    address_outside_en: str(fields[27]),
    furigana: str(fields[28]),
    search_excluded: searchExcluded,
    name_normalized: normalized,
    name_core: core,
    corp_form: corpForm,
    address_full: `${prefName}${cityName}${streetNumber}`,
    is_active: isActive({ search_excluded: searchExcluded, close_date: closeDate, latest }) ? 1 : 0,
    source_date: sourceDate,
    ingested_at: ingestedAt,
  };
}
