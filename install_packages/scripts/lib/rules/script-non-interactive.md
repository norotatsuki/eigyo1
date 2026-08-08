# script-non-interactive

> Bootstrap / init / setup 用の自動化スクリプトは 100% 非対話であること。expect(1) の単独依存を禁止し、CLI flags + yes(1) + timeout(1) の 3 層防御を必須化する。

**Trigger**: script, bootstrap, init, interactive, prompt, expect, hang, auto-yes, 非対話

## 0. 原則

> "A script that can hang on a prompt is not automation — it is a landmine."

- **hang するスクリプトは自動化とは呼ばない**
- 「対話プロンプトが出たら手動で応答する」設計は禁止
- 対話プロンプト全てに応答 (yes / default) する仕組みが実装されていないなら、そのスクリプトはリリース不可
- **expect(1) の regex マッチ**は Tcl の UTF-8 handling 依存で inquirer 系プロンプト
 (`›` U+203A, `❯` U+276F, `▶` U+25B6, `»` U+00BB) を捕捉失敗するケースがある → 単独依存禁止

## 1. 3 層防御 (必須)

自動化スクリプトが外部 CLI (`ccagi-sdk init`, `npm init`, `gh auth login` 等) を呼ぶ場合、以下 3 層全てを実装する:

| Layer | 手段 | 目的 |
|---|---|---|
| **L1** | CLI フラグ (`--name`, `--yes`, `--no-issue` 等) | flag で skip 可能なプロンプトを構造的に排除 |
| **L2** | `yes(1)` の pipe (`yes y \| ...` / `yes '' \| ...`) | flag で skip 不能な Y/N プロンプトに y 応答 |
| **L3** | `timeout(1)` によるハードカット | hang を検知して有限時間で強制終了 (fail-fast) |

3 層のうちどれか 1 つでも欠けたら、そのスクリプトは仕様違反として扱う。

### Canonical Pattern (bash) — PIPESTATUS 版 (推奨・確定形)

```bash
local timeout_sec="${TIMEOUT_SEC:-300}"

# PIPESTATUS[1] で timeout(some-cli) の rc のみ取得
# yes(1) 側の SIGPIPE(141) は PIPESTATUS[0] に入り無視される
# → pipefail 有効 (`set -Eeuo pipefail`) でも yes SIGPIPE で疑陽性 141 が起こらない
set +e
yes y | timeout "$timeout_sec" some-cli init --name "$name" --no-issue --yes
local rc=${PIPESTATUS[1]}
set -e

case "$rc" in
    0)   ok "some-cli init 完了" ;;
    124) err "TIMEOUT ($timeout_sec s) — 未処理プロンプトが残存"; exit 7 ;;
    *)   warn "some-cli init が rc=$rc で終了 (already-init など)。続行"     ;;
esac
```

**重要 (bash SIGPIPE トリック)**:

- `set -Eeuo pipefail` が有効な状態で `yes | cmd` を実行すると、cmd 終了時に yes が SIGPIPE (rc=141) で殺される。pipefail は「pipe 内 max non-zero rc」を採用するため、cmd rc=0 でも pipeline rc=141 になる (**疑陽性**)。
- **修正 1** (推奨): `PIPESTATUS[N]` で「本当に判断したいコマンド」の rc を直接指定する。yes は index 0、cmd (or timeout) は index 1。
- **修正 2** (fallback): グローバル `trap ERR` に SIGPIPE(141) / SIGINT(130) フィルタを入れる:
  ```bash
  trap '_rc=$?; { [[ $_rc == 141 ]] || [[ $_rc == 130 ]]; } || err "line $LINENO: exit $_rc"' ERR
  ```
- **禁止**: `case "$rc" in 0|141)` で 141 を成功扱いする素朴パターン。cmd rc=X (X>0, X<141) と yes SIGPIPE 141 が混在すると **X が pipeline rc として見えなくなり** silent-fail する。

### 実装例 (このプロジェクトの正典)

