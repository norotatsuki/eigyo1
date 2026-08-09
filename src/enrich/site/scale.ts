/**
 * 会社概要から規模 (資本金・従業員数・売上高) を取り出す。
 *
 * 桁の書き方がばらばらなので、そこを間違えると規模で絞る意味が消える。
 * 実データで見た書かれ方:
 *   資本金 3,000,000円 / 資本金 1,000万円 / 資本金 9,500万円
 *   売上高 30億220万円 / 従業員 70名 / 従業員数 従業員12名
 *
 * 取れなかったときは null を返す。当てずっぽうの数字を入れない
 * (規模で絞る道具なので、間違った数字は無いより悪い)。
 */

/**
 * 会社概要に並ぶ見出し。値を切り出すとき、次の見出しで打ち切るために使う。
 *
 * これが無いと隣の項目まで飲み込む。実際に起きた誤り:
 *   「資本金 9,500万円 売上高 30億220万円」から資本金を取ると
 *   30億 + 9,500万 = 30.95億円 になり、9,500万円の会社が 30 億に見えた。
 */
const SECTION_LABELS = [
  '資本金', '従業員数', '従業員', '社員数', '職員数', '売上高', '年商', '売上金額', '売上',
  '代表者', '代表取締役', '設立', '創業', '事業内容', '所在地', '本社', '所在地',
  '電話', 'TEL', 'FAX', '許認可', '役員', '取引先', '主要取引先', '事業所', '沿革', 'URL',
];

/** 見出しに続く値を切り出す。次の見出しが現れたらそこで打ち切る。 */
function valueAfter(text: string, labels: readonly string[], maxChars = 40): string | null {
  for (const label of labels) {
    const re = new RegExp(`${label}[\\s:：]*([^\\n]{1,${maxChars}})`);
    const m = text.match(re);
    if (!m?.[1]) continue;

    let value = m[1];
    // 自分以外の見出しが出てきたら、その手前で切る
    let cut = value.length;
    for (const other of SECTION_LABELS) {
      if (labels.includes(other as (typeof labels)[number])) continue;
      const at = value.indexOf(other);
      if (at !== -1 && at < cut) cut = at;
    }
    value = value.slice(0, cut).trim();
    if (value.length > 0) return value;
  }
  return null;
}

/**
 * 日本語の金額表記を円に直す。
 *
 * 「1,000万円」「30億220万円」「3,000,000円」のいずれも扱う。
 * 億と万が混ざる書き方 (30億220万) があるため、単位ごとに足し上げる。
 */
export function parseJapaneseAmount(raw: string): number | null {
  const s = raw.normalize('NFKC').replace(/[,、\s]/g, '');

  // 億・万が付いている場合は、単位ごとに拾って足す
  const oku = s.match(/(\d+(?:\.\d+)?)億/);
  const man = s.match(/(\d+(?:\.\d+)?)万/);
  if (oku || man) {
    const a = oku?.[1] ? Number(oku[1]) * 100_000_000 : 0;
    const b = man?.[1] ? Number(man[1]) * 10_000 : 0;
    const total = a + b;
    return total > 0 ? Math.round(total) : null;
  }

  // 単位なしの数字。円が付いているものだけを金額とみなす
  const plain = s.match(/(\d{4,})円/);
  if (plain?.[1]) {
    const n = Number(plain[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/** 「70名」「従業員12名」「約150人」から人数を取り出す。 */
export function parseHeadcount(raw: string): number | null {
  const s = raw.normalize('NFKC').replace(/[,、\s]/g, '');
  const m = s.match(/(\d{1,6})\s*(?:名|人)/);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  // 桁が明らかにおかしいものは採らない (年号や電話番号を拾った可能性)
  return Number.isFinite(n) && n >= 1 && n <= 500_000 ? n : null;
}

export interface Scale {
  capital: number | null;
  employees: number | null;
  revenue: number | null;
}

const CAPITAL_LABELS = ['資本金'] as const;
const EMPLOYEE_LABELS = ['従業員数', '従業員', '社員数', '職員数'] as const;
const REVENUE_LABELS = ['売上高', '年商', '売上金額', '売上'] as const;

/**
 * 会社概要から規模を取り出す。
 *
 * 資本金と売上高は桁が大きく違うので、取り違えると致命的になる。
 * 「資本金 3,000,000円」を売上と読めば 300 万円の会社が 300 万円の売上に見える。
 * そこで見出しごとに独立して探し、混ぜない。
 */
export function extractScale(text: string): Scale {
  const capitalRaw = valueAfter(text, CAPITAL_LABELS);
  const employeeRaw = valueAfter(text, EMPLOYEE_LABELS, 30);
  const revenueRaw = valueAfter(text, REVENUE_LABELS);

  const capital = capitalRaw ? parseJapaneseAmount(capitalRaw) : null;
  const revenue = revenueRaw ? parseJapaneseAmount(revenueRaw) : null;

  return {
    // 資本金は 1 円から。上限は現実的な範囲に留め、桁の誤読を落とす
    capital: capital !== null && capital >= 10_000 && capital <= 5_000_000_000_000 ? capital : null,
    employees: employeeRaw ? parseHeadcount(employeeRaw) : null,
    // 売上高は資本金より桁が大きいのが普通。100 万円未満は誤読とみなす
    revenue: revenue !== null && revenue >= 1_000_000 ? revenue : null,
  };
}

/** 金額を読みやすい形に。画面と書き出しで使う。 */
export function formatAmount(yen: number): string {
  if (yen >= 100_000_000) return `${(yen / 100_000_000).toFixed(yen % 100_000_000 === 0 ? 0 : 1)}億円`;
  if (yen >= 10_000) return `${Math.round(yen / 10_000).toLocaleString('ja-JP')}万円`;
  return `${yen.toLocaleString('ja-JP')}円`;
}
