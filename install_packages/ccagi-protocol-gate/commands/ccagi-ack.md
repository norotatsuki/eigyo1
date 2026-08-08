---
description: CLAUDE.md STEP 1-6 プロトコル完了を宣言してツール使用を解禁 (STEP 7 日本語出力調整ゲートを自動適用)
---

# /ccagi-ack

CLAUDE.md STEP 1-6 の完了を明示的に記録し、`ccagi-protocol-gate` のツール使用ブロックを解除します。

**v0.7.0**: 併せて **STEP 7「日本語出力調整ゲート」** が自動で判定・適用されます (宣言不要)。
利用者が日本語話者だと判定できる場合、ack の出力に「本ターンの応答文をどう書くか」の
指針が 1 度だけ提示されます。**この指針を読んだら、以降の応答文に反映してください。**

## 前提: 必ず以下を順に実施してから本コマンドを呼ぶ

1. **STEP 1** — MCP 接続確認
   - `mcp__ccagi-tools__ccagi__get_status` を呼び出し
   - `hasCCAGI: true` を確認
   - 切断時は復旧接続を試み、失敗時は作業中止

2. **STEP 2** — CC AGI 呼び出し宣言
   - ユーザーへ「CC AGI で作業を開始します」と明言する

3. **STEP 3** — 実行方式の宣言
   - デフォルト: フォアグラウンド実行
   - `run_in_background: true` は原則禁止 (ユーザー明示指示時のみ)

4. **STEP 4** — スコープ契約
   - **CHANGE**: 何を変更するか (ファイル : 行 / 関数名)
   - **NOT CHANGE**: 何を触らないか
   - **DIFF BUDGET**: 予想 diff 行数 (`scope-contract.md` 参照)

5. **STEP 5** — プロジェクト直下 `CLAUDE.md` の強制適用
   - プロジェクトルート `CLAUDE.md` を **毎ターン** 参照し直す
   - `@import` されているルール群 (`scope-contract.md` / `ccagi-work-protocol.md` / `fact-first-execution.md` / `script-non-interactive.md` 等) を含めて、
     本ターンのタスクに **どのルールをどう適用するか** を 1 行で宣言する
   - ack script は `CLAUDE.md` の存在確認と SHA256 記録を自動で行い、
     ファイルが無い / 変わっていることを marker に残す (構造的トレーサビリティ)
   - 例: `"work-protocol §2.1 10%刻み進捗遵守 / scope-contract §3 diff<=100"`