- `scripts/ccagi-bootstrap.sh:step2_init()` — `yes y | timeout 300 ccagi-sdk init --name X --no-issue`

## 2. 禁止パターン (Anti-Patterns)

| 禁止 | 理由 | 代替 |
|---|---|---|
| `expect(1)` を単独で使う (regex マッチのみ) | Tcl の UTF-8 handling で `›` 等の inquirer 用シンボルを捉え損なう。過去実績あり (2026-07-10 bootstrap hang) | 3 層防御に置換 |
| CLI flag だけに頼る (`--name X` のみ) | 新しい prompt が SDK 側で増えた瞬間 hang | + `yes(1)` pipe を必ず併用 |
| timeout なしで interactive CLI を呼ぶ | 1 プロンプト放置で無限ハング | `timeout N cmd` で有限化 |
| stdin を TTY にしたまま `yes` pipe を省略 | inquirer は TTY 検知して人間入力を待つ | `yes y \| cmd` で pipe 化 |
| 「デバッグ時は expect の match_default を手動確認」 | 半自動化。運用時に再発 | 完全非対話にする |
| `--no-verify` / `--skip-check` で SDK 側のチェックまで bypass | セキュリティ / 品質チェックまで殺す | prompt だけ skip する flag を選ぶ |

## 3. 新規プロンプトが SDK 側に増えた時の対応フロー

CLI ツール側 (`ccagi-sdk`, `npm`, `gh`, etc.) の新バージョンで prompt が増えて timeout する場合:

1. `<cli> <subcommand> --help` で新規追加 flag を確認
2. **L1 (flag)** に該当 flag を追加できるなら追加
3. できない場合は **L2 (`yes`)** で "y" 応答されて問題無いか検証
4. 応答が "y" ではまずいテキストプロンプト (パス指定、名前入力等) が増えた場合は、そのプロンプトに対応する専用 flag を SDK 側に PR
5. 上記いずれも取れない場合 (SDK 側修正待ち)、`--skip-<step>` 系 flag で当該 step 自体を skip する暫定回避
6. 判断結果を **必ず memory (`feedback` type)** に記録: 「why we added `--foo` in step2_init」

## 4. Pre-commit 自動 Gate (推奨実装)

`scripts/**/*.sh` に対して以下を静的チェックする pre-commit hook を推奨:

- 外部 CLI を呼ぶ行に `timeout` の prefix があるか
- Y/N プロンプトを持ちうる CLI 呼出に `yes` の pipe があるか、または `--yes` / `--no-issue` 等の非対話 flag があるか
- `expect` の呼出があれば warn (非推奨、廃止対象)

該当スクリプトが Gate を通らない場合は commit block (推奨閾値: warn → 1週間後 block 昇格)。

## 5. Quick Reference — 着手前 4 秒チェック

自動化スクリプトを新規/修正する前に:

1. ✅ **CLI flag で skip 可能な prompt を全て skip したか** (L1)
2. ✅ **残る prompt に `yes(1)` pipe で応答したか** (L2)
3. ✅ **`timeout(1)` で有限化したか** (L3)
4. ✅ **hang したときの復旧手順が実装されているか** (rc=124 の分岐)

1 つでも欠けていたらリリースしない。

## 6. 学びの出典

- **2026-07-10 ccagi-bootstrap.sh Step #2 hang 事故**
 - `expect(1)` の `-re {›}` パターンが Tcl UTF-8 handling で inquirer プロンプトを捉え損なう
 - `ccagi-sdk init` の対話プロンプト「? プロジェクト名 (20260710) ›」で無限ハング
 - 一次修正 (`--name` のみ) は Step #2 直後のプロンプトが増えた場合に再発
 - 根本対処: 3 層防御 (flags + yes + timeout) に切替
- 関連ルール: [[ccagi-work-protocol]] (対話プロンプトを含むと 10% 進捗報告が止まる問題)

---
*CCAGI SDK — Script Non-Interactive Rule*
