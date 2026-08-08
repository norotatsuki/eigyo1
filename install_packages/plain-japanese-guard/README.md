# plain-japanese-guard

> Claude Code の全出力から、一般的な日本人が理解しにくい カタカナ / 横文字 / ジャーゴンを構造的に排除するパッケージ。
> Stop hook で応答文をスキャンし、禁止語検出時は exit 2 で応答終了を拒否。

## 何を解決するか

Claude Code の日本語応答は「オルタナティブ」「オンボーディング」「アサイン」「シナジー」等の
カタカナ英語を多用しがち。技術文脈では通じても、顧客向け説明や 非 IT 部署への
展開時に理解を阻害する。

本パッケージは:

1. **rule 文書** (`plain-japanese.md`) で判定原則を CLAUDE.md @import で強制
2. **禁止語辞書** (`jargon-list.txt`) で ~200 語 + 推奨言換候補を curated 保持
3. **Stop hook** (`jargon-detect.sh`) で応答文をスキャンし exit 2 で終了拒否
4. **手動スキャン CLI** (`jargon-scan.sh`) で任意テキストの事前チェック

## 判定原則

3 段階判定 (順に適用):

| 判定 | 対象 | 扱い | 例 |
|---|---|---|---|
| 判定 1 | 固有名詞・技術用語 | そのまま OK | TypeScript / Playwright / JSON / API / URL |
| 判定 2 | 定着済み外来語 | そのまま OK | テスト / バグ / ファイル / メール / データ |
| 判定 3 | 和語・漢語代替可能なカタカナ | 必ず言換 | アサイン→割り当て / シナジー→相乗効果 |

## パッケージ内容

```
plain-japanese-guard/
├── VERSION                  # 1.0.0
├── README.md
├── install.sh               # インストーラ
├── uninstall.sh             # アンインストーラ
├── rules/
│   └── plain-japanese.md    # CLAUDE.md @import 対象
├── lib/
│   └── jargon-list.txt      # 禁止語辞書 (~200 語 + 推奨言換 + 理由)
├── hooks/
│   ├── jargon-detect.sh     # Stop hook (応答文スキャン + BLOCK)
│   └── jargon-reset.sh      # UserPromptSubmit / SessionStart hook
├── scripts/
│   └── jargon-scan.sh       # 手動スキャン CLI
└── test/
    └── test-install.sh      # self-test
```

## インストール

```bash
# このプロジェクト内
bash install_packages/plain-japanese-guard/install.sh

# 別プロジェクトへ
bash install_packages/plain-japanese-guard/install.sh /path/to/other/project
```

インストーラが行うこと:

- `.claude/rules/plain-japanese.md` 配備
- `.claude/lib/jargon-list.txt` 配備
- `.claude/hooks/jargon-detect.sh` / `jargon-reset.sh` 配備
- `scripts/jargon-scan.sh` 配備
- `.claude/settings.json` に hook エントリを idempotent に merge
  - `Stop` → `jargon-detect.sh`
  - `UserPromptSubmit` → `jargon-reset.sh`
  - `SessionStart` → `jargon-reset.sh`
- `CLAUDE.md` に `@import .claude/rules/plain-japanese.md` を追記
- `.gitignore` に `.claude/state/jargon-*.count` 追加

## 動作イメージ

Claude が応答内で「オンボーディングフローを最適化してアサインを再検討します」と書いた場合:

