#!/usr/bin/env bash
# ccagi-protocol-gate — installer (v0.5.0)
#
# 使い方:
#   bash gate_install.sh [対象プロジェクトの絶対パス]
set -Eeuo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
source "$SRC/../lib/common-install.sh"

VERSION="$(cat "$SRC/VERSION" 2>/dev/null || echo unknown)"
cci_setup_target "${1:-}" "CC AGI 手続き門 (ccagi-protocol-gate)" "$VERSION"

# ---- 割込動作 3 個 ---------------------------------------------------------
cci_place_file 0755 "$SRC/hooks/protocol-gate.sh"      "$TARGET/.claude/hooks/protocol-gate.sh"
cci_place_file 0755 "$SRC/hooks/protocol-reset.sh"     "$TARGET/.claude/hooks/protocol-reset.sh"
cci_place_file 0755 "$SRC/hooks/protocol-stop-gate.sh" "$TARGET/.claude/hooks/protocol-stop-gate.sh"

# ---- 補助 CLI --------------------------------------------------------------
cci_place_file 0755 "$SRC/scripts/ccagi-protocol-ack.sh" "$TARGET/scripts/ccagi-protocol-ack.sh"

# ---- スラッシュ命令 --------------------------------------------------------
cci_place_file 0644 "$SRC/commands/ccagi-ack.md" "$TARGET/.claude/commands/ccagi-ack.md"

# ---- 動作目印 用 ディレクトリ ---------------------------------------------
mkdir -p "$TARGET/.claude/state"

# ---- .gitignore 追記 ------------------------------------------------------
cci_add_gitignore_pattern ".claude/state/" "$PACKAGE_NAME 動作目印"

# ---- settings.json 待避 + 割込動作 合流 -----------------------------------
cci_backup_settings_json

GATE_CMD='${CLAUDE_PROJECT_DIR}/.claude/hooks/protocol-gate.sh'
RESET_CMD='${CLAUDE_PROJECT_DIR}/.claude/hooks/protocol-reset.sh'
STOP_CMD='${CLAUDE_PROJECT_DIR}/.claude/hooks/protocol-stop-gate.sh'

# 移行: v0.1.0 では Stop に reset.sh を掛けていたが、v0.2.0 以降は stop-gate.sh。
# 二重登録すると競合するので、旧登録があれば削除する。
cci_remove_settings_hook Stop "$RESET_CMD"

# PreToolUse: 安全対象 ツール のみを 対象化 (matcher 指定)
cci_add_settings_hook PreToolUse "$GATE_CMD" 10 "Read|Edit|Write|Bash|Task|MultiEdit|NotebookEdit"

# Stop: 応答完了 時点で STEP 1-6 を強制
cci_add_settings_hook Stop "$STOP_CMD" 10

# 動作目印 再生成 の 4 事象
for ev in UserPromptSubmit SubagentStop PreCompact SessionStart; do
  cci_add_settings_hook "$ev" "$RESET_CMD" 5
done

cat <<EOF

登録された 門 と 再生成 の 構造:
  🚧 PreToolUse       → protocol-gate.sh       (Read|Edit|Write|Bash|Task|MultiEdit|NotebookEdit)
  🚦 Stop             → protocol-stop-gate.sh  (応答完了時に STEP 1-6 を強制)
  🔄 UserPromptSubmit → protocol-reset.sh      (新規 入力ごと)
  🔄 SubagentStop     → protocol-reset.sh      (副 エージェント 終了直後)
  🔄 PreCompact       → protocol-reset.sh      (会話 圧縮 直前)
  🔄 SessionStart     → protocol-reset.sh      (新 一連の作業 開始)

⇒ Claude が回答した瞬間に 動作目印 が消滅し、次の ツール 呼び出しは必ず
   CLAUDE.md STEP 1-6 の再宣言を要求されます。

STEP 6 (v0.4.0 追加):
  🎥 browser-test 態勢 → 可視 閲覧器 + 動画 記録 証跡を必須化
  🧪 tdd 態勢         → 根本原因→改修→単体 試験→展開→閲覧器 検証 の 5 証跡
  📝 off 態勢         → 上記どちらでもない (ドキュメント/設定編集など)
  🚫 playwright test の 手抜き 呼び出しは PreToolUse 割込動作 で自動阻止

次の 手順:
  1. 新しい Claude Code の 一連の作業 を開始
  2. Read / Edit / Bash 等の ツール が「Protocol Gate — BLOCKED」で拒否されることを確認
  3. STEP 1-6 を実行後、次で 門 を解除:

     bash scripts/ccagi-protocol-ack.sh \\
       --step1 "verified" --step2 "declared" \\
       --step3 "foreground" --step4 "<scope>" \\
       --step5 "<CLAUDE.md 適用ルール>" \\
       --step6 "<browser-test:...|tdd:...|off:...>"

  4. または スラッシュ命令: /ccagi-ack を実行 (手順ガイド)

EOF

cci_done_message "$SRC/uninstall.sh"