6. **STEP 6** — 成果物証跡ゲート (Deliverable Evidence Gate)
   - **なぜ**: 過去に「ブラウザ操作をして」というユーザー指示を既存 Playwright spec の
     HTTP-only 走行にすり替え、rendered browser を一度も走らせず「137 tests PASS」と
     虚偽報告した事故 (`fact-first-execution.md` 違反) を **構造的に防止** するため。
   - 本ターンが以下 3 モードのどれに該当するかを **必ず** 宣言する:

   ### Gate A: `browser-test:` — ブラウザ操作テストを実施する場合
   - 手抜きの Playwright e2e (`page.request.*` 系 HTTP-only) は **禁止**
   - 指定シーケンスに対し **可視ブラウザで完全再現** すること (`page.goto` + `page.click` + `page.fill`)
   - **v0.5.0 変更 — 動画キャプチャは既定 OFF**:
     - ユーザーから動画指示なし → `videos=off:<8 文字以上の理由>` で宣言する
     - ユーザーから動画指示あり ("動画で確認したい" / "キャプチャを残して" / "録画" / "video" 等) → `videos=<path>` で宣言し、**全 UC の動画** を保存する
   - 形式: `browser-test:sequence=<name>|videos=<path-or-off:reason>|headed=true`
   - PreToolUse hook が `playwright test` 呼び出しを傍受し、
     `--headed` / `HEADFUL=1` / `PWDEBUG=1` / `PLAYWRIGHT_HEADLESS=0` のいずれかが
     付与されていなければ **BLOCK** する

   ### Gate B: `tdd:` — テスト駆動開発によるバグ修正が必要な場合
   - **完璧な TDD** 5 フェーズすべての証跡を宣言する:
     1. バグの根本原因の確認 (`root-cause=<log-or-issue>`)
     2. バグ改修 (`fix=<file>`)
     3. 単体テスト (`unit-test=<file>`)
     4. デプロイ (`deploy=<log-or-env>`)
     5. ブラウザ操作でバグが根治していることの確認 (`browser-verify=<video-glob-or-off:reason>`)
   - 形式: `tdd:root-cause=...|fix=...|unit-test=...|deploy=...|browser-verify=<video-or-off:reason>`
   - `browser-verify` 部分は Gate A と同等の可視ブラウザ + 動画は **既定 OFF**
     (ユーザー指示ありのみ `<path>` を渡す)

   #### ⚠️ 「完璧なテスト駆動開発」を指示された場合 — この宣言だけでは足りない

   利用者正典の定義:

   > 完璧なテスト駆動開発とは
   >  - シーケンスの矢印 1 本 1 本の動作確認を行い
   >     - バグの根本原因の確認 / バグ改修 / 単体テスト / デプロイ /
   >       ブラウザ操作でのテストでバグが根治していることの確認
   >     のことをいいます。

   すなわち **矢印 N 本 × 5 フェーズ = 5N 証跡** の直積である。
   STEP 6 の `tdd:` 宣言は **ターン全体で 1 セット** の粒度でしかないため、
   矢印 1 本分の証跡に相当する。

   `tdd-perfection-gate` パッケージが導入されている環境で
   「完璧なテスト駆動開発」等のトリガー句が検出された場合、
   これに加えて **矢印 1 本ごと** に同じ 5 フェーズを実測する:

   **v1.6.0 — 態勢が活性の間、先に 2 つの凍結が必要**

   ```bash
   # (a) 母数の凍結 — 対象の使用場面書を確定する (以後 縮小できない)
   bash scripts/ccagi-arrow-verify.sh --establish-manifest --uc-dir docs/use_case

   # (b) 配備先の凍結 — 指定のクラウドサーバーを登録する (ローカルは拒否)
   bash scripts/ccagi-arrow-verify.sh --establish-deploy-target \
     --url https://<配備先のクラウド URL>
   ```

   その上で 矢印 1 本ごとに 5 フェーズを実測する。
   **配備が先、可視ブラウザでの確認が後** の順序が要求される:

   ```bash
   bash scripts/ccagi-arrow-verify.sh <UC-name> <arrow-index> \
     --kind <A1-A6> \
     --root-cause     "<根本原因の実測ログ>" \
     --fix            "<改修ファイル>" \
     --unit-test      "<単体テスト>" \
     --deploy         "<配備ログ (凍結済みクラウド配備先のホストを含むこと)>" \
     --browser-verify "<可視ブラウザで実際に操作して残った成果物の path>" \
     --browser-url    "<凍結済み配備先の URL>"

   bash scripts/ccagi-arrow-verify.sh --summary   # 全矢印完遂で summary marker
   ```

   態勢 活性中は 次の 3 点が **script で突き合わされる** (通常運用では従来どおり):

   | 項目 | 要求 | 拒否される例 |
   |---|---|---|
   | `--deploy` | 凍結済みクラウド配備先のホストを含む | `localhost`, `ローカルで確認`, `未配備` |
   | `--browser-verify` | 実在する成果物の path (`off:` 不可) | `off:...`, 存在しない path |
   | `--browser-url` | 凍結済み配備先を指す (必須) | 未指定, `http://localhost:3000` |

   矢印分の証跡が揃わないまま応答を終えようとすると、
   `perfect-tdd-stop-gate.sh` が exit 2 で終了を拒否する。

   #### ⛔ 「完璧」の定義は 下げられない (v1.6.0 の中核)

   > 2026-07-29 事故: 正典定義を **認識していた** にもかかわらず、
   > 「780 arrow × 5 = 3900 の実測が要る」と見積り、その総量を
   > **自分の実行予算と天秤にかけ**、収まらないと判断した瞬間に
   > 定義文は保持したまま「今回はここまで」と領域を切り下げ、
   > 切り下げ後を **「完璧」と呼び直して** 合否宣言した。

   総量が大きいことは 定義を縮める理由に **ならない**。
   母数は 態勢 起動時に script が凍結するため、後から小さくできない。

   **やり切れないと判断したときの 正しい終わり方は 1 つだけ**:

   ```bash
   bash scripts/ccagi-arrow-verify.sh --incomplete-report
   ```

   これで 到達率がそのまま記録され、応答を終えられる。
   ただし **「完璧」「PASS」「GREEN」「ゼロバグ」と書くことは禁止** される。
   利用者へは 次の形で 事実のまま報告する:

   > 矢印 N 本のうち M 本を 5 フェーズで確認しました。
   > 残り (N-M) 本は未確認です。完璧には達していません。

   証跡が母数に届かない状態で合否語を書くと、
   **いかなる脱出条件よりも優先して** 終了が拒否される
   (無進捗脱出・実行不能通過・絶対上限のいずれも この門には効かない)。
   態勢が解除された後も、そのターン中は 合否語の禁止だけが残り続ける。

   否定形 (「完璧には達していません」) は 正直な報告として通る。
   未達を未達と報告することは 恥ではない。
   恥ずべきなのは 未達を「完璧」と呼ぶことである。

   ### Gate C: `off:` — ブラウザテスト/バグ修正のどちらでもない場合
   - 設定編集・ドキュメント作業・軽微な文言修正など
   - 形式: `off:<8文字以上の具体的な理由>`
   - この場合でも `playwright test` の遅延呼び出しは gate で BLOCK される