```
🚫 plain-japanese-guard — 応答終了拒否 (禁止カタカナ / ジャーゴン検出)

Claude 応答文中に、一般的な日本人が理解しにくい禁止語を検出しました。
以下を和語・漢語に言換してから応答を再送信してください:

  ❌ オンボーディング      → 受け入れ  (新規参加者の受け入れ)
  ❌ フロー                → 流れ
  ❌ 最適化                 → 改善・最適化  (「最適化」自体は許容だが多用時のみ)
  ❌ アサイン               → 割り当て  (担当を割り当てる意)

------------------------------------------------------------------------
判定原則 (.claude/rules/plain-japanese.md 参照):
  1. 固有名詞 (TypeScript / Playwright 等) はそのまま OK
  2. 定着済み外来語 (テスト / バグ / メール 等) はそのまま OK
  3. 判定 3 で 和語・漢語代替可能なカタカナは 必ず言換
------------------------------------------------------------------------

例外を宣言する場合:
  - 応答内に「※本応答で「<語>」を使用しています。<理由>」を明示
  - または環境変数 CCAGI_JARGON_ACK=1 を設定して再実行 (session 単位の bypass)
  - または CCAGI_JARGON_MODE=warn (block ではなく警告のみに切替)
```

Claude はこれを受け取り、「受け入れ手順を改善して、担当の割り当てを再検討します」と
言い換えて再応答する。

## 環境変数による制御

| 変数 | default | 意味 |
|---|---|---|
| `CCAGI_JARGON_ACK` | `0` | `1` で session 単位 bypass (ユーザー明示例外) |
| `CCAGI_JARGON_MODE` | `block` | `warn` で block ではなく警告のみ (exit 0 で通過) |
| `CCAGI_JARGON_LIST` | `.claude/lib/jargon-list.txt` | 禁止語辞書ファイルの override |
| `CCAGI_JARGON_SKIP_ON_COMPLETION` | `1` | v1.1.0: 完了 phase 検出時に warn へ自動 downgrade (`0` で無効化) |
| `CCAGI_JARGON_COMPLETION_PATTERNS` | `.claude/lib/jargon-completion-patterns.txt` | 完了 pattern ファイルの override |
| `CCAGI_JARGON_MAX_STOP_BLOCKS` | `2` (v1.0.0 は `3`) | 同一ターン内 BLOCK 上限。到達で自動 pass |
| `CCAGI_JARGON_QUIET` | `0` | `1` で BLOCK 上限到達時の stderr 通知を抑制 |

## 手動スキャン CLI

```bash
# ファイルスキャン
bash scripts/jargon-scan.sh docs/example.md README.md

# 標準入力から
echo "アサインしました" | bash scripts/jargon-scan.sh -

# CI 統合例
find docs/ -name '*.md' | xargs bash scripts/jargon-scan.sh
```

## 誤検知緩和

- 同一ターン内で 2 回連続 BLOCK した場合、自動 pass (無限ループ防止, v1.0.0 は 3 回)
- **completion-safe mode (v1.1.0)**: Claude 応答文中に「完了報告」「以上」「[100%]」等の
  完了 pattern が検出された場合、BLOCK を skip し warn へ自動 downgrade
  (作業完了直前の報告での BLOCK loop 事故を script-level で回避)
- transcript 取得失敗時は skip (fail-safe: 動作を止めない)
- jargon-list.txt 不存在時は skip (fail-safe)
- `CCAGI_JARGON_ACK=1` で session 単位 bypass 可能

### 完了 pattern のカスタマイズ

`.claude/lib/jargon-completion-patterns.txt` に 1 行 1 pattern (python re.IGNORECASE)
を追記すると、既定 pattern に加えてマッチ対象になる。

```bash
# project 固有の完了 marker を追加
echo 'デプロイ完了' >> .claude/lib/jargon-completion-patterns.txt
echo 'マージ完了'   >> .claude/lib/jargon-completion-patterns.txt

# 検証
echo "デプロイ完了 (アサインしました)" | \
  cat -  # (hook 経由のシミュレーション、詳細は test-install.sh 参照)
```

completion-safe を全面無効にするには:

```bash
export CCAGI_JARGON_SKIP_ON_COMPLETION=0
```

## 辞書のカスタマイズ

`.claude/lib/jargon-list.txt` を編集して project 固有の追加/削除:

```
# 追加
コミッター\t約束者\t関係者リスト
# 削除 (行頭 # でコメント化)
# アーキテクチャ\t構成\t許容ラインだが冗長多用時のみ
```

