#!/usr/bin/env bash
# ccagi-verify-uc-coverage — UC md mermaid arrow vs test assertion 1:1 mapping checker
#
# tdd-perfection-gate v1.0.0
#
# UC md の §Sequence (mermaid) 内の arrow 数と、対応 test file 内の
# assertion 数 (expect, assert.*, toBe*, toHave*) が 1:1 で対応しているかを
# ざっくり verify する。ratio < 100% なら exit 1。
#
# Usage:
#   bash ccagi-verify-uc-coverage.sh <uc-md-path> <test-file-path> [<additional-test-files>...]
#
# Exit codes:
#   0  = coverage OK (>= 100%)
#   1  = coverage NG (< 100%)
#   2  = usage error
#   3  = file not found
#
# 参照:
#   rules/sequence-complete-verify.md
#   rules/no-invented-symbols.md — F1-F13 等の Claude 発明 symbol も検出
#
set -euo pipefail

if [ $# -lt 2 ]; then
  cat <<'H' >&2
Usage:
  ccagi-verify-uc-coverage.sh <uc-md-path> <test-file-path> [<additional-test-files>...]

Verifies mermaid arrow count in UC md vs assertion count in test files.
Exits 1 if coverage < 100%.
H
  exit 2
fi

UC_MD="$1"
shift
TEST_FILES=("$@")

if [ ! -f "$UC_MD" ]; then
  echo "❌ UC md not found: $UC_MD" >&2
  exit 3
fi
for f in "${TEST_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "❌ test file not found: $f" >&2
    exit 3
  fi
done

# --------------------------------------------------------------------------
# mermaid arrow 抽出
# --------------------------------------------------------------------------
# `->>`, `->`, `-->>`, `-->`, `--x` などの sequenceDiagram arrow syntax を検出。
# mermaid ブロック内のみ対象。
ARROW_COUNT="$(python3 - "$UC_MD" <<'PY'
import re, sys
with open(sys.argv[1]) as f:
    content = f.read()
# mermaid ブロック抽出
blocks = re.findall(r"```mermaid\n(.*?)\n```", content, re.DOTALL)
total = 0
for block in blocks:
    # sequenceDiagram のみ対象 (flowchart 等は除外)
    if 'sequenceDiagram' not in block:
        continue
    # 各行で arrow syntax を count
    for line in block.split('\n'):
        line = line.strip()
        if not line or line.startswith('%%'):
            continue
        # sequenceDiagram 内の arrow: A->>B: msg, A->B, A-->>B, A-->B, A--xB, A-xB
        if re.search(r'-{1,2}[>x]{1,2}', line):
            total += 1
print(total)
PY
)"

# --------------------------------------------------------------------------
# assertion 抽出
# --------------------------------------------------------------------------
# expect(...), assert(...), assertEqual, etc.
ASSERTION_COUNT=0
for f in "${TEST_FILES[@]}"; do
  # word-boundary で count
  COUNT="$(grep -cE '\b(expect|assert|assertEqual|assertTrue|assertFalse|toBe[A-Z]|toHave[A-Z]|toEqual|toMatch|toContain|should\.)' "$f" 2>/dev/null || echo 0)"
  ASSERTION_COUNT=$((ASSERTION_COUNT + COUNT))
done

# --------------------------------------------------------------------------
# 発明 symbol 検出 (no-invented-symbols.md)
# --------------------------------------------------------------------------
# UC md 内で F1-F13 / S07-C 等の suspicious symbol を検出。
# 起源 (要件定義書 / SoT) 照会は本 script では行わず、warn だけ出す。
SUSPICIOUS_SYMBOLS=""
if grep -qE '\bF[0-9]{1,2}\b|\bS[0-9]{2}-[A-Z]\b' "$UC_MD" 2>/dev/null; then
  SUSPICIOUS_SYMBOLS="$(grep -oE '\bF[0-9]{1,2}\b|\bS[0-9]{2}-[A-Z]\b' "$UC_MD" | sort -u | tr '\n' ' ')"
fi

# --------------------------------------------------------------------------
# 結果出力
# --------------------------------------------------------------------------
UC_NAME="$(basename "$UC_MD" .md)"

echo "[$UC_NAME] mermaid arrows:  $ARROW_COUNT"
echo "[$UC_NAME] test assertions: $ASSERTION_COUNT"
if [ "$ARROW_COUNT" -eq 0 ]; then
  echo "[$UC_NAME] verdict: NO-MERMAID (mermaid sequenceDiagram block not found in $UC_MD)"
  # arrow 0 は UC md 構造不備 = 別途対処が必要
  exit 1
fi

RATIO_PCT=$(( ASSERTION_COUNT * 100 / ARROW_COUNT ))
echo "[$UC_NAME] coverage ratio:  $ASSERTION_COUNT / $ARROW_COUNT = ${RATIO_PCT}%"

if [ -n "$SUSPICIOUS_SYMBOLS" ]; then
  cat <<EOF
[$UC_NAME] ⚠️  suspicious invented symbols detected in UC md:
   $SUSPICIOUS_SYMBOLS
   参照: rules/no-invented-symbols.md
   要件定義書 / SoT / legacy 原典に 該当 symbol が grep hit するか手動確認してください。
EOF
fi

if [ "$RATIO_PCT" -ge 100 ]; then
  echo "[$UC_NAME] verdict: FULL-COVERAGE (>= 100%)"
  exit 0
else
  echo "[$UC_NAME] verdict: PARTIAL-COVERAGE (< 100%)"
  echo "  シーケンス完遂 verify 未達。以下いずれかで対処してください:"
  echo "    1. 不足 arrow に対応する assertion を test に追加"
  echo "    2. UC md mermaid から不要 arrow を削除 (spec 修正)"
  echo "    3. verdict を UI-PASS / PARTIAL-COVERAGE に downgrade (rules/verdict-vocabulary.md)"
  exit 1
fi
