#!/usr/bin/env bash
# info-public-guard — uninstaller
#
# Usage:
#   bash uninstall.sh [TARGET_PROJECT_ROOT]
set -euo pipefail

TARGET="${1:-$(pwd)}"
RULE_BASENAME="info-public-guard.md"
RULE_DST="$TARGET/.claude/rules/$RULE_BASENAME"
CLAUDE_MD="$TARGET/CLAUDE.md"
IMPORT_LINE="@import .claude/rules/$RULE_BASENAME"

echo "🗑  info-public-guard uninstaller"
echo "   target: $TARGET"
echo ""

# 1. CLAUDE.md から @import 行を削除
if [ -f "$CLAUDE_MD" ]; then
  if grep -qxF "$IMPORT_LINE" "$CLAUDE_MD"; then
    BACKUP="$CLAUDE_MD.bak.$(date -u +%Y%m%dT%H%M%SZ)"
    cp "$CLAUDE_MD" "$BACKUP"
    echo "  ✓ CLAUDE.md バックアップ: $BACKUP"

    IMPORT_LINE="$IMPORT_LINE" CLAUDE_MD="$CLAUDE_MD" python3 - <<'PY'
import os
path = os.environ["CLAUDE_MD"]
line = os.environ["IMPORT_LINE"]
with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()
kept = [l for l in lines if l.rstrip("\n") != line]
with open(path, "w", encoding="utf-8") as f:
    f.writelines(kept)
PY
    echo "  ✓ CLAUDE.md から @import 行削除"
  else
    echo "  = CLAUDE.md に @import 行が無い。スキップ"
  fi
else
  echo "  = CLAUDE.md が存在しない。スキップ"
fi

# 2. ルールファイル削除
if [ -f "$RULE_DST" ]; then
  rm -f "$RULE_DST"
  echo "  ✓ ルールファイル削除: $RULE_DST"
else
  echo "  = ルールファイルが存在しない。スキップ"
fi

echo ""
echo "✅ アンインストール完了"
echo "   注: CLAUDE.md のバックアップは残しています (手動で削除してください)"
