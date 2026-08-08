/**
 * 送信前ゲート。
 *
 * **すべての接触は必ずここを通す。** 経路ごとに判定を書くと、いずれ必ず
 * どこかが抜ける。抜けた先で起きるのは「断られた相手への再送」であり、
 * 特定電子メール法 3条3項の違反にあたる。構造で防ぐしかない。
 *
 * 止めた判断も記録に残す。止めた事実が残らないと、あとから
 * 「なぜこの会社に送っていないのか」を説明できない。
 */
import type { Db } from '../db/index.ts';

/** 接触の経路。 */
export type Channel = 'postal' | 'email' | 'form' | 'phone';

/** 止めた理由。記録にそのまま入る。 */
export type BlockReason =
  | 'suppressed' // 除外リストに載っている
  | 'refused' // 営業お断りの表示を検出済み
  | 'already_sent' // この経路では 1 社 1 回まで
  | 'cooling' // 前回の接触から日が浅い
  | 'no_destination'; // 宛先が分かっていない

export interface ChannelPolicy {
  /** 1 社につき生涯 1 回まで */
  oncePerCompany: boolean;
  /** 前回の接触からこの日数は空ける */
  coolingDays: number;
  /** 送るのに必要な宛先の欄。無ければ送れない */
  requires: 'postal_address' | 'contact_email' | 'contact_form_url' | 'contact_tel';
}

/**
 * 経路ごとの決まり。
 *
 * 問い合わせフォームを 1 社 1 回に限っているのは、特定電子メール法の
 * 対象外である代わりに、反復送信が業務妨害にあたるという指摘があるため
 * (docs/concept/sales-platform-concept.md §2.3)。緩める判断をするなら
 * ここを変えるのではなく、法務の確認を先に取ること。
 */
export const CHANNEL_POLICY: Readonly<Record<Channel, ChannelPolicy>> = {
  postal: { oncePerCompany: false, coolingDays: 90, requires: 'postal_address' },
  email: { oncePerCompany: false, coolingDays: 30, requires: 'contact_email' },
  form: { oncePerCompany: true, coolingDays: Number.POSITIVE_INFINITY, requires: 'contact_form_url' },
  phone: { oncePerCompany: false, coolingDays: 30, requires: 'contact_tel' },
};

export interface GateOptions {
  /** 判定の基準時刻。試験で固定するために外から渡せる */
  now?: Date;
  /** 宛先の有無を確認しない (郵送の宛名は法人マスタに必ずあるため既定で確認する) */
  skipDestinationCheck?: boolean;
}

export interface GateDecision {
  corporateNumber: string;
  allowed: boolean;
  reason?: BlockReason;
  /** 判断の裏づけ (前回送付日など) */
  detail?: string;
}

const CHUNK = 900; // SQLite の変数上限に余裕を持たせる

function chunked<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const placeholders = (n: number): string => new Array(n).fill('?').join(', ');

/**
 * 候補を一括で判定する。
 *
 * 1 件ずつ問い合わせると 10 万件で現実的な時間に収まらないため、
 * 除外・お断り・送付済みをそれぞれ 1 回の照会で集めてから突き合わせる。
 * 判定の順序は「除外 → お断り → 送付済み → 冷却 → 宛先」で固定する。
 */
export function checkSendable(
  db: Db,
  corporateNumbers: readonly string[],
  channel: Channel,
  options: GateOptions = {},
): GateDecision[] {
  const policy = CHANNEL_POLICY[channel];
  const now = options.now ?? new Date();

  const suppressed = new Map<string, string>();
  const refused = new Set<string>();
  const lastSent = new Map<string, string>();
  const hasDestination = new Set<string>();

  for (const batch of chunked(corporateNumbers)) {
    const ph = placeholders(batch.length);

    for (const r of db
      .prepare(`SELECT corporate_number AS n, reason FROM suppressions WHERE corporate_number IN (${ph})`)
      .all(...batch) as Array<{ n: string; reason: string }>) {
      suppressed.set(r.n, r.reason);
    }

    for (const r of db
      .prepare(
        `SELECT corporate_number AS n FROM company_profiles
          WHERE solicitation_refused = 1 AND corporate_number IN (${ph})`,
      )
      .all(...batch) as Array<{ n: string }>) {
      refused.add(r.n);
    }

    for (const r of db
      .prepare(
        `SELECT corporate_number AS n, MAX(occurred_at) AS last
           FROM outreach_log
          WHERE outcome = 'sent' AND channel = ? AND corporate_number IN (${ph})
          GROUP BY corporate_number`,
      )
      .all(channel, ...batch) as Array<{ n: string; last: string }>) {
      lastSent.set(r.n, r.last);
    }

    if (!options.skipDestinationCheck) {
      for (const r of destinationRows(db, policy.requires, ph, batch)) hasDestination.add(r.n);
    }
  }

  return corporateNumbers.map((n) => {
    const supp = suppressed.get(n);
    if (supp) return { corporateNumber: n, allowed: false, reason: 'suppressed', detail: supp };
    if (refused.has(n)) return { corporateNumber: n, allowed: false, reason: 'refused' };

    const last = lastSent.get(n);
    if (last) {
      if (policy.oncePerCompany) {
        return { corporateNumber: n, allowed: false, reason: 'already_sent', detail: last };
      }
      const days = (now.getTime() - new Date(last).getTime()) / 86_400_000;
      if (days < policy.coolingDays) {
        return {
          corporateNumber: n,
          allowed: false,
          reason: 'cooling',
          detail: `前回 ${last} (${Math.floor(days)} 日前 / ${policy.coolingDays} 日空ける)`,
        };
      }
    }

    if (!options.skipDestinationCheck && !hasDestination.has(n)) {
      return { corporateNumber: n, allowed: false, reason: 'no_destination', detail: policy.requires };
    }
    return { corporateNumber: n, allowed: true };
  });
}

