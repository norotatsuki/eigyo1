// auditProbe — audit_logs / api_logs / user_api_history delta 検出 helper
// Tier 4 (Audit trail) の verify に使う。
// audit-trail-mandatory.md 対応。

export type AuditEventName =
  // 登録
  | 'USER_REGISTERED' | 'USER_ACTIVATED' | 'USER_DELETED'
  // OTP
  | 'OTP_ISSUED' | 'OTP_VERIFIED' | 'OTP_FAILED' | 'OTP_LOCKED'
  // ログイン
  | 'LOGIN_SUCCESS' | 'LOGIN_FAILURE' | 'LOGIN_LOCKED' | 'LOGOUT' | 'ADMIN_LOGIN'
  // パスワード
  | 'PASSWORD_CHANGED' | 'PASSWORD_RESET_REQUESTED' | 'PASSWORD_RESET_COMPLETED'
  // API
  | 'API_CALL_MEIYASU' | 'API_CALL_SBPS' | 'API_CALL_BLASTENGINE'
  // 法人更新
  | 'CORP_UPDATE_UPLOAD' | 'CORP_UPDATE_APPLY'
  // チャネル / 解約 / Allowlist
  | 'CHANNEL_ADDED' | 'CHANNEL_REMOVED'
  | 'SUBSCRIPTION_CANCELED'
  | 'ALLOWLIST_ADDED' | 'ALLOWLIST_REMOVED'
  // カスタム
  | (string & Record<never, never>);

export type AuditProbeResult = {
  before: number;
  after: number;
  delta: number;
  event: AuditEventName;
  actorFilter?: { actorUserId?: string };
};

export async function auditProbe(
  prisma: any,
  event: AuditEventName,
  action: () => Promise<void>,
  options?: { actorFilter?: { actorUserId?: string }; tableName?: string },
): Promise<AuditProbeResult> {
  const table = options?.tableName ?? 'audit_logs';
  const modelClient = (prisma as Record<string, any>)[table];
  if (!modelClient || typeof modelClient.count !== 'function') {
    throw new Error(
      `auditProbe: prisma.${table}.count is not available. ` +
      `Prisma schema に model ${table} が定義されているか確認してください。 ` +
      `stdout only sink (未実装) の場合は AuditLogService.record() が呼ばれても delta = 0 になります。`,
    );
  }
  const where: Record<string, unknown> = { action: event };
  if (options?.actorFilter?.actorUserId) {
    where.actor_user_id = options.actorFilter.actorUserId;
  }
  const before = await modelClient.count({ where });
  await action();
  const after = await modelClient.count({ where });
  return {
    before,
    after,
    delta: after - before,
    event,
    actorFilter: options?.actorFilter,
  };
}