TSV 形式: `<禁止語>\t<推奨言換>\t<理由>`
コメント (`#`) と 空行は無視。

## アンインストール

```bash
bash install_packages/plain-japanese-guard/uninstall.sh
# または:
bash install_packages/plain-japanese-guard/uninstall.sh /path/to/other/project
```

## 依存

- `bash` (>= 4)
- `python3` (>= 3.7 — JSON パース + TSV 解析用)
- Claude Code 本体の hook 機構

## ライセンス

MIT

## Version

1.1.0

### Changelog

- **1.1.0** (2026-07-26) — completion-safe mode
  - hooks/jargon-detect.sh に completion-safe detection を追加
    - 応答文中に「完了報告」「以上」「[100%]」「All tests PASS」「N/N tests PASS」等の
      完了 pattern を検出した場合、BLOCK を skip し warn へ自動 downgrade
    - 作業完了直前の BLOCK loop で 1 session が無駄に長くなる事故 (2026-07-26 ユーザー訴え) 対応
  - lib/jargon-completion-patterns.txt (project 拡張用完了 pattern file) 新規
  - 同一ターン内 BLOCK 上限を default 3 → 2 に短縮 (より速く escape)
  - 環境変数追加:
    - `CCAGI_JARGON_SKIP_ON_COMPLETION` (default `1`, `0` で無効化)
    - `CCAGI_JARGON_COMPLETION_PATTERNS` (pattern file の path override)
    - `CCAGI_JARGON_MAX_STOP_BLOCKS` (BLOCK 上限を戻すため)
    - `CCAGI_JARGON_QUIET` (BLOCK 上限到達時の stderr 通知を抑制)
  - rule (`plain-japanese.md`) に §7.5 completion-safe mode を追記

- **1.0.0** (2026-07-24) — 初版
  - rules/plain-japanese.md (判定 3 原則)
  - lib/jargon-list.txt (~200 語 + 推奨言換 + 理由)
  - hooks/jargon-detect.sh (Stop hook, exit 2 BLOCK)
  - hooks/jargon-reset.sh (UserPromptSubmit / SessionStart カウンタリセット)
  - scripts/jargon-scan.sh (手動 CLI)
  - ユーザー明示要求 (2026-07-24) 対応

## 参照

- ユーザー要求 (2026-07-24): 「全ての出力にジャーゴンや、一般的な日本人が理解できない横文字表記を全て禁止する」
- 関連: `ccagi-protocol-gate v0.5.0` (Stop hook 共存可能)
- 関連: `info-public-guard` (外部公開時のジャーゴン排除)

---

## v1.5.0 — 誤検出の解消と、例外宣言の実装

### 1. 判定原則どおり、地の文だけを検査する

`plain-japanese.md` の判定原則 1 は「固有名詞・ファイル名・パス・コマンド・
コード上の識別子はそのまま可」と定めていましたが、検出側が素の文字列一致で
あったため、コード塊やファイル名の中の識別子まで禁止語として拾っていました。

v1.5.0 では判定前に以下を検査対象から除去します。

- 囲み記号つきコード塊 / 行内のコード引用
- 引用行 (行頭 `>`)
- 拡張子つきのファイル名・パス
- 素で書かれたコマンド行 (`bash ...` / `npm ...` / `python3 ...` 等)

### 2. 例外宣言を実装

案内文には以前から書かれていたものの、**実際には解釈されていませんでした**。
v1.5.0 で解釈するようになります。

```
※本応答で「サニタイズ」を使用しています。XSS 対策の文脈で通じるためです。
```

1 つの宣言に鉤括弧を複数並べれば、まとめて対象外にできます。

### 3. 語の衝突を解消

`defer` の言換え先が「先送り」でしたが、これは完璧テスト駆動の
途中打切り検出係が禁止語として持つ語です。指示どおり言い換えると
もう一方に阻止される、どちらにも従えない組み合わせでした。
言換え先を「先延ばし」に変更して解消しています。
