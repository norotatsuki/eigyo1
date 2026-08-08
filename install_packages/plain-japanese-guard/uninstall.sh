#!/usr/bin/env bash
# plain-japanese-guard — uninstaller (v1.1.0)
set -Eeuo pipefail

TARGET="${1:-$(pwd)}"

if [ ! -d "$TARGET" ]; then
  echo "❌ Target not found: $TARGET" >&2
  exit 1
fi

echo "🗑  plain-japanese-guard uninstaller"
echo "   target: $TARGET"

for f in \
  ".claude/rules/plain-japanese.md" \
  ".claude/lib/jargon-list.txt" \
  ".claude/lib/jargon-completion-patterns.txt" \
  ".claude/hooks/jargon-detect.sh" \
  ".claude/hooks/jargon-reset.sh" \
  "scripts/jargon-scan.sh" \
  ".claude/state/jargon-detect.count"
do
  if [ -e "$TARGET/$f" ]; then
    rm -f "$TARGET/$f"
    echo "  ✓ 削除: $f"
  fi
done

# CLAUDE.md から @import 除去
CLAUDE_MD="$TARGET/CLAUDE.md"
if [ -f "$CLAUDE_MD" ]; then
  BACKUP="$CLAUDE_MD.bak.uninstall.$(date -u +%Y%m%dT%H%M%SZ)"
  cp "$CLAUDE_MD" "$BACKUP"
  python3 - "$CLAUDE_MD" <<'PY'
import re, sys
path = sys.argv[1]
with open(path) as f:
    content = f.read()
pattern = re.compile(
    r'\n<!-- plain-japanese-guard v[0-9.]+ \(auto-added on install\) -->\n@import \.claude/rules/plain-japanese\.md\n',
    re.MULTILINE,
)
content = pattern.sub('', content)
content = re.sub(r'@import \.claude/rules/plain-japanese\.md\n', '', content)
with open(path, 'w') as f:
    f.write(content)
PY
  echo "  ✓ CLAUDE.md から plain-japanese.md の @import 除去"
  echo "  ✓ backup: $BACKUP"
fi

# settings.json から hook エントリ除去
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
DETECT = "${CLAUDE_PROJECT_DIR}/.claude/hooks/jargon-detect.sh"
RESET  = "${CLAUDE_PROJECT_DIR}/.claude/hooks/jargon-reset.sh"

def clean(event, target_cmd):
    entries = hooks.get(event, [])
    for e in entries:
        e["hooks"] = [h for h in e.get("hooks", []) if h.get("command") != target_cmd]
    hooks[event] = [e for e in entries if e.get("hooks")]
    if not hooks[event]:
        hooks.pop(event, None)

clean("Stop",             DETECT)
clean("UserPromptSubmit", RESET)
clean("SessionStart",     RESET)

with open(path, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
print("  ✓ settings.json から hook エントリ除去")
PY
fi

echo ""
echo "✅ アンインストール完了"
