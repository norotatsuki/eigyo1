/**
 * 従業員数と年商の推定。
 *
 * 会社概要に書いていない会社が多いため、書いてある会社から比を取り、
 * 書いていない会社に当てる。
 *
 * **ここで出す値は推定であって事実ではない。**
 * 呼び出す側は必ず「推定」と分かる形で見せること。実測値がある場合は
 * そちらを必ず優先する。推定値を実測値の欄に混ぜてはいけない。
 *
 * 比は外から持ってきた数字ではなく、**このデータベースに集まった実測値**から
 * 出している (下の n が母数)。集まるほど精度が上がるので、
 * `npm run cli -- estimate --recalibrate` で取り直せる。
 */

/** 比を測った日と母数。値の確からしさを判断する材料として残す。 */
export const CALIBRATION = {
  measuredAt: '2026-08-09',
  capitalEmployeePairs: 2428,
  employeeRevenuePairs: 439,
} as const;

/**
 * 資本金の帯ごとの従業員数の中央値。
 *
 * 資本金に比例させると外れ値に引きずられるため、帯ごとの中央値を使う。
 * 実測 (2026-08-09 / n=2,428):
 *   〜1000万        n=  298  中央値  14 人
 *   1000万〜5000万  n=1,250  中央値  45 人
 *   5000万〜3億     n=  698  中央値 130 人
 *   3億〜           n=  178  中央値 266 人
 */
const EMPLOYEES_BY_CAPITAL: ReadonlyArray<readonly [maxCapital: number, employees: number, n: number]> = [
  [10_000_000, 14, 298],
  [50_000_000, 45, 1250],
  [300_000_000, 130, 698],
  [Number.POSITIVE_INFINITY, 266, 178],
];

/**
 * 一人当たり売上高の中央値 (円)。
 *
 * 実測 (2026-08-09 / n=439): 29.7 百万円
 * 業種で 23〜96 百万円の幅があるが、業種ごとの母数が 50 件に届かないため、
 * 分けずに全体の中央値を使う。母数が増えたら業種別に分ける。
 */
const REVENUE_PER_EMPLOYEE = 29_700_000;

export interface Estimated {
  value: number;
  /** どういう根拠で出したか。画面と CSV にそのまま出す */
  basis: string;
  /** 推定の元がさらに推定なら true。確からしさが一段落ちる */
  compounded: boolean;
}

/**
 * 資本金から従業員数を推定する。
 *
 * 資本金が分からなければ推定しない。何も無いところから数字を作らない。
 */
export function estimateEmployees(capital: number | null): Estimated | null {
  if (capital === null || capital <= 0) return null;
  for (const [max, employees, n] of EMPLOYEES_BY_CAPITAL) {
    if (capital < max) {
      return {
        value: employees,
        basis: `資本金${formatYen(capital)}の帯の中央値 (実測 n=${n})`,
        compounded: false,
      };
    }
  }
  return null;
}

/**
 * 従業員数から年商を推定する。
 *
 * 従業員数が推定値なら、年商は推定の推定になる。それを隠さない。
 */
export function estimateRevenue(
  employees: number | null,
  employeesAreEstimated = false,
): Estimated | null {
  if (employees === null || employees <= 0) return null;
  return {
    value: employees * REVENUE_PER_EMPLOYEE,
    basis: employeesAreEstimated
      ? `推定従業員数 ${employees} 人 × 一人当たり売上高の中央値 (実測 n=${CALIBRATION.employeeRevenuePairs})`
      : `従業員数 ${employees} 人 × 一人当たり売上高の中央値 (実測 n=${CALIBRATION.employeeRevenuePairs})`,
    compounded: employeesAreEstimated,
  };
}

/** 実測値があればそれを、無ければ推定を返す。どちらかは呼び出す側に伝える。 */
export interface Scale {
  employees: { value: number; estimated: false } | (Estimated & { estimated: true }) | null;
  revenue: { value: number; estimated: false } | (Estimated & { estimated: true }) | null;
}

export function scaleWithEstimates(
  capital: number | null,
  employees: number | null,
  revenue: number | null,
): Scale {
  const emp = employees !== null && employees > 0
    ? ({ value: employees, estimated: false } as const)
    : (() => {
        const e = estimateEmployees(capital);
        return e ? ({ ...e, estimated: true } as const) : null;
      })();

  const rev = revenue !== null && revenue > 0
    ? ({ value: revenue, estimated: false } as const)
    : (() => {
        if (!emp) return null;
        const r = estimateRevenue(emp.value, emp.estimated);
        return r ? ({ ...r, estimated: true } as const) : null;
      })();

  return { employees: emp, revenue: rev };
}

/**
 * 実測値が無い先も含めて絞り込めるよう、推定を含む式を SQL 用に組み立てる。
 *
 * 画面に出す推定と、絞り込みに使う推定が食い違ってはいけない。
 * どちらも上の定数から作ることで、ずれようがない形にしている。
 */
export function employeesSqlExpr(profile = 'p'): string {
  const bands = EMPLOYEES_BY_CAPITAL.map(([max, employees]) =>
    Number.isFinite(max)
      ? `WHEN ${profile}.capital < ${max} THEN ${employees}`
      : `ELSE ${employees}`,
  ).join(' ');
  return `COALESCE(${profile}.employees,
    CASE WHEN ${profile}.capital IS NULL OR ${profile}.capital <= 0 THEN NULL ${bands} END)`;
}

export function revenueSqlExpr(profile = 'p'): string {
  return `COALESCE(${profile}.revenue, (${employeesSqlExpr(profile)}) * ${REVENUE_PER_EMPLOYEE})`;
}

/** 金額を日本語の単位で短く書く。 */
export function formatYen(yen: number): string {
  if (yen >= 100_000_000) {
    const oku = yen / 100_000_000;
    return `${oku >= 10 ? Math.round(oku) : oku.toFixed(1).replace(/\.0$/, '')}億円`;
  }
  if (yen >= 10_000) {
    const man = Math.round(yen / 10_000);
    return `${man.toLocaleString('ja-JP')}万円`;
  }
  return `${yen.toLocaleString('ja-JP')}円`;
}