7. **STEP 7** — 日本語出力調整ゲート (v0.7.0 / **宣言不要・自動判定**)
   - **なぜ**: 日本語で会話している利用者に対し、必要以上の英字・カタカナ表記を
     並べた応答は理解の妨げになる。一方で、応答終了時に禁止語で終了拒否する方式は
     書き直しの繰り返しを招き、処理能力を明確に落とすことが実測された
     (2026-07-27 判断 / `plain-japanese-guard` を一括導入から外した経緯と同根)。
     そこで **ack 時点で 1 度だけ指針を提示し、判断は文脈込みで Claude に委ねる**
     非阻止の方式を採用する。
   - **利用者が日本語話者かの判定材料** (1 つでも該当すれば適用):
     1. STEP 1-6 の宣言文に ひらがな / カタカナ が含まれる
     2. `CLAUDE.md` の日本語文字比率が 5% 以上
     3. 環境の言語設定 (`LC_ALL` / `LC_MESSAGES` / `LANG`) が `ja` で始まる
     4. macOS の地域設定 `AppleLocale` が `ja` で始まる (1-3 が全て空のときのみ確認)
   - **適用されたら Claude がすべきこと**:
     - 同義の和語・漢語がある英字/カタカナは言い換える
       (アサイン→割り当て / デプロイ→配備 / バリデーション→入力検証 など)
     - 固有名詞・ファイル名・パス・コマンド・コード上の識別子・定着した外来語・
       実体を指す略号 (JSON / API / URL / MCP など) は **そのまま残す**
     - 言い換えで意味がぼやけるなら英字のまま残す (正確さが最優先)
     - 判断が拮抗したら日本語側に寄せる
     - **推敲は送信前の 1 回まで。書き直しの繰り返しは禁止**
   - **上書き手段**:
     - `--ja-output on` (強制適用) / `--ja-output off` (無効化) / `--ja-output auto` (既定)
     - 環境変数 `CCAGI_JA_OUTPUT=on|off|auto` (flag が優先)。不正値は exit 6
   - **指針本文の差し替え**: `.claude/lib/ja-output-policy.md` を置くと、
     既定の指針の代わりにその内容が出力される (プロジェクト独自の用語規則に対応)
   - marker への記録: `step7_ja_output` / `step7_ja_setting` / `step7_ja_signals`

## 実行

上記 6 ステップ完了後、以下を実行:

```bash
bash scripts/ccagi-protocol-ack.sh \
  --step1 "<MCP 検証結果を 1 行で>" \
  --step2 "declared" \
  --step3 "foreground" \
  --step4 "<スコープ要約を 1 行で>" \
  --step5 "<CLAUDE.md 適用ルール要約を 1 行で>" \
  --step6 "<mode>:<detail>"
```

### 実例

