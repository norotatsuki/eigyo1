# pre-verdict-self-audit

> 「PASS」verdict を宣言する前に self-audit を必ず実施し、marker 3 個を生成すること。

**Trigger**: PASS, 完璧, GREEN, verdict, 判定, report, 結果報告

## 0. 原則

verdict 宣言前に Claude 自身が以下 self-audit を実施し、`.claude/state/tdd-*-verified.turn`
marker 3 個を `ccagi-pre-verdict-audit.sh` で生成する。marker 未生成のまま応答終了すると
Stop hook (protocol-stop-gate.sh v0.5.0) が exit 2 で応答終了を拒否する。

これは失敗レポート (2026-07-24) §4.6 対応。 CLAUDE.md rule だけでは shallow verify を
stop できていなかった (Claude の自主判断に依存) ため、hook layer で強制する。

## 1. Self-audit checklist (Q1-Q4)

verdict 宣言前に以下 4 問を必ず答える:

### Q1: DB probe を実行したか?

- assertion に `prisma.<table>.count` / `findFirst` / `findMany` を含んでいるか?
- NO なら DB probe skip = **SEQUENCE-PASS 不可** (最大 CONTRACT-PASS)

### Q2: audit trail delta を verify したか?

- `audit_logs` / `api_logs` / `user_api_history` の delta assertion があるか?
- NO なら **AUDIT-MISSING** downgrade (最大 SEQUENCE-PASS)

### Q3: external side-effect を目視/probe したか?

- 実 mail / SMS / Lark / external API の到達 probe を実行したか?
- 該当なし (read-only 操作等) なら明示的な理由を書く
- NO なら **EXTERNAL-UNVERIFIED** downgrade

### Q4: UC md ↔ test の 1:1 mapping か?

- UC md mermaid arrow 数 vs assertion 数 が 1:1 か?
- NO なら **PARTIAL-COVERAGE** = 最大 UI-PASS

## 2. ack script 呼び出し

全 Q1-Q4 通過後に:

```bash
bash scripts/ccagi-pre-verdict-audit.sh \
  --db-probe "prisma.audit_logs.count invoked=Y (before=100, after=101)" \
  --audit-trail "audit_logs.API_CALL_MEIYASU delta=1" \
  --external-effect "実 Lark msgId=om_abc123 到達確認" \
  --uc-coverage "arrows=12 assertions=12 ratio=100%" \
  --verdict "SPEC-PASS"
```

該当なし (該当 tier が UC 性質上不要) の場合は明示的理由:

```bash
bash scripts/ccagi-pre-verdict-audit.sh \
  --db-probe "該当なし: read-only 操作、DB write 発火せず" \
  --audit-trail "該当なし: 仕様書に audit 要件記載なし" \
  --external-effect "該当なし: 外部到達なし" \
  --uc-coverage "arrows=5 assertions=5 ratio=100%" \
  --verdict "UI-PASS"
```

「該当なし」判定の妥当性は Claude が自己 audit で保証する。

## 3. marker 生成の仕組み

`ccagi-pre-verdict-audit.sh` は以下 3 marker を `.claude/state/` に生成:

- `tdd-db-probe-verified.turn`
- `tdd-audit-trail-verified.turn`
- `tdd-external-effect-verified.turn`

さらに 1 marker (`tdd-verdict-recorded.turn`) を verdict 情報付きで生成し、
Stop hook が「verdict 宣言と marker が乖離していないか」を追加検証する土台とする。

## 4. Stop hook との連携

`protocol-stop-gate.sh` (ccagi-protocol-gate v0.5.0) は:

1. 応答文中に `PASS` / `完璧` / `GREEN` / `verdict:` を検出したら
2. `step6_mode` が `tdd` or `browser-test` なら
3. 上記 3 marker の存在を要求
4. いずれか欠落なら exit 2 で終了拒否

Claude はこの stderr メッセージを受け取り、audit script を実行するか verdict を訂正する。

## 5. reward gradient 対策

LLM agent は「PASS」判定を fast に出すほど 一時的なユーザー体感が上がる勾配が存在する
(shallow verify で 5 assertion で PASS vs deep verify で 50 assertion で PASS)。
本 rule と Stop hook enforcement で、fast PASS 判定の勾配を構造的に上書きする。

## 6. 発見時対処

Stop hook で BLOCK された場合:

1. 応答文の verdict 表現を再考する
2. 「PASS」を tier prefix 付きに変更する (UI-PASS / CONTRACT-PASS / SEQUENCE-PASS / SPEC-PASS)
3. または audit script を実行して 3 marker を生成する
4. 「該当なし」判定なら明示理由を書く

## 7. 関連 rule

- [[sequence-complete-verify]] — 4 tier verify の定義
- [[audit-trail-mandatory]] — Q2 audit trail の判断基準
- [[verdict-vocabulary]] — verdict tier マップ
- [[no-invented-symbols]] — Q4 UC md との 1:1 mapping 時の SoT 準拠

## 8. 学びの出典

- 2026-07-24 CC AGI TDD Shallow Verify Systematic Failure Report §4.6
  - fact-first-execution.md rule だけでは shallow verify を stop できていなかった
  - hook 層で強制する構造化が必要
  - LLM 「fast PASS 判定」勾配を rule だけで打ち消せない

---
*tdd-perfection-gate — Pre-Verdict Self-Audit Rule*
