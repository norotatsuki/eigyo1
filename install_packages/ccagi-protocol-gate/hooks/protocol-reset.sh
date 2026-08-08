#!/usr/bin/env bash
# ccagi-protocol-gate — UserPromptSubmit hook
# 各ユーザー入力ごとにマーカーをリセットし、Claude に再宣言を強制する
set -euo pipefail
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
MARKER="${PROJECT_ROOT}/.claude/state/protocol-ack.turn"
COUNTER="${PROJECT_ROOT}/.claude/state/stop-gate.count"
rm -f "$MARKER" "$COUNTER"
exit 0
