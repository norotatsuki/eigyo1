#!/usr/bin/env bash
# plain-japanese-guard — self-test
# install / uninstall / detect / scan の動作を検証
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/.claude/state"
cat > "$TMP/CLAUDE.md" <<'EOF'
# CLAUDE.md (test fixture)
EOF

pass=0
fail=0
check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✅ PASS: $desc (=$actual)"
    pass=$((pass+1))
  else
    echo "  ❌ FAIL: $desc (expected=$expected, actual=$actual)"
    fail=$((fail+1))
  fi
}

echo "🧪 plain-japanese-guard self-test (v$(cat "$SRC/VERSION"))"
echo "   tmp: $TMP"
echo ""

# --------------------------------------------------------------------------
# Case 1: install
# --------------------------------------------------------------------------
echo "▸ Case 1: install"
bash "$SRC/install.sh" "$TMP" > /dev/null 2>&1
check "rule installed" 1 "$([ -f "$TMP/.claude/rules/plain-japanese.md" ] && echo 1 || echo 0)"
check "jargon-list installed" 1 "$([ -f "$TMP/.claude/lib/jargon-list.txt" ] && echo 1 || echo 0)"
check "jargon-detect.sh installed" 1 "$([ -f "$TMP/.claude/hooks/jargon-detect.sh" ] && echo 1 || echo 0)"
check "jargon-reset.sh installed" 1 "$([ -f "$TMP/.claude/hooks/jargon-reset.sh" ] && echo 1 || echo 0)"
check "jargon-scan.sh installed" 1 "$([ -f "$TMP/scripts/jargon-scan.sh" ] && echo 1 || echo 0)"
check "CLAUDE.md @import added" 1 "$(grep -c 'plain-japanese.md' "$TMP/CLAUDE.md")"

# --------------------------------------------------------------------------
# Case 2: install idempotent
# --------------------------------------------------------------------------
echo "▸ Case 2: 2 回目 install で @import 重複しない"
bash "$SRC/install.sh" "$TMP" > /dev/null 2>&1
check "CLAUDE.md @import still 1 (idempotent)" 1 "$(grep -c 'plain-japanese.md' "$TMP/CLAUDE.md")"

# --------------------------------------------------------------------------
# Case 3: jargon-scan.sh 単体テスト (禁止語検出)
# --------------------------------------------------------------------------
echo "▸ Case 3: jargon-scan で禁止語検出 → exit 1"
export CLAUDE_PROJECT_DIR="$TMP"
echo "オンボーディングフローをアサインします" > "$TMP/sample.txt"
rc=0
bash "$TMP/scripts/jargon-scan.sh" "$TMP/sample.txt" > "$TMP/scan.out" 2>&1 || rc=$?
check "jargon-scan detects jargon → exit 1" 1 "$rc"
check "output mentions オンボーディング" 1 "$(grep -c 'オンボーディング' "$TMP/scan.out")"
check "output mentions アサイン" 1 "$(grep -c 'アサイン' "$TMP/scan.out")"

# --------------------------------------------------------------------------
# Case 4: 禁止語なし → exit 0
# --------------------------------------------------------------------------
echo "▸ Case 4: 定着語のみ → exit 0"
echo "テストを実行してバグを修正しました" > "$TMP/clean.txt"
rc=0
bash "$TMP/scripts/jargon-scan.sh" "$TMP/clean.txt" > /dev/null 2>&1 || rc=$?
check "no jargon → exit 0" 0 "$rc"

# --------------------------------------------------------------------------
# Case 5: 標準入力からスキャン
# --------------------------------------------------------------------------
echo "▸ Case 5: stdin から scan"
rc=0
echo "オンボーディングを実施" | bash "$TMP/scripts/jargon-scan.sh" - > /dev/null 2>&1 || rc=$?
check "stdin scan detects jargon" 1 "$rc"

# --------------------------------------------------------------------------
# Case 6: jargon-detect.sh 単体テスト (fake transcript で BLOCK)
# --------------------------------------------------------------------------
echo "▸ Case 6: jargon-detect.sh — fake transcript で BLOCK"
# Fake transcript (Claude Code jsonl 形式)
FAKE_TRANSCRIPT="$TMP/fake-transcript.jsonl"
cat > "$FAKE_TRANSCRIPT" <<'EOF'
{"type":"user","message":{"content":"テストしてください"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"オンボーディングフローを最適化しました。アサインを再検討します。"}]}}
EOF
FAKE_INPUT="{\"session_id\":\"test\",\"transcript_path\":\"$FAKE_TRANSCRIPT\",\"stop_hook_active\":false}"
rm -f "$TMP/.claude/state/jargon-detect.count"
rc=0
printf '%s' "$FAKE_INPUT" | bash "$TMP/.claude/hooks/jargon-detect.sh" > /dev/null 2>&1 || rc=$?
check "detect.sh BLOCK on jargon in response" 2 "$rc"

