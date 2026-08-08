# ccagi-protocol-gate

> Claude Code の作業前プロトコル (CLAUDE.md STEP 1-6) を**構造的に強制**するフックパッケージ。
> Claude の怠慢・省略を撲滅するための強制ゲート機構。
> STEP 5 でプロジェクト直下 `CLAUDE.md` の毎ターン強制適用 (存在確認 + SHA256 記録) を保証する。
> STEP 6 で「ブラウザ操作テストの証跡」または「TDD バグ修正の 5 フェーズ全証跡」を毎ターン要求し、
> 遅延な `playwright test` (HTTP-only spec の走行) を PreToolUse hook で構造的に BLOCK する。
> v0.5.0 で「動画キャプチャ既定 OFF」+「PASS 宣言前 3 mandatory」を追加。
> v0.7.0 で STEP 7「日本語出力調整ゲート」を追加 (利用者が日本語話者のとき、
> 必要以上の英字・カタカナ表記を抑えた応答へ調整する非阻止の指針を ack 時に提示)。

## 何を解決するか

Claude Code は `CLAUDE.md` に「MANDATORY PRE-WORK CHECKLIST」を書いても、それを **読み物として扱ってしまい**、実行順序として身体化しない傾向がある。結果としてタスク依頼を受けた瞬間に `Read` / `Bash` を並列で呼びに行くなど、プロトコル違反が頻発する。

さらに v0.5.0 では「PASS 判定」を UI navigability レベルで出してしまい、実 DB write や audit trail の verify を系統的に skip していた事故 (2026-07-24 CC AGI TDD Shallow Verify Systematic Failure Report) の再発を、Stop hook の 3 marker enforcement で構造的に防止する。

本パッケージは **hook layer で強制** することで、Claude 側の意志・記憶に依存せずプロトコル遵守を保証する。

## 仕組み

4 層構造:

| Layer | ファイル | Hook Event | 動作 |
|---|---|---|---|
| L1 - Reset | `hooks/protocol-reset.sh` | `UserPromptSubmit` / `SubagentStop` / `PreCompact` / `SessionStart` | ターン開始・sub-agent 終了・context 圧縮・セッション開始でマーカー + stop-gate カウンタを削除。毎ターン再宣言を強制 |
| L2 - Ack | `scripts/ccagi-protocol-ack.sh` | (CLI) | Claude が STEP 1-6 完了を宣言する CLI。6 flag 必須 + CLAUDE.md 存在必須。実行するとマーカー作成 (CLAUDE.md SHA256 も自動記録) |
| L3 - Gate | `hooks/protocol-gate.sh` | `PreToolUse` | matcher `Read\|Edit\|Write\|Bash\|Task\|MultiEdit\|NotebookEdit` に該当する tool 使用時に marker を検査。無効/欠落なら `exit 2` で BLOCK |
| L4 - Stop Gate | `hooks/protocol-stop-gate.sh` | `Stop` | Claude 応答完了の瞬間に marker + PASS 3 mandatory を検査。テキストのみ応答 (tool を呼ばない返答) でも STEP 1-6 を強制。無効/欠落なら `exit 2` で応答終了を拒否。同一ターン内の重複発火は `.claude/state/stop-gate.count` で 2 回まででループ防止 |

**マーカー**: `.claude/state/protocol-ack.turn` (JSON)
```json
{
  "acked_at": "2026-07-24T02:30:00Z",
  "step1_mcp": "ccagi-tools connected",
  "step2_declaration": "declared",
  "step3_mode": "foreground",
  "step4_scope": "add hook X (~40 lines, no src/ edits)",
  "step5_claudemd": "work-protocol §2.1 / scope-contract §3",
  "step5_claudemd_sha": "b3f1…",
  "step6_evidence": "browser-test:sequence=UC02-01|videos=off:user-not-requested-video|headed=true",
  "step6_mode": "browser-test",
  "step6_video_state": "off",
  "step7_ja_output": "on",
  "step7_ja_setting": "auto",
  "step7_ja_signals": "宣言文に かな を検出 / CLAUDE.md の日本語比率=58.7%",
  "protocol_version": "0.7.0"
}
```

**STEP 6 の 3 モード**:

| Mode | 用途 | 形式 |
|---|---|---|
| `browser-test:` | ブラウザ操作テスト実施 | `sequence=<name>\|videos=<path-or-off:reason>\|headed=true` |
| `tdd:` | TDD バグ修正 (完璧な 5 フェーズ) | `root-cause=...\|fix=...\|unit-test=...\|deploy=...\|browser-verify=<video-or-off:reason>` |
| `off:` | 上記どちらでもない | `<8 文字以上の理由>` |