/** 経路ごとに「宛先が分かっている」の意味が違う。 */
function destinationRows(
  db: Db,
  requires: ChannelPolicy['requires'],
  ph: string,
  batch: readonly string[],
): Array<{ n: string }> {
  if (requires === 'postal_address') {
    // 郵送の宛先は法人マスタにある。所在地が空でなければ送れる
    return db
      .prepare(
        `SELECT corporate_number AS n FROM corporations
          WHERE address_full <> '' AND corporate_number IN (${ph})`,
      )
      .all(...batch) as Array<{ n: string }>;
  }
  const column = requires; // contact_email / contact_form_url / contact_tel
  return db
    .prepare(
      `SELECT corporate_number AS n FROM company_profiles
        WHERE ${column} IS NOT NULL AND ${column} <> '' AND corporate_number IN (${ph})`,
    )
    .all(...batch) as Array<{ n: string }>;
}

export interface RecordOptions {
  campaign?: string;
  note?: string;
  occurredAt?: Date;
}

/** 接触の結果を 1 件記録する。 */
export function recordOutreach(
  db: Db,
  entry: {
    corporateNumber: string;
    channel: Channel;
    outcome: 'sent' | 'blocked' | 'failed' | 'replied' | 'bounced';
    blockedReason?: string;
    campaign?: string;
    note?: string;
    occurredAt?: Date;
  },
): void {
  db.prepare(
    `INSERT INTO outreach_log
       (corporate_number, channel, outcome, blocked_reason, campaign, note, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.corporateNumber,
    entry.channel,
    entry.outcome,
    entry.blockedReason ?? null,
    entry.campaign ?? null,
    entry.note ?? null,
    (entry.occurredAt ?? new Date()).toISOString(),
  );
}

export interface GateResult {
  allowed: string[];
  blocked: GateDecision[];
  /** 止めた理由 → 件数 */
  blockedByReason: Record<string, number>;
}

/**
 * 候補を判定し、**止めた分を記録に残したうえで** 送ってよい先だけを返す。
 *
 * 送る側はこの関数の戻り値だけを使うこと。checkSendable を直接呼んで
 * 記録を省くと、止めた事実が残らない。
 */
export function applyGate(
  db: Db,
  corporateNumbers: readonly string[],
  channel: Channel,
  options: GateOptions & RecordOptions = {},
): GateResult {
  const decisions = checkSendable(db, corporateNumbers, channel, options);
  const allowed: string[] = [];
  const blocked: GateDecision[] = [];
  const blockedByReason: Record<string, number> = {};

  const writeBlocked = db.transaction((items: GateDecision[]) => {
    for (const d of items) {
      recordOutreach(db, {
        corporateNumber: d.corporateNumber,
        channel,
        outcome: 'blocked',
        blockedReason: d.detail ? `${d.reason}: ${d.detail}` : d.reason,
        ...(options.campaign !== undefined ? { campaign: options.campaign } : {}),
        ...(options.occurredAt !== undefined ? { occurredAt: options.occurredAt } : {}),
      });
    }
  });

  for (const d of decisions) {
    if (d.allowed) {
      allowed.push(d.corporateNumber);
    } else {
      blocked.push(d);
      const key = d.reason ?? 'unknown';
      blockedByReason[key] = (blockedByReason[key] ?? 0) + 1;
    }
  }
  if (blocked.length > 0) writeBlocked(blocked);

  return { allowed, blocked, blockedByReason };
}