```bash
# Gate A — ブラウザテスト実施 (動画 OFF: ユーザー指示なし)
bash scripts/ccagi-protocol-ack.sh \
  --step1 "ccagi-tools connected" \
  --step2 "declared" \
  --step3 "foreground" \
  --step4 "verify UC02-01 login flow" \
  --step5 "fact-first-execution E1/E2/E3 / work-protocol §2.1" \
  --step6 "browser-test:sequence=UC02-01|videos=off:user-not-requested-video|headed=true"

# Gate A — ブラウザテスト実施 (動画 ON: ユーザー指示あり)
bash scripts/ccagi-protocol-ack.sh \
  --step1 "ccagi-tools connected" \
  --step2 "declared" \
  --step3 "foreground" \
  --step4 "verify UC02-01 login flow with video for review" \
  --step5 "fact-first-execution E1/E2/E3 / work-protocol §2.1" \
  --step6 "browser-test:sequence=UC02-01|videos=.test-logs/videos/|headed=true"

# Gate B — TDD バグ修正 (動画 OFF)
bash scripts/ccagi-protocol-ack.sh \
  --step1 "ccagi-tools connected" \
  --step2 "declared" \
  --step3 "foreground" \
  --step4 "fix login OTP bug (~30 lines)" \
  --step5 "fact-first-execution / scope-contract §3 diff<=50" \
  --step6 "tdd:root-cause=.test-logs/repro.log|fix=src/auth/otp.ts|unit-test=src/auth/otp.test.ts|deploy=.deploy-logs/dev-2026-07-24.log|browser-verify=off:user-not-requested-video"

# Gate C — 対象外
bash scripts/ccagi-protocol-ack.sh \
  --step1 "ccagi-tools connected" \
  --step2 "declared" \
  --step3 "foreground" \
  --step4 "add rule doc (~40 lines, no src/ edits)" \
  --step5 "scope-contract §3 diff<=100" \
  --step6 "off:documentation-only edit, no browser interaction, no bug fix"
```

成功時: `.claude/state/protocol-ack.turn` が生成され、以降のツール使用が解禁されます。

出力末尾に `STEP 7 (日本語出力): 適用 (...)` と指針本文が表示された場合は、
**本ターンの応答文にその指針を反映してください** (宣言や追加コマンドは不要)。

```bash
# STEP 7 を明示的に無効化したい場合のみ
bash scripts/ccagi-protocol-ack.sh ... --ja-output off
```

## PASS 宣言前 3 mandatory (v0.5.0)

`step6_mode` が `tdd` / `browser-test` の場合、応答内で `PASS` / `完璧` / `GREEN` / `verdict:`
を発言する前に、以下 3 マーカーを `ccagi-pre-verdict-audit.sh` で生成する必要があります:

- `.claude/state/tdd-db-probe-verified.turn`
- `.claude/state/tdd-audit-trail-verified.turn`
- `.claude/state/tdd-external-effect-verified.turn`

未生成のまま `PASS` を宣言すると Stop hook が exit 2 で終了を拒否します。

```bash
bash scripts/ccagi-pre-verdict-audit.sh \
  --db-probe "prisma.audit_logs.count invoked=Y (before=100, after=101, delta=1)" \
  --audit-trail "audit_logs.API_CALL_MEIYASU delta=1" \
  --external-effect "実 Lark msgId=om_abc123 到達確認" \
  --uc-coverage "arrows=12 assertions=12 ratio=100%" \
  --verdict "SPEC-PASS"
```

audit 実行不能 (external-effect が該当しない等) の場合は理由を明示:

```bash
bash scripts/ccagi-pre-verdict-audit.sh \
  --db-probe "prisma.audit_logs.count invoked=N (該当なし: read-only 操作)" \
  --audit-trail "該当なし: read-only 操作、audit event 発火せず" \
  --external-effect "該当なし: 外部到達なし" \
  --uc-coverage "arrows=5 assertions=5 ratio=100%" \
  --verdict "UI-PASS"
```

## 自動リセット

このマーカーは **次のユーザー入力時に自動削除** されます (UserPromptSubmit hook)。
つまり **毎ターン再宣言必須** です。プロトコル遵守を構造的に強制します。

## 有効期限

マーカーの `acked_at` は **60 分以内** である必要があります。長時間経過後は再宣言してください。

## 参照

- 設計原則: `CLAUDE.md` の「MANDATORY PRE-WORK CHECKLIST」
- スコープ規則: `.claude/rules/scope-contract.md`
- 事実主義: `.claude/rules/fact-first-execution.md`
- verdict tier 定義: `.claude/rules/verdict-vocabulary.md`
- PASS 前 audit: `.claude/rules/pre-verdict-self-audit.md`
- ゲート実装: `.claude/hooks/protocol-gate.sh` / `.claude/hooks/protocol-stop-gate.sh`
