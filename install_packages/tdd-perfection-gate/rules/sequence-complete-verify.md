# sequence-complete-verify

> UC の mermaid シーケンス図の全 arrow が assertion で verify されていること。
> Arrow のうち 1 つでも skip している場合、verdict は「PARTIAL」に downgrade。「PASS」宣言禁止。

**Trigger**: verdict, PASS, 完璧, GREEN, ブラウザテスト完了報告, sequence, arrow, mermaid

## 0. 原則

「PASS」= mermaid シーケンスの全 arrow (Actor → Route → Service → DB → External → Response) が
実測 assertion で通過している状態。UI navigability レベルの verify だけでは「UI-PASS」であって
「SEQUENCE-PASS」ではない。

失敗レポート (2026-07-24 CC AGI TDD Shallow Verify Systematic Failure Report) では、
「PASS 20/20 完璧 GREEN」と宣言していた 60+ UC / 500+ assertion のほぼ全てが実は
UI navigability レベル (Tier 1) のみで通過しており、mermaid arrow の 中間 (DB write /
audit log 記録 / external API 到達) を系統的に skip していた。

## 1. Mandatory verify checklist (Tier 定義)

各 UC test は以下 4 tier 全てを assertion に含めること:

| Tier | 名前 | 内容 | 例 |
|---|---|---|---|
| **Tier 1** | Input | browser action / API call が発火した | HTTP status 200, DOM 要素存在 |
| **Tier 2** | Middle state | DB row の delta (before/after diff) | `prisma.audit_logs.count` で delta ≥ 1 |
| **Tier 3** | External side-effect | 実 mail / 実 SMS / 実 API call / 実 Lark 到達 | Blast Engine dashboard API, POP3 IMAP, Lark BOT delta |
| **Tier 4** | Audit trail | audit_logs / api_logs / user_api_history 該当 event の record 発火 | 仕様書 §11-18 全 event の delta assertion |

4 tier のうち 1 つでも欠けたら:

- verdict = 下記のいずれかに downgrade
- 「PASS」単独宣言 **禁止**

## 2. verdict downgrade マップ

| 通過 Tier | verdict | 意味 |
|---|---|---|
| Tier 1 のみ | **UI-PASS** | UI 到達確認のみ。DB / external / audit は未検証 |
| Tier 1 + 2 | **CONTRACT-PASS** | API endpoint contract + DB delta まで |
| Tier 1 + 2 + 3 | **SEQUENCE-PASS** | 外部 side-effect まで到達確認 |
| Tier 1 + 2 + 3 + 4 | **SPEC-PASS** | 仕様書要求完全充足 |
| Tier 1 も通らず | **FAIL** | verify そのものが失敗 |

参照: `.claude/rules/verdict-vocabulary.md`

## 3. UC md との対応

UC md の §Sequence (mermaid) 内 arrow の数 N と、test assertion の Tier 2-4 count が
1:1 対応していること。 N=20 arrow で assertion 5 個 = 不十分と自動判定。

`ccagi-verify-uc-coverage.sh` CLI が自動チェックする:

```bash
$ bash scripts/ccagi-verify-uc-coverage.sh docs/use_case/UC02-01.md tests/uc02-01.spec.ts
[UC02-01] mermaid arrows: 12
[UC02-01] test assertions: 9
[UC02-01] arrows without assertion:
  - arrow 5: MeiyasuClient.request → meiyasu_api_logs INSERT (not verified)
  - arrow 7: user_api_history INSERT (not verified)
  - arrow 10: audit_logs INSERT (not verified)
[UC02-01] verdict: PARTIAL-COVERAGE (9/12 = 75%)
Exit code: 1
```

exit code が 0 でないと「PASS」宣言禁止。

## 4. 検出パターン (Anti-Pattern)

以下は shallow verify として自動 downgrade:

```typescript
// ❌ Tier 1 のみ = UI-PASS 相当
test('login flow', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[name=email]', 'test@example.com');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/dashboard');  // Tier 1: URL 遷移確認のみ
});

// ✅ Tier 1-4 全通過 = SPEC-PASS 相当
test('login flow (SPEC-PASS)', async ({ page }) => {
  const before = await prisma.audit_logs.count({ where: { action: 'LOGIN_SUCCESS' } });

  await page.goto('/login');
  await page.fill('input[name=email]', 'test@example.com');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/dashboard');  // Tier 1

  // Tier 2: DB delta
  const user = await prisma.users.findFirst({ where: { email: 'test@example.com' } });
  expect(user?.last_login_at).toBeTruthy();

  // Tier 3: 実 mail 到達 (welcome mail の場合)
  const mailArrived = await mailProbe({ receiver: 'test@example.com', subject: 'Welcome', timeoutMs: 10000 });
  expect(mailArrived).toBe(true);

  // Tier 4: audit trail delta
  const after = await prisma.audit_logs.count({ where: { action: 'LOGIN_SUCCESS' } });
  expect(after - before).toBeGreaterThanOrEqual(1);
});
```

## 5. 発見時対処

shallow verify を発見したら:

1. verdict を UI-PASS / CONTRACT-PASS / SEQUENCE-PASS のいずれかに downgrade
2. 欠落 Tier を明示化 (「Tier 3 (実 mail 到達) 未検証」等)
3. 未実装の writer / sink を「実装 gap」として escalate

## 6. 関連 rule

- [[audit-trail-mandatory]] — audit_logs / api_logs delta の必須化
- [[verdict-vocabulary]] — 4 tier verdict の定義
- [[pre-verdict-self-audit]] — PASS 宣言前 self-audit checklist
- [[no-invented-symbols]] — 要件定義書に無い symbol 発明禁止

## 7. 学びの出典

- 2026-07-24 CC AGI TDD Shallow Verify Systematic Failure Report
  - UC09/10/11/12 全体で 60+ UC が Tier 1 のみで「PASS」宣言
  - meiyasu_api_logs / user_api_history / audit_logs 系統的 skip
  - 仕様書 §11-18 の 26 event のうち 4 event しか発火せず

---
*tdd-perfection-gate — Sequence Complete Verify Rule*