### v0.5.0 変更点: 動画キャプチャ既定 OFF

`videos=` および `browser-verify=` フィールドは 2 形式を許容:

1. `videos=<path>` — ユーザーから動画指示 **あり** の場合。実際の出力先 path を渡す。
2. `videos=off:<8 文字以上の理由>` — ユーザーから動画指示 **なし** の場合。明示的に off を宣言。

デフォルトは OFF。ユーザーが「動画」「キャプチャ」「録画」「video」を明示要求した時のみ ON にする。

**判定基準 (Claude 側の自主判定)**:
- ユーザー発言に「動画で確認したい」「キャプチャを残して」「録画してください」等が含まれる → ON
- 上記の明示指示なし → OFF (`videos=off:user-not-requested-video`)

### v0.5.0 変更点: PASS 宣言前 3 mandatory

`step6_mode` が `tdd` または `browser-test` の場合、応答文中に verdict 系キーワード
(`PASS` / `完璧` / `GREEN` / `verdict:`) を検出した Stop 時点で以下 3 marker を要求:

- `.claude/state/tdd-db-probe-verified.turn`
- `.claude/state/tdd-audit-trail-verified.turn`
- `.claude/state/tdd-external-effect-verified.turn`

これらは `ccagi-pre-verdict-audit.sh` (別パッケージ `tdd-perfection-gate` が提供) が生成する。
3 marker いずれか欠落時は Stop gate が exit 2 で BLOCK。Claude は verdict 表現を訂正するか、
audit script を実行してから応答終了する必要がある。

### v0.7.0 変更点: STEP 7 日本語出力調整ゲート

利用者が日本語話者だと **観測可能な材料から判定できる** 場合、ack 実行時に
「必要以上の英字・カタカナ表記を抑え、文脈を踏まえた平易な日本語で書く」指針を
1 度だけ提示し、marker に判定結果を記録する。

**このゲートは阻止しない (非 BLOCK)。** 応答終了時に禁止語で終了拒否する方式は、
書き直しの繰り返しで処理能力を落とすことが実測されたため採用していない
(2026-07-27 判断 / `plain-japanese-guard` を一括導入から外した経緯と同根)。

判定材料 (1 つでも該当すれば ON):

| # | 材料 | 例 |
|---|---|---|
| 1 | STEP 1-6 の宣言文に ひらがな / カタカナ | `--step4 "設定ファイルの修正"` |
| 2 | `CLAUDE.md` の日本語文字比率 5% 以上 | 日本語比率=58.7% |
| 3 | 環境の言語設定 (`LC_ALL` / `LC_MESSAGES` / `LANG`) が `ja` で始まる | `ja_JP.UTF-8` |
| 4 | macOS の地域設定 `AppleLocale` が `ja` で始まる (1-3 が全て空のときのみ確認) | `ja_JP` |

上書き手段:

```bash
# 強制有効 / 強制無効 (flag が環境変数より優先)
bash scripts/ccagi-protocol-ack.sh ... --ja-output on
bash scripts/ccagi-protocol-ack.sh ... --ja-output off
CCAGI_JA_OUTPUT=off bash scripts/ccagi-protocol-ack.sh ...
```

指針本文をプロジェクト独自に差し替える場合は `.claude/lib/ja-output-policy.md` を置く。
ファイルがあればその内容が既定の指針の代わりに出力される。

marker への記録: `step7_ja_output` (on/off) / `step7_ja_setting` (auto/on/off) /
`step7_ja_signals` (判定材料の内訳)。下流の hook から参照できる。

### Playwright 遅延パス自動 BLOCK

`playwright test` を Bash 経由で呼ぶ場合、次の 2 条件を **両方** 満たさないと BLOCK:
1. `step6_mode == "browser-test"`
2. コマンドに `--headed` / `HEADFUL=1` / `PWDEBUG=1` / `PLAYWRIGHT_HEADLESS=0` のいずれかが付与されている

さらに `step6_video_state == "on"` の場合、`playwright.config.ts` の `video:` フィールドが
`on` / `retain-on-failure` / `on-first-retry` のいずれかに設定されている必要がある。
設定されていなければ BLOCK (「video 撮ると宣言したのに config で off」の齟齬を防止)。

**有効期限**: 60 分。長時間経過後は自動で無効化。

**バイパス**: `Bash` で `ccagi-protocol-ack.sh` / `ccagi-pre-verdict-audit.sh` /
`ccagi-verify-uc-coverage.sh` を呼ぶコマンドのみ、gate を通過できる (再宣言・audit のため)。

## インストール

### このプロジェクト内

```bash
bash install_packages/ccagi-protocol-gate/gate_install.sh
```

