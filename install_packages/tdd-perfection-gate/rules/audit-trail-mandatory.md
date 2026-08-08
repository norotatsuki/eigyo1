# audit-trail-mandatory

> 仕様書相当の「登録・OTP・ログイン・パスワード・API 呼出・法人更新の全記録」の
> audit event を発火する UC は、 audit_logs / api_logs / user_api_history の DB write を
> 必ず assertion で verify すること。

**Trigger**: audit, log, history, record, sequence, TDD verdict, event

## 0. 原則

仕様書 (登録 / OTP / ログイン / パスワード / API / 法人更新 相当) を trigger する UC は、
DB `audit_logs` 等の該当 event record が「1 件増える」ことを prisma probe で verify する。

「audit_logs が実装されている前提」で verify を skip してはいけない。実測 delta を取る。

失敗レポート (2026-07-24) では 26 event 定義済のうち writer が 6 endpoint のみ、
残り 22 event は `lib/audit/logger.ts` の stdout only sink (「Prisma sink は S10-O DB
provider 確定後の別 wave で追加」= 未実装コメント付き) だった。UI 表示された 4 event
のみを確認し「audit logs pass」宣言 → 22 event の欠落を系統的に無視していた。

## 1. Mandatory audit probe

各 UC test は「action 前の record count」→「action」→「action 後の record count」を
実測し、delta が 1 以上であることを assertion:

```typescript
import { auditProbe } from '@ccagi/browser-test-plus';

test('AR010 meiyasu API call records audit', async ({ page, prisma }) => {
  const result = await auditProbe(prisma, 'API_CALL_MEIYASU', async () => {
    await page.goto('/admin/meiyasu/trigger');
    await page.click('button[name=execute]');
  });
  expect(result.delta).toBeGreaterThanOrEqual(1);
});
```

または生の prisma:

```typescript
const before = await prisma.audit_logs.count({ where: { action: 'API_CALL_MEIYASU' } });
await action();
const after = await prisma.audit_logs.count({ where: { action: 'API_CALL_MEIYASU' } });
expect(after - before).toBeGreaterThanOrEqual(1);
```

## 2. Mandatory な UC カテゴリ

以下 UC カテゴリは audit assertion を **省略禁止**:

| カテゴリ | 対応 audit action |
|---|---|
| 登録 (signup / register) | `USER_REGISTERED`, `USER_ACTIVATED` |
| OTP (発行 / 検証) | `OTP_ISSUED`, `OTP_VERIFIED`, `OTP_FAILED`, `OTP_LOCKED` |
| ログイン | `LOGIN_SUCCESS`, `LOGIN_FAILURE`, `LOGIN_LOCKED`, `LOGOUT` |
| パスワード | `PASSWORD_CHANGED`, `PASSWORD_RESET_REQUESTED`, `PASSWORD_RESET_COMPLETED` |
| 外部 API 呼出 | `API_CALL_<PROVIDER>` (例: `API_CALL_MEIYASU`) |
| 法人更新 (batch upload) | `CORP_UPDATE_UPLOAD`, `CORP_UPDATE_APPLY` |
| チャネル操作 | `CHANNEL_ADDED`, `CHANNEL_REMOVED` |
| 解約 / 削除 | `SUBSCRIPTION_CANCELED`, `USER_DELETED` |
| Allowlist 変更 | `ALLOWLIST_ADDED`, `ALLOWLIST_REMOVED` |

## 3. 発見時対処

audit_logs delta = 0 なら:

1. writer 未実装 (`AuditLogService.record()` 呼出漏れ)
2. または sink が stdout only (`lib/audit/logger.ts:currentSink = StdoutJsonSink`)
3. どちらも仕様書未達 = **実装 bug として escalate**、UC test verdict は「AUDIT-MISSING」downgrade

verdict downgrade マップ:
- audit delta = 0 かつ実装 writer 有 → 実装 bug (writer 呼出漏れ)
- audit delta = 0 かつ sink が stdout only → 実装 gap (Prisma sink 未実装)
- どちらも AUDIT-MISSING として escalate

## 4. `ccagi-pre-verdict-audit.sh` 連携

PASS 宣言前の 3 marker 生成時に、audit-trail は必須項目:

```bash
bash scripts/ccagi-pre-verdict-audit.sh \
  --db-probe "prisma.audit_logs.count invoked=Y (before=100, after=101)" \
  --audit-trail "audit_logs.LOGIN_SUCCESS delta=1" \
  --external-effect "n/a: no external side-effect for this UC" \
  --uc-coverage "arrows=8 assertions=8 ratio=100%" \
  --verdict "SPEC-PASS"
```

`--audit-trail` に「該当なし」を書く場合は **明示的な理由を必須**:
- `--audit-trail "該当なし: read-only 操作、audit event 定義なし"`
- `--audit-trail "該当なし: 仕様書に audit 要件記載なし"`

## 5. 関連 rule

- [[sequence-complete-verify]] — Tier 4 (Audit trail) の定義
- [[verdict-vocabulary]] — AUDIT-MISSING downgrade
- [[pre-verdict-self-audit]] — Q2 で本 rule を確認

## 6. 学びの出典

- 2026-07-24 CC AGI TDD Shallow Verify Systematic Failure Report §1.3 Case 2
  - `audit_logs` 100 rows あるが 4 event types のみ (ADMIN_LOGIN / LOGIN_FAILURE / LOGIN_LOCKED / LOGOUT)
  - 仕様書要求 26 event のうち 22 event が欠落 (writer 未実装 or stdout only sink)
  - 「PASS 8/8」宣言時に表示された 4 event のみ確認、22 event の欠落を無視

---
*tdd-perfection-gate — Audit Trail Mandatory Rule*
