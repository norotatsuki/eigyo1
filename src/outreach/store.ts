/**
 * 除外リスト・接触記録・保存した条件の出し入れ。
 */
import type { Db } from '../db/index.ts';
import type { SearchFilter } from '../search/query.ts';

/** 除外の理由。手で足すときも、この中から選ぶ。 */
export const SUPPRESSION_REASONS = [
  'opt_out', // 受信拒否の申し出があった (特定電子メール法 3条3項)
  'refused', // サイトに営業お断りの表示
  'customer', // 既存の取引先
  'competitor', // 競合
  'bounced', // 宛先不明が続いた
  'manual', // その他 (note に理由を書く)
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export interface SuppressionInput {
  corporateNumber: string;
  reason: SuppressionReason;
  note?: string;
  addedBy?: string;
}

/** 除外リストに積む。既に載っていれば理由を上書きする。 */
export function addSuppression(db: Db, input: SuppressionInput): void {
  db.prepare(
    `INSERT INTO suppressions (corporate_number, reason, note, added_by, added_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(corporate_number) DO UPDATE SET
       reason = excluded.reason, note = excluded.note,
       added_by = excluded.added_by, added_at = excluded.added_at`,
  ).run(
    input.corporateNumber,
    input.reason,
    input.note ?? null,
    input.addedBy ?? null,
    new Date().toISOString(),
  );
}

/** まとめて積む。件数を返す。 */
export function addSuppressions(db: Db, inputs: readonly SuppressionInput[]): number {
  const run = db.transaction((items: readonly SuppressionInput[]) => {
    for (const i of items) addSuppression(db, i);
  });
  run(inputs);
  return inputs.length;
}

export function removeSuppression(db: Db, corporateNumber: string): boolean {
  return db.prepare('DELETE FROM suppressions WHERE corporate_number = ?').run(corporateNumber).changes > 0;
}

export function countSuppressions(db: Db): Array<{ reason: string; count: number }> {
  return db
    .prepare('SELECT reason, COUNT(*) AS count FROM suppressions GROUP BY reason ORDER BY count DESC')
    .all() as Array<{ reason: string; count: number }>;
}

export interface OutreachSummary {
  channel: string;
  outcome: string;
  count: number;
}

export function summarizeOutreach(db: Db, campaign?: string): OutreachSummary[] {
  const where = campaign ? 'WHERE campaign = ?' : '';
  const args = campaign ? [campaign] : [];
  return db
    .prepare(
      `SELECT channel, outcome, COUNT(*) AS count FROM outreach_log ${where}
        GROUP BY channel, outcome ORDER BY channel, count DESC`,
    )
    .all(...args) as OutreachSummary[];
}

/** ある法人への接触の履歴。新しい順。 */
export function outreachHistory(
  db: Db,
  corporateNumber: string,
  limit = 20,
): Array<{ channel: string; outcome: string; blocked_reason: string | null; campaign: string | null; occurred_at: string }> {
  return db
    .prepare(
      `SELECT channel, outcome, blocked_reason, campaign, occurred_at
         FROM outreach_log WHERE corporate_number = ?
        ORDER BY occurred_at DESC LIMIT ?`,
    )
    .all(corporateNumber, limit) as never;
}

export interface Segment {
  id: number;
  name: string;
  filter: SearchFilter;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** 条件に名前を付けて残す。同名なら上書きする。 */
export function saveSegment(db: Db, name: string, filter: SearchFilter, note?: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO segments (name, filter, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       filter = excluded.filter, note = excluded.note, updated_at = excluded.updated_at`,
  ).run(name, JSON.stringify(filter), note ?? null, now, now);
}

export function listSegments(db: Db): Segment[] {
  const rows = db.prepare('SELECT * FROM segments ORDER BY name').all() as Array<
    Omit<Segment, 'filter'> & { filter: string }
  >;
  return rows.map((r) => ({ ...r, filter: JSON.parse(r.filter) as SearchFilter }));
}

export function getSegment(db: Db, name: string): Segment | null {
  const row = db.prepare('SELECT * FROM segments WHERE name = ?').get(name) as
    | (Omit<Segment, 'filter'> & { filter: string })
    | undefined;
  return row ? { ...row, filter: JSON.parse(row.filter) as SearchFilter } : null;
}

export function deleteSegment(db: Db, name: string): boolean {
  return db.prepare('DELETE FROM segments WHERE name = ?').run(name).changes > 0;
}