### 別プロジェクトへ

```bash
# 方法 A: パッケージディレクトリごとコピー
cp -r install_packages/ccagi-protocol-gate /path/to/other/project/install_packages/
bash /path/to/other/project/install_packages/ccagi-protocol-gate/gate_install.sh

# 方法 B: 直接ターゲット指定
bash install_packages/ccagi-protocol-gate/gate_install.sh /path/to/other/project
```

インストーラが行うこと:

- `.claude/hooks/protocol-gate.sh`, `.claude/hooks/protocol-reset.sh`, `.claude/hooks/protocol-stop-gate.sh` 配備
- `scripts/ccagi-protocol-ack.sh` 配備
- `.claude/commands/ccagi-ack.md` 配備 (slash command)
- `.claude/settings.json` に hook エントリを idempotent に merge (バックアップ生成)
  - `PreToolUse` → `protocol-gate.sh`
  - `Stop` → `protocol-stop-gate.sh` (旧版で登録された Stop→reset は自動除去)
  - `UserPromptSubmit` / `SubagentStop` / `PreCompact` / `SessionStart` → `protocol-reset.sh`
- `.gitignore` に `.claude/state/` 追加

## 使い方 (Claude 側)

### 各ユーザーターンで必ず実施

1. **STEP 1** — MCP 接続確認
   ```
   mcp__ccagi-tools__ccagi__get_status を呼ぶ
   ```

2. **STEP 2** — CC AGI 呼び出し宣言
   > 「CC AGI で作業を開始します」

3. **STEP 3** — 実行方式の宣言
   > フォアグラウンド (デフォルト)

4. **STEP 4** — スコープ契約
   > CHANGE: ... / NOT CHANGE: ... / DIFF BUDGET: ...

5. **STEP 5** — プロジェクト直下 `CLAUDE.md` の強制適用
   > 本ターンのタスクに適用するルールを 1 行で宣言 (例: `"work-protocol §2.1 / scope-contract §3"`)
   > ack script が `CLAUDE.md` の存在と SHA256 を自動記録

6. **STEP 6** — 成果物証跡ゲート (Deliverable Evidence Gate)
   > 本ターンが browser-test / tdd / off のどれに該当するかを宣言
   > 動画キャプチャは既定 OFF。ユーザー指示ありのみ ON。
   > 過去に「ブラウザ操作」指示を HTTP-only spec 走行にすり替えた事故 (`fact-first-execution.md` 違反) を構造的に防止

7. **ゲート解除**
   ```bash
   bash scripts/ccagi-protocol-ack.sh \
     --step1 "ccagi-tools connected" \
     --step2 "declared" \
     --step3 "foreground" \
     --step4 "brief scope description" \
     --step5 "brief CLAUDE.md application summary" \
     --step6 "off:documentation-only edit, no browser, no bug fix"
   ```

### プロトコル違反時の挙動

STEP 1-6 完了前に `Read` 等を呼ぶと:

```
🚫 CCAGI Protocol Gate — BLOCKED (reason: marker-missing)

CLAUDE.md STEP 1-6 が未完了のため、tool 使用を拒否しました。
tool_name: Read

以下を順に実行してください:
  STEP 1: MCP 接続確認
  ...
  STEP 6: 成果物証跡ゲート (browser-test / tdd / off のいずれか)
```

STEP 6 が `browser-test` モードでない状態で `playwright test` を呼ぶと:

```
🚫 CCAGI Protocol Gate — STEP 6 違反 (playwright test を非 browser-test モードで実行)

ブラウザ操作テストを実施するには、STEP 6 を browser-test モードで再宣言する必要があります:
  --step6 "browser-test:sequence=<name>|videos=<path-or-off:reason>|headed=true"
```

`step6_mode == tdd|browser-test` で応答に `PASS` / `完璧` / `GREEN` を含み、
かつ 3 marker が欠落している場合、Stop hook が終了を拒否:

```
🚫 CCAGI Protocol Stop Gate — PASS 宣言前 3 mandatory 違反

以下の必須 marker が生成されていません:
  tdd-db-probe-verified.turn
  tdd-audit-trail-verified.turn
  tdd-external-effect-verified.turn

「PASS」宣言前に必ず以下の 3 マーカーを生成してください:
  bash scripts/ccagi-pre-verdict-audit.sh ...
```

Claude はこの stderr メッセージを受け取り、audit script を実行するか、verdict を訂正してから応答終了する。

## 検証

```bash
bash install_packages/ccagi-protocol-gate/test/test-gate.sh
```

