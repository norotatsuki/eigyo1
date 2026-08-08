#!/usr/bin/env bash
# info-public-guard — self-test
# インストーラの冪等性と CLAUDE.md 挿入位置を検証
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="$SRC/install.sh"
UNINSTALL="$SRC/uninstall.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✅ PASS: $desc"
    pass=$((pass+1))
  else
    echo "  ❌ FAIL: $desc"
    echo "     expected: $expected"
    echo "     actual:   $actual"
    fail=$((fail+1))
  fi
}

count_import() {
  grep -cxF "@import .claude/rules/info-public-guard.md" "$1" 2>/dev/null || true
}

echo "🧪 info-public-guard self-test"
echo "   tmp: $TMP"
echo ""

# ─── Case 1: CLAUDE.md 未存在 → 新規作成 ────────────────────────────────
echo "▸ Case 1: CLAUDE.md 未存在で install → 新規作成 + @import 1 件"
T1="$TMP/case1"
mkdir -p "$T1"
bash "$INSTALL" "$T1" >/dev/null
check "CLAUDE.md 作成される"          "1" "$([ -f "$T1/CLAUDE.md" ] && echo 1 || echo 0)"
check "@import が 1 件"               "1" "$(count_import "$T1/CLAUDE.md")"
check "ルールファイル配備"            "1" "$([ -f "$T1/.claude/rules/info-public-guard.md" ] && echo 1 || echo 0)"

# ─── Case 2: 既存 CLAUDE.md (Rule imports セクションあり) ─────────────
echo "▸ Case 2: 既存 CLAUDE.md の Rule imports セクションに追記"
T2="$TMP/case2"
mkdir -p "$T2"
cat > "$T2/CLAUDE.md" <<'EOF'
# Project CLAUDE.md

## Rule imports (Internal tier)

@import .claude/rules/scope-contract.md
@import .claude/rules/other-rule.md

## Some Other Section

Body text here.
EOF
bash "$INSTALL" "$T2" >/dev/null
check "@import が 1 件追加された"     "1" "$(count_import "$T2/CLAUDE.md")"
# 既存 @import と新規 @import の位置関係 (新規は既存の直後)
last_import_line=$(grep -n '^@import ' "$T2/CLAUDE.md" | tail -1 | cut -d: -f1)
next_section_line=$(grep -n '^## Some Other Section' "$T2/CLAUDE.md" | head -1 | cut -d: -f1)
check "新規 @import はセクション内"    "true" "$([ "$last_import_line" -lt "$next_section_line" ] && echo true || echo false)"

# ─── Case 3: 冪等性 (2 回実行しても副作用は 1 回分) ─────────────────
echo "▸ Case 3: 冪等性 — 再実行しても @import は 1 件のまま"
bash "$INSTALL" "$T2" >/dev/null
bash "$INSTALL" "$T2" >/dev/null
check "再実行後も @import は 1 件"    "1" "$(count_import "$T2/CLAUDE.md")"

# ─── Case 4: Rule imports セクションが無い CLAUDE.md ───────────────────
echo "▸ Case 4: セクション未存在 CLAUDE.md → セクションごと新設"
T4="$TMP/case4"
mkdir -p "$T4"
cat > "$T4/CLAUDE.md" <<'EOF'
# Project CLAUDE.md (no rule imports yet)

Just body text.
EOF
bash "$INSTALL" "$T4" >/dev/null
check "@import が 1 件追加"           "1" "$(count_import "$T4/CLAUDE.md")"
check "セクション見出し追加"          "1" "$(grep -cxF '## Rule imports (Internal tier)' "$T4/CLAUDE.md")"

# ─── Case 5: バックアップが作成される ─────────────────────────────
echo "▸ Case 5: install はバックアップ CLAUDE.md.bak.* を残す"
bak_count=$(ls "$T2"/CLAUDE.md.bak.* 2>/dev/null | wc -l | tr -d ' ')
check "バックアップ 1 件以上"         "true" "$([ "$bak_count" -ge 1 ] && echo true || echo false)"

# ─── Case 6: uninstall で @import 削除 ──────────────────────────────
echo "▸ Case 6: uninstall で @import 行とルールファイルが消える"
bash "$UNINSTALL" "$T2" >/dev/null
check "uninstall 後 @import 0 件"     "0" "$(count_import "$T2/CLAUDE.md")"
check "ルールファイル削除"            "0" "$([ -f "$T2/.claude/rules/info-public-guard.md" ] && echo 1 || echo 0)"

echo ""
echo "─────────────────────────────────"
echo "Results: $pass pass / $fail fail"
if [ "$fail" -eq 0 ]; then
  echo "✅ All tests passed"
  exit 0
else
  echo "❌ Some tests failed"
  exit 1
fi