# --------------------------------------------------------------------------
# Case 7: jargon-detect.sh — clean response で通過
# --------------------------------------------------------------------------
echo "▸ Case 7: jargon-detect.sh — clean response で通過"
cat > "$FAKE_TRANSCRIPT" <<'EOF'
{"type":"user","message":{"content":"テストしてください"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"テストを実行してバグを修正しました。"}]}}
EOF
rm -f "$TMP/.claude/state/jargon-detect.count"
rc=0
printf '%s' "$FAKE_INPUT" | bash "$TMP/.claude/hooks/jargon-detect.sh" > /dev/null 2>&1 || rc=$?
check "detect.sh PASS on clean response" 0 "$rc"

# --------------------------------------------------------------------------
# Case 8: bypass 環境変数
# --------------------------------------------------------------------------
echo "▸ Case 8: CCAGI_JARGON_ACK=1 で bypass"
cat > "$FAKE_TRANSCRIPT" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"オンボーディングを実施します"}]}}
EOF
rm -f "$TMP/.claude/state/jargon-detect.count"
rc=0
CCAGI_JARGON_ACK=1 printf '%s' "$FAKE_INPUT" | CCAGI_JARGON_ACK=1 bash "$TMP/.claude/hooks/jargon-detect.sh" > /dev/null 2>&1 || rc=$?
check "CCAGI_JARGON_ACK=1 bypass works" 0 "$rc"

# --------------------------------------------------------------------------
# Case 9: warn モード
# --------------------------------------------------------------------------
echo "▸ Case 9: CCAGI_JARGON_MODE=warn で警告のみ (exit 0)"
cat > "$FAKE_TRANSCRIPT" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"アサインしました"}]}}
EOF
rm -f "$TMP/.claude/state/jargon-detect.count"
rc=0
CCAGI_JARGON_MODE=warn printf '%s' "$FAKE_INPUT" | CCAGI_JARGON_MODE=warn bash "$TMP/.claude/hooks/jargon-detect.sh" > /dev/null 2>&1 || rc=$?
check "warn mode returns 0" 0 "$rc"

# --------------------------------------------------------------------------
# Case 10: 2 回発火で自動 pass (無限ループ防止, v1.1.0 default 2)
# --------------------------------------------------------------------------
echo "▸ Case 10: 2 回目発火で自動 pass (v1.1.0 default MAX=2)"
cat > "$FAKE_TRANSCRIPT" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"アサインします"}]}}
EOF
rm -f "$TMP/.claude/state/jargon-detect.count"
set +e
printf '%s' "$FAKE_INPUT" | CCAGI_JARGON_QUIET=1 bash "$TMP/.claude/hooks/jargon-detect.sh" > /dev/null 2>&1
RC1=$?
printf '%s' "$FAKE_INPUT" | CCAGI_JARGON_QUIET=1 bash "$TMP/.claude/hooks/jargon-detect.sh" > /dev/null 2>&1
RC2=$?
printf '%s' "$FAKE_INPUT" | CCAGI_JARGON_QUIET=1 bash "$TMP/.claude/hooks/jargon-detect.sh" > /dev/null 2>&1
RC3=$?
set -e
check "iter 1 → BLOCK (2)" 2 "$RC1"
check "iter 2 → BLOCK (2)" 2 "$RC2"
check "iter 3 → auto-pass (0, loop-prevention)" 0 "$RC3"

# --------------------------------------------------------------------------
# Case 10b: CCAGI_JARGON_MAX_STOP_BLOCKS で上限 override
# --------------------------------------------------------------------------
echo "▸ Case 10b: CCAGI_JARGON_MAX_STOP_BLOCKS=1 → 2 回目で自動 pass"
cat > "$FAKE_TRANSCRIPT" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"アサインします"}]}}
EOF
rm -f "$TMP/.claude/state/jargon-detect.count"
set +e
RC1=0
printf '%s' "$FAKE_INPUT" | CCAGI_JARGON_QUIET=1 CCAGI_JARGON_MAX_STOP_BLOCKS=1 \
  bash "$TMP/.claude/hooks/jargon-detect.sh" > /dev/null 2>&1
RC1=$?
RC2=0
printf '%s' "$FAKE_INPUT" | CCAGI_JARGON_QUIET=1 CCAGI_JARGON_MAX_STOP_BLOCKS=1 \
  bash "$TMP/.claude/hooks/jargon-detect.sh" > /dev/null 2>&1
RC2=$?
set -e
check "MAX=1 iter 1 → BLOCK" 2 "$RC1"
check "MAX=1 iter 2 → auto-pass" 0 "$RC2"

# --------------------------------------------------------------------------
# Case 11: reset で counter 削除
# --------------------------------------------------------------------------
echo "▸ Case 11: jargon-reset.sh で counter 削除"
echo 2 > "$TMP/.claude/state/jargon-detect.count"
echo '{}' | bash "$TMP/.claude/hooks/jargon-reset.sh"
check "counter deleted by reset" 0 "$([ -f "$TMP/.claude/state/jargon-detect.count" ] && echo 1 || echo 0)"

