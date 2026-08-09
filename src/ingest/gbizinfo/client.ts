/**
 * gBizINFO (経済産業省) の口。
 *
 * 使い方は 2 通りある。
 *   検索 … 条件 (売上・従業員数・資本金・業種・地域) を投げて法人番号を受け取る
 *   照会 … 法人番号 1 件を指定して、その会社の詳細を受け取る
 *
 * 500 万社すべてを照会するのは無駄が大きい。
 * 「売上 50〜70 億の建設会社」のような条件は **検索側に投げる** のが的確で、
 * 返ってきた法人番号を手元のマスタと突き合わせればよい。
 *
 * 項目名は OpenAPI (https://api.info.gbiz.go.jp/hojin/v3/api-docs) の
 * 定義どおりに使う。推測で名前を作らない。
 */

const BASE = 'https://api.info.gbiz.go.jp/hojin';
const TOKEN_HEADER = 'X-hojinInfo-api-token';

/**
 * 仕様書に「動作確認用」として公開されているトークン。
 * 実運用では自分のトークンを取ること (環境変数 GBIZ_API_TOKEN)。
 */
export const DEMO_TOKEN = 'DTcLxzo1lZaUYaQPVdSRxdS4MzlXNCs4';

/** OpenAPI の HojinInfo に定義されている項目のうち、営業で使うもの。 */
export interface GbizHojin {
  corporate_number?: string;
  name?: string;
  location?: string;
  postal_code?: string;
  /** 資本金 */
  capital_stock?: number;
  /** 従業員数 */
  employee_number?: number;
  /** 企業ホームページ */
  company_url?: string;
  /** 事業概要 */
  business_summary?: string;
  /** 設立年月日 */
  date_of_establishment?: string;
  /** 創業年 */
  founding_year?: number;
  /** 法人代表者名 */
  representative_name?: string;
  /** 法人代表者役職 */
  representative_position?: string;
  /** 全省庁統一資格の営業品目 */
  business_items?: string[];
  /** 法人活動情報件数 */
  number_of_activity?: string;
  update_date?: string;
}

/** 検索に使える条件。名前は API の引数名に合わせる。 */
export interface GbizSearch {
  name?: string;
  corporate_type?: string;
  prefecture?: string;
  city?: string;
  capital_stock_from?: number;
  capital_stock_to?: number;
  employee_number_from?: number;
  employee_number_to?: number;
  net_sales_summary_of_business_results_from?: number;
  net_sales_summary_of_business_results_to?: number;
  total_assets_summary_of_business_results_from?: number;
  total_assets_summary_of_business_results_to?: number;
  founded_year?: number;
  business_item?: string;
  exist_flg?: boolean;
  page?: number;
  limit?: number;
}

export interface GbizResult<T> {
  value: T | null;
  status: number;
  error?: string;
}

export class GbizClient {
  private readonly token: string;
  private readonly delayMs: number;
  private last = 0;

  constructor(token?: string, delayMs = 400) {
    const t = token ?? process.env['GBIZ_API_TOKEN'];
    if (!t) {
      throw new Error(
        '環境変数 GBIZ_API_TOKEN が設定されていません ' +
          '(https://info.gbiz.go.jp/hojin/various_registration/form で取得)',
      );
    }
    this.token = t;
    this.delayMs = delayMs;
  }

  /** 公開サービスに負荷をかけないよう、呼び出しの間隔を空ける。 */
  private async pace(): Promise<void> {
    const wait = this.delayMs - (Date.now() - this.last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
  }

  private async get<T>(path: string): Promise<GbizResult<T>> {
    await this.pace();
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { [TOKEN_HEADER]: this.token, accept: 'application/json' },
      });
      if (!res.ok) {
        return { value: null, status: res.status, error: `HTTP ${res.status}` };
      }
      return { value: (await res.json()) as T, status: res.status };
    } catch (err) {
      return { value: null, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 法人番号 1 件の詳細。 */
  async detail(corporateNumber: string): Promise<GbizResult<GbizHojin>> {
    const r = await this.get<{ 'hojin-infos'?: GbizHojin[] }>(`/v1/hojin/${corporateNumber}`);
    if (!r.value) return { value: null, status: r.status, ...(r.error ? { error: r.error } : {}) };
    const first = r.value['hojin-infos']?.[0] ?? null;
    return { value: first, status: r.status };
  }

  /**
   * 条件で検索し、当てはまる法人を返す。
   *
   * 件数は応答に含まれないため、返ってきた数で判断する。
   * limit の上限は API 側の決まりに従う (超えると 400 が返る)。
   */
  async search(params: GbizSearch): Promise<GbizResult<GbizHojin[]>> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    }
    const r = await this.get<{ 'hojin-infos'?: GbizHojin[] }>(`/v1/hojin?${q}`);
    if (!r.value) return { value: null, status: r.status, ...(r.error ? { error: r.error } : {}) };
    return { value: r.value['hojin-infos'] ?? [], status: r.status };
  }
}
