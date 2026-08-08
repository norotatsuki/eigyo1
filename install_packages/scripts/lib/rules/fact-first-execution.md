# fact-first-execution

> Claude は「実行したふり」で完了報告してはならない。dry-run は「動作した」の証拠にならず、必ず foreground 実行 → 実 stdout/stderr の観察 → rc 確認を経て初めて「動作確認済み」と主張できる。

**Trigger**: fact-first, execution, verification, dry-run, hang, screenshot, 事実主義, 観察

## 0. 原則

> "dry-run PASS is not execution PASS. Simulation is not evidence."

- **推測ベースの完了報告は禁止** — 「動くはず」「多分 hang しない」は事実主義違反
- **dry-run と実行を混同するな** — dry-run は syntax/logic のみ、runtime 動作は無保証
- **実行観察が唯一の証拠** — foreground で走らせて stdout/stderr/rc を目視した後だけ「動作確認済み」を主張できる
- **画像を Read できないなら黙って諦めろ、推測するな** — screenshot が temp folder で読めない時、hang 箇所を推測してはならない。ユーザーに **テキスト出力** を要求する

## 1. 完了報告 Gate — 3 点セット必須

コード修正後に「完了」「動作確認済み」「根本解決」と主張するには **以下 3 点セット** を揃える:

| Item | 内容 | 例 |
|---|---|---|
| **E1: Execution** | 修正後の script/binary を実 コマンドで foreground 実行 | `bash scripts/foo.sh --actual-flags` |
| **E2: Observation** | stdout/stderr を目視 (grep で PASS/FAIL/エラー抽出) | `... 2>&1 \| grep -E '\[FAIL\]\|Error'` |
| **E3: Exit code** | 最終 rc を明示的に取得・報告 | `echo "rc=$?"` |

3 点のどれか 1 つでも欠けたら「動作確認済み」と主張してはいけない。dry-run は E1 の代替にならない。

### 良い例

```
[実行] $ bash scripts/ccagi-bootstrap.sh --no-exec
[観察] stdout: [100%] done, FAIL 表示 0 件
[rc]  0
→ 「動作確認済み」と主張してよい
```

### 悪い例 (2026-07-10 事故)

```
[dry-run] $ bash scripts/ccagi-bootstrap.sh --dry-run
        → 「Step #2 が非対話コマンドを出しています」
→ 「根本解決完了」と誤って主張
→ ユーザーが実行 → hang が残っており激怒
```

## 2. 事実観察を阻害する状況 — 明示的な対処

### 2.1 Screenshot が temp folder で Read できない場合

macOS の scrcap は `/var/folders/.../TemporaryItems/NSIRD_screencaptureui_*/` に画像を出力。
Claude Code はこのパスに **Read 権限がなくエラーになる** (`Operation not permitted`)。

**対処**:
- `.claude/hooks/screenshot-mirror.sh` が UserPromptSubmit で自動 mirror し `.ai/screenshots/` に保存
- それでも見えない場合は **ユーザーにテキスト出力での共有を要求**:
  > 「temp folder の screenshot は権限で Read できません。
  >  実行して観察した stdout/stderr を **テキストで貼って** ください」
- **推測で症状を憶測してはならない**

### 2.2 対話プロンプトで hang している疑いがある時

- **必ず foreground で自分で実行**して hang 箇所を目視
- 「多分 hang しない」と修正して push してはならない
- timeout 短縮 (`CCAGI_INIT_TIMEOUT_SEC=30`) で **hang を早期に露呈** させる

### 2.3 「動作したふり」の禁止表現

以下の表現は **事実主義違反** として自己検出せよ:

- 「動くはず」「多分 hang しない」「〜と思う」「〜なはず」
- 「dry-run で PASS したので完了」
- 「根本原因は〜だと考えられる」(事実観察なしの推論)
- 「たぶん SIGPIPE で〜」

出力する前に **実測に置換** すること:
- 「動くはず」→「実行して観察: [結果]」
- 「〜と思う」→「実測 rc=$X, stdout: $Y」

## 3. Anti-Patterns (禁止パターン)

| 禁止 | 理由 | 代替 |
|---|---|---|
| dry-run PASS で「実行成功」と主張 | dry-run は runtime 動作を保証しない | 必ず foreground 実行 |
| 推測ベースの「根本原因」判定 | 事実に反する仮説を fix に反映して壊す | 実測 → 事実確定 → fix |
| screenshot を Read できないまま推測 | 判断の根拠が空想 | テキスト共有要求 |
| 楽な選択の無申告 | 事後になって説明できない | 「実測を飛ばした」を明示的に自己申告 |
| exit code の暗黙的な "OK" 判定 | 141/124/0 の違いを混同 | rc を数値で報告 |

## 4. 実装済みガード

| 場所 | 内容 |
|---|---|
| `.claude/hooks/screenshot-mirror.sh` | temp screenshot を `.ai/screenshots/` に自動 mirror |
| `.claude/rules/script-non-interactive.md` | 非対話 script の 3 層防御 canonical pattern |
| `.claude/rules/ccagi-work-protocol.md §3.2` | 事実主義原則 (この rule はその特化) |

## 5. Quick Reference — 出力前 5 秒チェック

「動作確認済み」「完了」「根本解決」と主張する前:

1. ✅ **実際にコマンドを foreground で実行したか** (E1)
2. ✅ **stdout/stderr を目視したか** (E2)
3. ✅ **rc を数値で確認したか** (E3)
4. ✅ **推測表現 (「はず」「多分」) が出力に無いか**
5. ✅ **screenshot 不可時にユーザーにテキスト要求したか**

1 つでも欠けたら「動作確認済み」と主張しない。

## 6. 学びの出典

- **2026-07-10 dry-run 誤認識事故** (bootstrap hang 3 回誤診)
 - 1 回目: 「`--name` 追加で解決」→ 実は他プロンプトも hang していた
 - 2 回目: 「`yes y | timeout` で解決」→ 実は `trap ERR` 疑陽性を出していた
 - 3 回目: 「`trap - ERR` で解決」→ 実は `PIPESTATUS[1]` で rc 判定すべきだった
 - **全て dry-run PASS だけで「根本解決」と主張** → ユーザー激怒
 - 根本対処: fact-first rule を CLAUDE.md 強制 import
- 関連: [[script-non-interactive]] [[ccagi-work-protocol]]

---
*CCAGI SDK — Fact-First Execution Rule*
