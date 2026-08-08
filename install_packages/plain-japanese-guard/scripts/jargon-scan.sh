#!/usr/bin/env bash
# jargon-scan — 手動スキャン CLI
# 任意のテキストファイル (Markdown / commit message / etc.) をスキャンして
# 禁止カタカナ / ジャーゴンを検出する。
#
# Usage:
#   bash jargon-scan.sh <file> [<file>...]
#   echo "テキスト" | bash jargon-scan.sh -
#
# Exit codes:
#   0 = 検出なし
#   1 = 検出あり
#   2 = usage error
set -euo pipefail

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
JARGON_LIST="${CCAGI_JARGON_LIST:-${PROJECT_ROOT}/.claude/lib/jargon-list.txt}"

if [ $# -eq 0 ]; then
  cat <<'H' >&2
Usage:
  jargon-scan.sh <file> [<file>...]
  echo "テキスト" | jargon-scan.sh -

Environment:
  CCAGI_JARGON_LIST   jargon list path (default: .claude/lib/jargon-list.txt)

Exit codes:
  0 = no jargon detected
  1 = jargon detected
  2 = usage error
H
  exit 2
fi

if [ ! -f "$JARGON_LIST" ]; then
  echo "❌ jargon-list.txt not found: $JARGON_LIST" >&2
  exit 3
fi

# collect input
ALL_TEXT=""
for f in "$@"; do
  if [ "$f" = "-" ]; then
    ALL_TEXT="${ALL_TEXT}
$(cat)"
  elif [ -f "$f" ]; then
    ALL_TEXT="${ALL_TEXT}
$(cat "$f")"
  else
    echo "⚠  file not found: $f" >&2
  fi
done

if [ -z "$ALL_TEXT" ]; then
  echo "❌ no input" >&2
  exit 2
fi

# detect
DETECTED="$(TEXT="$ALL_TEXT" LIST="$JARGON_LIST" python3 <<'PY' 2>/dev/null || echo ""
import os
text = os.environ.get("TEXT", "")
list_path = os.environ.get("LIST", "")
detected = []
try:
    with open(list_path, encoding='utf-8') as f:
        for line in f:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            word = parts[0].strip()
            replacement = parts[1].strip()
            reason = parts[2].strip() if len(parts) > 2 else ""
            if not word:
                continue
            count = text.count(word)
            if count > 0:
                detected.append((word, replacement, reason, count))
except Exception:
    pass

if detected:
    detected.sort(key=lambda x: -x[3])
    print(f"検出 {len(detected)} 語:")
    for word, repl, reason, count in detected:
        line = f"  ❌ {word:20s} × {count:3d} 回 → {repl}"
        if reason:
            line += f"  ({reason})"
        print(line)
PY
)"

if [ -z "$DETECTED" ]; then
  echo "✅ 禁止カタカナ / ジャーゴン検出なし"
  exit 0
fi

echo "$DETECTED"
echo ""
echo "参照: .claude/rules/plain-japanese.md"
echo "言換辞書: $JARGON_LIST"
exit 1
