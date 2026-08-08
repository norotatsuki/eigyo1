# verdict-vocabulary

> 「PASS」を単独で使わない。4 tier verdict のいずれかで verdict を宣言する。

**Trigger**: PASS, 完璧, GREEN, verdict, 判定, 完了報告

## 0. 原則

「PASS」1 tier しか無いと、UI navigable = PASS / SPEC 完遂 = PASS の 意味論衝突が発生。
本 rule は 4 tier に分離することで、verify の深さを verdict 表現に反映させる。

過去 (2026-07-24 失敗レポート) では「PASS」= UI navigability + shallow endpoint contract
という意味で使用されていたが、CC AGI は本来「完璧 TDD」を目指す product であり、
顧客が「PASS」を読むときの期待は **仕様書要求の完全充足**。この意味論 drift が
顧客期待を大きく裏切っていた。

## 1. 4 tier verdict system

| verdict | 意味 | いつ使う | Tier (sequence-complete-verify.md 参照) |
|---|---|---|---|
| **UI-PASS** | HTTP 200 + DOM element 存在 verify のみ | ブラウザテストの Tier 1 のみ通過 | Tier 1 |
| **CONTRACT-PASS** | 上記 + API endpoint response schema verify | shallow endpoint contract test | Tier 1 + 2 |
| **SEQUENCE-PASS** | 上記 + DB delta + external side-effect verify | 中間 arrow verify 済 | Tier 1 + 2 + 3 |
| **SPEC-PASS** | 上記 + audit trail + 仕様書要求充足 | 全 tier 完遂 | Tier 1 + 2 + 3 + 4 |

「PASS」単独宣言禁止。必ず tier prefix を付ける。

## 2. downgrade verdict (verify 不完全時)

| verdict | 意味 |
|---|---|
| **PARTIAL-COVERAGE** | UC md mermaid arrow N と assertion 数が乖離 (< 100% ratio) |
| **SEQUENCE-PARTIAL** | Tier 3 (external side-effect) の一部を skip |
| **AUDIT-MISSING** | Tier 4 の audit_logs delta 検証を skip |
| **EXTERNAL-UNVERIFIED** | 実 mail / SMS / Lark 到達を目視/probe していない |

## 3. FAIL verdict

| verdict | 意味 |
|---|---|
| **FAIL** | Tier 1 も通らない (HTTP error / DOM 要素不在) |
| **FLAKY** | 3 回連続実行のうち 1 回以上 fail |
| **REGRESSION** | 過去 PASS 済 UC が今回 FAIL に転じた |

## 4. verdict 宣言のカノニカル書式

```markdown
[UC02-01] verdict: **SPEC-PASS** (Tier 1-4 全通過)
  - Tier 1 (Input):        page.goto + form submit + URL 遷移 ✅
  - Tier 2 (DB delta):     users.last_login_at delta ≥ 1 ✅
  - Tier 3 (External):     welcome mail 到達 (Blast Engine dashboard) ✅
  - Tier 4 (Audit trail):  audit_logs.LOGIN_SUCCESS delta = 1 ✅
```

```markdown
[UC09-14] verdict: **AUDIT-MISSING** (Tier 4 未達)
  - Tier 1 (Input):        /admin/api-history 200 + table 存在 ✅
  - Tier 2 (DB delta):     user_api_history rows = 0 (writer 未実装) ❌
  - Tier 3 (External):     API 到達確認 not applicable (read-only)
  - Tier 4 (Audit trail):  audit_logs.API_HISTORY_VIEWED delta = 0 ❌
  - Escalation: user_api_history writer が src/ 内に grep 0 hit
```

## 5. 「PASS」単独使用の禁止例

```markdown
❌ 禁止 (2026-07-24 事故の書式):
[UC09-14] verdict: PASS 9/9 完璧 GREEN

✅ 是正:
[UC09-14] verdict: UI-PASS 9/9 (Tier 1 のみ通過、Tier 2-4 未実装)
```

## 6. Stop hook 連携

`.claude/hooks/protocol-stop-gate.sh` は `PASS` / `完璧` / `GREEN` / `verdict:` 検出時に
`tdd-*-verified.turn` marker 3 個の存在を要求する (ccagi-protocol-gate v0.5.0)。
tier prefix を付けても検出対象になるので、必ず `ccagi-pre-verdict-audit.sh` で marker 生成する。

## 7. 関連 rule

- [[sequence-complete-verify]] — Tier 定義
- [[audit-trail-mandatory]] — AUDIT-MISSING の判定基準
- [[pre-verdict-self-audit]] — PASS 宣言前 Q1-Q4 self-audit

## 8. 学びの出典

- 2026-07-24 CC AGI TDD Shallow Verify Systematic Failure Report §1.5, §4.4
  - 「PASS」= UI navigability レベルの意味で 60+ UC / 500+ assertion 全体に適用
  - 顧客期待 (SPEC-PASS) と Claude verdict (UI-PASS) の意味論 drift

---
*tdd-perfection-gate — Verdict Vocabulary Rule*
