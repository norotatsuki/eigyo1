#!/usr/bin/env bash
# ccagi-protocol-gate — uninstaller
#
# Usage:
#   bash uninstall.sh [TARGET_PROJECT_ROOT]
set -euo pipefail

TARGET="${1:-$(pwd)}"

if [ ! -d "$TARGET" ]; then
  echo "❌ Target not found: $TARGET" >&2
  exit 1
fi

echo "🗑  ccagi-protocol-gate uninstaller"
echo "   target: $TARGET"

# ファイル削除
for f in \
  ".claude/hooks/protocol-gate.sh" \
  ".claude/hooks/protocol-reset.sh" \
  ".claude/hooks/protocol-stop-gate.sh" \
  "scripts/ccagi-protocol-ack.sh" \
  ".claude/commands/ccagi-ack.md" \
  ".claude/state/protocol-ack.turn" \
  ".claude/state/stop-gate.count" \
  ".claude/state/tdd-db-probe-verified.turn" \
  ".claude/state/tdd-audit-trail-verified.turn" \
  ".claude/state/tdd-external-effect-verified.turn"
do
  if [ -e "$TARGET/$f" ]; then
    rm -f "$TARGET/$f"
    echo "  ✓ 削除: $f"
  fi
done

# settings.json からエントリ除去
SETTINGS="$TARGET/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  BACKUP="$SETTINGS.bak.uninstall.$(date -u +%Y%m%dT%H%M%SZ)"
  cp "$SETTINGS" "$BACKUP"
  SETTINGS_PATH="$SETTINGS" python3 <<'PY'
import json, os
path = os.environ["SETTINGS_PATH"]
with open(path, "r") as f:
    data = json.load(f)

hooks = data.get("hooks", {})
GATE      = "${CLAUDE_PROJECT_DIR}/.claude/hooks/protocol-gate.sh"
RESET     = "${CLAUDE_PROJECT_DIR}/.claude/hooks/protocol-reset.sh"
STOP_GATE = "${CLAUDE_PROJECT_DIR}/.claude/hooks/protocol-stop-gate.sh"

def clean(event, target_cmd):
    entries = hooks.get(event, [])
    for e in entries:
        e["hooks"] = [h for h in e.get("hooks", []) if h.get("command") != target_cmd]
    hooks[event] = [e for e in entries if e.get("hooks")]
    if not hooks[event]:
        hooks.pop(event, None)

clean("PreToolUse",      GATE)
clean("UserPromptSubmit", RESET)
clean("SubagentStop",    RESET)
clean("PreCompact",      RESET)
clean("SessionStart",    RESET)
clean("Stop",            STOP_GATE)
# 旧版で Stop に reset が登録されているケースもクリーンアップ
clean("Stop",            RESET)

with open(path, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
print("  ✓ settings.json から hook エントリ除去")
PY
fi

echo ""
echo "✅ アンインストール完了"
echo "   backup: settings.json.bak.uninstall.*"