# --------------------------------------------------------------------------
# Case 12 (v1.1.0): completion-safe mode — 完了 phrase 検出時 warn 通過
# --------------------------------------------------------------------------
echo "▸ Case 12 (v1.1.0): completion-safe — 「完了報告」検出時 BLOCK skip"
cat > "$FAKE_TRANSCRIPT" <<'EOF'
{"type":"user","message":{"content":"実装してください"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"## 完了報告\n\nオンボーディングを実施しました。以上で完了。"}]}}
EOF
rm -f "$TMP/.claude/state/jargon-detect.count"
rc=0
printf '%s' "$FAKE_INPUT" | bash "$TMP/.claude/hooks/jargon-detect.sh" > /dev/null 2>&1 || rc=$?
check "completion-safe skips BLOCK → exit 0" 0 "$rc"

# --------------------------------------------------------------------------
# Case 12b (v1.1.0): completion-safe を OFF にすると block
# --------------------------------------------------------------------------
echo "▸ Case 12b (v1.1.0): CCAGI_JARGON_SKIP_ON_COMPLETION=0 で block 復活"
rm -f "$TMP/.claude/state/jargon-detect.count"
rc=0
printf '%s' "$FAKE_INPUT" | CCAGI_JARGON_SKIP_ON_COMPLETION=0 \
  bash "$TMP/.claude/hooks/jargon-detect.sh" > /dev/null 2>&1 || rc=$?
check "SKIP_ON_COMPLETION=0 → BLOCK 復活" 2 "$rc"

# --------------------------------------------------------------------------
# Case 12c (v1.1.0): 完了 pattern (「[100%]」) 検出でも skip
# --------------------------------------------------------------------------
echo "▸ Case 12c (v1.1.0): 「[100%]」検出で BLOCK skip"
cat > "$FAKE_TRANSCRIPT" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"[100%] 完了。オンボーディング済み。"}]}}
EOF
rm -f "$TMP/.claude/state/jargon-detect.count"
rc=0
printf '%s' "$FAKE_INPUT" | bash "$TMP/.claude/hooks/jargon-detect.sh" > /dev/null 2>&1 || rc=$?
check "[100%] completion-safe skip → exit 0" 0 "$rc"

# --------------------------------------------------------------------------
# Case 12d (v1.1.0): custom patterns file への追加 pattern も効く
# --------------------------------------------------------------------------
echo "▸ Case 12d (v1.1.0): custom patterns file 追加"
echo 'デプロイ完了' >> "$TMP/.claude/lib/jargon-completion-patterns.txt"
cat > "$FAKE_TRANSCRIPT" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"デプロイ完了。オンボーディング済み。"}]}}
EOF
rm -f "$TMP/.claude/state/jargon-detect.count"
rc=0
printf '%s' "$FAKE_INPUT" | bash "$TMP/.claude/hooks/jargon-detect.sh" > /dev/null 2>&1 || rc=$?
check "custom pattern 'デプロイ完了' で skip → exit 0" 0 "$rc"

# --------------------------------------------------------------------------
# Case 12e (v1.1.0): completion pattern 無 + jargon 有 → BLOCK 継続
# --------------------------------------------------------------------------
echo "▸ Case 12e (v1.1.0): 非完了応答 + jargon → 通常通り BLOCK"
cat > "$FAKE_TRANSCRIPT" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"オンボーディングを実施しました。続きを検討します。"}]}}
EOF
rm -f "$TMP/.claude/state/jargon-detect.count"
rc=0
printf '%s' "$FAKE_INPUT" | bash "$TMP/.claude/hooks/jargon-detect.sh" > /dev/null 2>&1 || rc=$?
check "non-completion + jargon → BLOCK (2)" 2 "$rc"

# --------------------------------------------------------------------------
# Case 13: install で v1.1.0 追加 file (completion-patterns) が配置される
# --------------------------------------------------------------------------
echo "▸ Case 13 (v1.1.0): jargon-completion-patterns.txt が配置される"
# 上で install 済みだが既存を確認
check "completion-patterns.txt installed" 1 "$([ -f "$TMP/.claude/lib/jargon-completion-patterns.txt" ] && echo 1 || echo 0)"

# --------------------------------------------------------------------------
# Case 14: uninstall
# --------------------------------------------------------------------------
echo "▸ Case 14: uninstall"
bash "$SRC/uninstall.sh" "$TMP" > /dev/null 2>&1
check "rule removed" 0 "$([ -f "$TMP/.claude/rules/plain-japanese.md" ] && echo 1 || echo 0)"
check "jargon-list removed" 0 "$([ -f "$TMP/.claude/lib/jargon-list.txt" ] && echo 1 || echo 0)"
check "completion-patterns removed (v1.1.0)" 0 "$([ -f "$TMP/.claude/lib/jargon-completion-patterns.txt" ] && echo 1 || echo 0)"
check "detect.sh removed" 0 "$([ -f "$TMP/.claude/hooks/jargon-detect.sh" ] && echo 1 || echo 0)"
check "CLAUDE.md @import removed" 0 "$(grep -c 'plain-japanese.md' "$TMP/CLAUDE.md")"

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
