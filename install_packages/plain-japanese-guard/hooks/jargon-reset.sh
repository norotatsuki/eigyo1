#!/usr/bin/env bash
# jargon-reset — UserPromptSubmit / SessionStart hook
# 各ターン開始時に jargon-detect カウンタをリセットする。
set -euo pipefail
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
COUNTER="${PROJECT_ROOT}/.claude/state/jargon-detect.count"
rm -f "$COUNTER"
exit 0