期待結果:
- marker 無しで gate 呼び出し → exit 2 (BLOCK)
- ack script 実行後 → marker 有効
- marker 有りで gate 呼び出し → exit 0 (ALLOW)
- marker 期限切れ (>60 分) → exit 2 (BLOCK)
- videos=off:short (8 文字未満) → exit 5 (BLOCK by ack script)
- videos=<path> → 通過
- tdd モードで PASS を含む応答 + marker 3 個欠 → exit 2 (BLOCK by stop-gate)

## アンインストール

```bash
bash install_packages/ccagi-protocol-gate/uninstall.sh
# or:
bash install_packages/ccagi-protocol-gate/uninstall.sh /path/to/other/project
```

## カスタマイズ

### プロトコル文言変更

`hooks/protocol-gate.sh` の `cat >&2 <<EOF ... EOF` ブロック、および
`scripts/ccagi-protocol-ack.sh` の出力を編集する。

### 有効期限変更

`hooks/protocol-gate.sh` の `MAX_AGE_MIN=60` を編集。

### matcher 変更

Installer 内 `"Read|Edit|Write|Bash|Task|MultiEdit|NotebookEdit"` を編集後に再インストール。

## 依存

- `bash` (>= 4)
- `python3` (>= 3.7 — JSON パース用、標準ライブラリのみ)
- Claude Code 本体の hook 機構

## ライセンス

MIT (推奨)

## Version

0.7.0

### Changelog

- **0.7.0** (2026-07-27):
  - STEP 7「日本語出力調整ゲート」を追加。利用者が日本語話者だと判定できる場合、
    ack 実行時に「必要以上の英字・カタカナ表記を抑え、文脈を踏まえた平易な日本語で書く」
    指針を 1 度だけ提示する。
  - 判定材料は 4 種 (宣言文の かな / `CLAUDE.md` の日本語比率 / 環境の言語設定 / macOS の地域設定)。
    推測ではなく観測可能な材料のみを使う (`fact-first-execution` 準拠)。
  - `--ja-output auto|on|off` と環境変数 `CCAGI_JA_OUTPUT` で上書き可能。不正値は exit 6。
  - 指針本文は `.claude/lib/ja-output-policy.md` を置けばプロジェクト独自の内容に差し替わる。
  - **非阻止**。応答終了時に禁止語で終了拒否する方式は、書き直しの繰り返しで
    処理能力を落とすことが実測されたため採用しない (`plain-japanese-guard` を
    一括導入から外した 2026-07-27 の判断と同根)。
  - marker に `step7_ja_output` / `step7_ja_setting` / `step7_ja_signals` を記録。
    `protocol_version` を `0.7.0` に更新。
- **0.5.0** (2026-07-24):
  - 動画キャプチャ既定 OFF: `videos=off:<8文字以上の理由>` を明示的に許容。ユーザー指示ありの時のみ path を渡す。
  - PASS 宣言前 3 mandatory: `tdd` / `browser-test` モードで verdict 系キーワード検出時、
    `tdd-db-probe-verified.turn` / `tdd-audit-trail-verified.turn` / `tdd-external-effect-verified.turn`
    3 marker の存在を Stop gate で要求。欠落時は exit 2 で BLOCK。
  - `playwright.config.ts` の `video:` 設定検査を追加 (video 撮ると宣言したのに config で off の齟齬を防止)。
  - 過去事故 (request copy/20260724: 「PASS 8/8 完璧 GREEN」宣言が UI navigability レベルの verify のみだった事案) の構造的再発防止。
- **0.4.0** (2026-07-23): STEP 6 追加 (成果物証跡ゲート)。browser-test / tdd / off の 3 モード。
  `playwright test` の遅延呼び出しを PreToolUse hook で構造的に BLOCK。
  過去事故 (request copy/20260723: HTTP-only spec 走行で虚偽 137 tests PASS 報告) の再発防止。
- **0.3.0**: STEP 5 追加 (CLAUDE.md 強制適用 + SHA256 記録)、Stop hook 追加。
- **0.2.0**: Stop event に stop-gate.sh を配置、旧 Stop→reset を自動 migrate。
- **0.1.0**: 初版 (PreToolUse gate + UserPromptSubmit reset)。

## 参照

- 設計原則: `CLAUDE.md` の「MANDATORY PRE-WORK CHECKLIST」
- スコープ規則: `.claude/rules/scope-contract.md`
- Claude Code hooks: <https://docs.claude.com/en/docs/claude-code/hooks>
- 失敗レポート: `request copy/20260724/2026-07-24_CC-AGI-TDD-Shallow-Verify-Systematic-Failure-Report.md`
- 関連パッケージ: `tdd-perfection-gate` (5 rule + audit CLI + helper scaffold), `plain-japanese-guard` (jargon 禁止)
