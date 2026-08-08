#!/usr/bin/env bash
# tdd-perfection-gate — uninstaller (v1.1.0)
set -Eeuo pipefail

TARGET="${1:-$(pwd)}"

if [ ! -d "$TARGET" ]; then
  echo "❌ Target not found: $TARGET" >&2
  exit 1
fi

echo "🗑  tdd-perfection-gate uninstaller"
echo "   target: $TARGET"

# rules 削除 (v1.0.0 5 + v1.1.0 1 = 6)
RULES=(
  sequence-complete-verify
  no-invented-symbols
  audit-trail-mandatory
  verdict-vocabulary
  pre-verdict-self-audit
  perfect-tdd-trigger
)
for r in "${RULES[@]}"; do
  f="$TARGET/.claude/rules/${r}.md"
  if [ -f "$f" ]; then
    rm -f "$f"
    echo "  ✓ 削除: .claude/rules/${r}.md"
  fi
done

# scripts 削除 (v1.0.0 2 + v1.1.0 2 = 4)
SCRIPTS=(
  ccagi-pre-verdict-audit.sh
  ccagi-verify-uc-coverage.sh
  ccagi-arrow-verify.sh
  ccagi-zero-bug-loop.sh
)
for s in "${SCRIPTS[@]}"; do
  f="$TARGET/scripts/${s}"
  if [ -f "$f" ]; then
    rm -f "$f"
    echo "  ✓ 削除: scripts/${s}"
  fi
done

# hooks 削除 (v1.1.0 新規 2)
HOOKS=(
  perfect-tdd-detector.sh
  perfect-tdd-stop-gate.sh
  perfect-tdd-defer-detector.sh
)
for h in "${HOOKS[@]}"; do
  f="$TARGET/.claude/hooks/${h}"
  if [ -f "$f" ]; then
    rm -f "$f"
    echo "  ✓ 削除: .claude/hooks/${h}"
  fi
done

# helpers 削除
HELPER_DEST="$TARGET/tools/browser-test-plus"
if [ -d "$HELPER_DEST" ]; then
  rm -rf "$HELPER_DEST"
  echo "  ✓ 削除: tools/browser-test-plus/"
fi

# marker 削除 (v1.0.0 4 + v1.1.0 arrow/zero-bug/mode)
for m in tdd-db-probe-verified.turn tdd-audit-trail-verified.turn tdd-external-effect-verified.turn tdd-verdict-recorded.turn tdd-arrow-summary.turn tdd-zero-bug-verified.turn perfect-tdd-mode.turn perfect-tdd-stop.count; do
  f="$TARGET/.claude/state/${m}"
  if [ -f "$f" ]; then
    rm -f "$f"
    echo "  ✓ 削除: .claude/state/${m}"
  fi
done
# 個別 arrow marker (glob)
if compgen -G "$TARGET/.claude/state/tdd-arrow-*.turn" > /dev/null 2>&1; then
  rm -f "$TARGET/.claude/state"/tdd-arrow-*.turn
  echo "  ✓ 削除: .claude/state/tdd-arrow-*.turn (glob)"
fi
# zero-bug logs
if [ -d "$TARGET/.claude/state/zero-bug-logs" ]; then
  rm -rf "$TARGET/.claude/state/zero-bug-logs"
  echo "  ✓ 削除: .claude/state/zero-bug-logs/"
fi

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
# tdd-perfection-gate ブロック (コメント + @import 群) を除去 (v1.0.0 と v1.1.0 の両方)
pattern = re.compile(
    r'\n<!-- tdd-perfection-gate v[0-9.]+ \(auto-added on install\) -->\n(@import \.claude/rules/(sequence-complete-verify|no-invented-symbols|audit-trail-mandatory|verdict-vocabulary|pre-verdict-self-audit|perfect-tdd-trigger)\.md\n)+',
    re.MULTILINE,
)
content = pattern.sub('', content)
# 個別 @import 行の残骸も除去
for r in ('sequence-complete-verify', 'no-invented-symbols', 'audit-trail-mandatory', 'verdict-vocabulary', 'pre-verdict-self-audit', 'perfect-tdd-trigger'):
    content = re.sub(rf'@import \.claude/rules/{r}\.md\n', '', content)
with open(path, 'w') as f:
    f.write(content)
PY
  echo "  ✓ CLAUDE.md から tdd-perfection-gate rule の @import 除去 (v1.0.0/v1.1.0 両対応)"
  echo "  ✓ backup: $BACKUP"
fi

# .claude/settings.json から hook 削除 (idempotent)
SETTINGS="$TARGET/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  SBACKUP="$SETTINGS.bak.uninstall.$(date -u +%Y%m%dT%H%M%SZ)"
  cp "$SETTINGS" "$SBACKUP"
  python3 - "$SETTINGS" <<'PY'
import json, sys
path = sys.argv[1]
try:
    with open(path) as f:
        settings = json.load(f)
except Exception:
    settings = {}
if not isinstance(settings, dict):
    settings = {}

hooks = settings.get("hooks")
if not isinstance(hooks, dict):
    sys.exit(0)

TARGETS = ("perfect-tdd-detector.sh", "perfect-tdd-stop-gate.sh", "perfect-tdd-defer-detector.sh")

def clean_event(event):
    arr = hooks.get(event) or []
    if not isinstance(arr, list):
        return
    new_arr = []
    for entry in arr:
        if not isinstance(entry, dict):
            new_arr.append(entry)
            continue
        inner = entry.get("hooks") or []
        cleaned = []
        for h in inner:
            if isinstance(h, dict):
                cmd = h.get("command", "")
                if any(t in cmd for t in TARGETS):
                    continue
            cleaned.append(h)
        if cleaned:
            entry["hooks"] = cleaned
            new_arr.append(entry)
        # 空になった matcher entry は落とす
    if new_arr:
        hooks[event] = new_arr
    else:
        hooks.pop(event, None)

for ev in ("UserPromptSubmit", "Stop"):
    clean_event(ev)

if not hooks:
    settings.pop("hooks", None)

with open(path, "w") as f:
    json.dump(settings, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
  echo "  ✓ .claude/settings.json から perfect-tdd hook 削除"
  echo "  ✓ backup: $SBACKUP"
fi

echo ""
echo "✅ アンインストール完了"
