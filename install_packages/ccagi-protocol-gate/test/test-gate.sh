#!/usr/bin/env bash
# ccagi-protocol-gate — self-test
# Gate が期待通り BLOCK / ALLOW するかを検証 (STEP 1-6 対応)
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# テスト用プロジェクト構造
mkdir -p "$TMP/.claude/state"
export CLAUDE_PROJECT_DIR="$TMP"

# STEP 5 用: プロジェクト直下 CLAUDE.md を配置（ack script が SHA256 記録するため必須）
cat > "$TMP/CLAUDE.md" <<'EOF'
# CLAUDE.md (test fixture)
This file exists to satisfy STEP 5 (CLAUDE.md forced application) during the gate self-test.
EOF

GATE="$SRC/hooks/protocol-gate.sh"
RESET="$SRC/hooks/protocol-reset.sh"
ACK="$SRC/scripts/ccagi-protocol-ack.sh"

pass=0
fail=0

check() {
  local desc="$1" expected_code="$2" actual_code="$3"
  if [ "$expected_code" = "$actual_code" ]; then
    echo "  ✅ PASS: $desc (exit=$actual_code)"
    pass=$((pass+1))
  else
    echo "  ❌ FAIL: $desc (expected=$expected_code, actual=$actual_code)"
    fail=$((fail+1))
  fi
}

run_gate_with() {
  # $1 = tool_name, $2 = optional bash command
  local tool_name="$1" cmd="${2:-}"
  local input
  if [ "$tool_name" = "Bash" ]; then
    input="$(python3 -c "import json,sys; print(json.dumps({'tool_name':'Bash','tool_input':{'command':sys.argv[1]}}))" "$cmd")"
  else
    input="{\"tool_name\":\"$tool_name\",\"tool_input\":{}}"
  fi
  local rc=0
  printf '%s' "$input" | bash "$GATE" >/dev/null 2>&1 || rc=$?
  echo "$rc"
}

# ack helper: 6 flag 全供給 (mode 引数で step6 を切替)
ack_ok() {
  local mode="${1:-off:documentation-only edit for self-test}"
  bash "$ACK" \
    --step1 "test-mcp" \
    --step2 "declared" \
    --step3 "foreground" \
    --step4 "self-test scope" \
    --step5 "self-test CLAUDE.md rules" \
    --step6 "$mode" >/dev/null
}

echo "🧪 ccagi-protocol-gate self-test (v0.7.0 STEP 1-6 + video default OFF + STEP 7 日本語出力)"
echo "   tmp project: $TMP"
echo ""

# Case 1: marker 無し → BLOCK
echo "▸ Case 1: marker 無しで Read tool → BLOCK 期待"
check "Read blocked without marker" 2 "$(run_gate_with Read)"

# Case 2: marker 無し → Edit BLOCK
echo "▸ Case 2: marker 無しで Edit tool → BLOCK 期待"
check "Edit blocked without marker" 2 "$(run_gate_with Edit)"

# Case 3: ack script bash bypass
echo "▸ Case 3: bash scripts/ccagi-protocol-ack.sh → 常に ALLOW"
check "ack script bypass allowed" 0 "$(run_gate_with Bash 'bash scripts/ccagi-protocol-ack.sh --step1 x --step2 y --step3 z --step4 w --step5 v --step6 off:sample')"

# Case 4: ack 実行 (off モード) → marker 生成 → ALLOW
echo "▸ Case 4: ack (off モード) 実行後の Read → ALLOW 期待"
ack_ok "off:self-test documentation edit"
check "Read allowed with valid marker (off)" 0 "$(run_gate_with Read)"

# Case 5: reset 実行 → marker 削除 → BLOCK
echo "▸ Case 5: reset 後の Bash → BLOCK 期待"
echo '{}' | bash "$RESET" >/dev/null
check "Bash blocked after reset" 2 "$(run_gate_with Bash 'ls')"

# Case 6: marker JSON 壊す → BLOCK
echo "▸ Case 6: marker 破損 → BLOCK 期待"
mkdir -p "$TMP/.claude/state"
echo '{invalid json' > "$TMP/.claude/state/protocol-ack.turn"
check "invalid marker blocked" 2 "$(run_gate_with Read)"

# Case 7: marker step4 空 → BLOCK
echo "▸ Case 7: step4 空の marker → BLOCK 期待"
cat > "$TMP/.claude/state/protocol-ack.turn" <<EOF
{"acked_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","step1_mcp":"x","step2_declaration":"y","step3_mode":"z","step4_scope":"","step5_claudemd":"v","step6_evidence":"off:doc","step6_mode":"off"}
EOF
check "empty step4 blocked" 2 "$(run_gate_with Read)"

# Case 7b: marker step5 空 → BLOCK
echo "▸ Case 7b: step5 空の marker → BLOCK 期待"
cat > "$TMP/.claude/state/protocol-ack.turn" <<EOF
{"acked_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","step1_mcp":"x","step2_declaration":"y","step3_mode":"z","step4_scope":"w","step5_claudemd":"","step6_evidence":"off:doc","step6_mode":"off"}
EOF
check "empty step5 blocked" 2 "$(run_gate_with Read)"

# Case 7c: marker step6 空 → BLOCK
echo "▸ Case 7c: step6 空の marker → BLOCK 期待"
cat > "$TMP/.claude/state/protocol-ack.turn" <<EOF
{"acked_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","step1_mcp":"x","step2_declaration":"y","step3_mode":"z","step4_scope":"w","step5_claudemd":"v","step6_evidence":"","step6_mode":""}
EOF
check "empty step6 blocked" 2 "$(run_gate_with Read)"

# Case 7d: marker step6_mode invalid → BLOCK
echo "▸ Case 7d: step6_mode 不正値 → BLOCK 期待"
cat > "$TMP/.claude/state/protocol-ack.turn" <<EOF
{"acked_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","step1_mcp":"x","step2_declaration":"y","step3_mode":"z","step4_scope":"w","step5_claudemd":"v","step6_evidence":"garbage","step6_mode":"garbage"}
EOF
check "invalid step6_mode blocked" 2 "$(run_gate_with Read)"

# Case 8: marker 期限切れ → BLOCK
echo "▸ Case 8: 2 時間前 marker → BLOCK 期待"
OLD_TS="$(python3 -c 'from datetime import datetime, timezone, timedelta; print((datetime.now(timezone.utc)-timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
cat > "$TMP/.claude/state/protocol-ack.turn" <<EOF
{"acked_at":"$OLD_TS","step1_mcp":"x","step2_declaration":"y","step3_mode":"z","step4_scope":"w","step5_claudemd":"v","step6_evidence":"off:doc","step6_mode":"off"}
EOF
check "expired marker blocked" 2 "$(run_gate_with Read)"

# Case 9: CLAUDE.md 不在 → ack script exit 3 (STEP 5 存在強制)
# 注: --step6 は valid な off:<>=8chars> を渡して STEP 6 検証で落とさず CLAUDE.md check に到達させる
echo "▸ Case 9: CLAUDE.md 削除で ack script が exit 3 期待"
mv "$TMP/CLAUDE.md" "$TMP/CLAUDE.md.bak"
rc=0
bash "$ACK" --step1 a --step2 b --step3 c --step4 d --step5 e \
  --step6 "off:documentation-only-edit-for-test" >/dev/null 2>&1 || rc=$?
mv "$TMP/CLAUDE.md.bak" "$TMP/CLAUDE.md"
check "ack fails without CLAUDE.md" 3 "$rc"

# Case 10: ack --step6 欠落 → exit 1
echo "▸ Case 10: --step6 欠落で ack script が exit 1 期待"
rc=0
bash "$ACK" --step1 a --step2 b --step3 c --step4 d --step5 e >/dev/null 2>&1 || rc=$?
check "ack fails without --step6" 1 "$rc"

# Case 11: ack --step6 不正 prefix → exit 4
echo "▸ Case 11: --step6 不正 prefix (e.g. 'random:foo') → ack script が exit 4 期待"
rc=0
bash "$ACK" --step1 a --step2 b --step3 c --step4 d --step5 e --step6 "random:foo" >/dev/null 2>&1 || rc=$?
check "ack fails on invalid --step6 prefix" 4 "$rc"

# Case 12: ack --step6 browser-test で sequence= 欠落 → exit 5
echo "▸ Case 12: browser-test で sequence= 欠落 → ack script が exit 5 期待"
rc=0
bash "$ACK" --step1 a --step2 b --step3 c --step4 d --step5 e \
  --step6 "browser-test:videos=./v/|headed=true" >/dev/null 2>&1 || rc=$?
check "ack fails on browser-test missing sequence=" 5 "$rc"

# Case 13: ack --step6 tdd で root-cause= 欠落 → exit 5
echo "▸ Case 13: tdd で root-cause= 欠落 → ack script が exit 5 期待"
rc=0
bash "$ACK" --step1 a --step2 b --step3 c --step4 d --step5 e \
  --step6 "tdd:fix=x|unit-test=y|deploy=z|browser-verify=w" >/dev/null 2>&1 || rc=$?
check "ack fails on tdd missing root-cause=" 5 "$rc"

# Case 14: ack --step6 off の理由が短すぎ → exit 5
echo "▸ Case 14: off:短い → ack script が exit 5 期待"
rc=0
bash "$ACK" --step1 a --step2 b --step3 c --step4 d --step5 e --step6 "off:short" >/dev/null 2>&1 || rc=$?
check "ack fails on off short reason" 5 "$rc"

# --------------------------------------------------------------------------
# STEP 6 追加ガード: playwright test lazy-path 検出
# --------------------------------------------------------------------------

# Case 15: step6_mode=off で `npx playwright test` を呼ぶ → BLOCK
echo "▸ Case 15: off モードで npx playwright test → BLOCK 期待"
ack_ok "off:self-test documentation edit"
check "playwright test blocked in off mode" 2 "$(run_gate_with Bash 'npx playwright test')"

# Case 16: step6_mode=browser-test だが --headed 無し → BLOCK
echo "▸ Case 16: browser-test モードで --headed 無し → BLOCK 期待"
ack_ok "browser-test:sequence=UC-01|videos=./v/"
check "playwright test blocked without --headed" 2 "$(run_gate_with Bash 'npx playwright test tests/login.spec.ts')"

# Case 17: step6_mode=browser-test + --headed → ALLOW
echo "▸ Case 17: browser-test モード + --headed → ALLOW 期待"
ack_ok "browser-test:sequence=UC-01|videos=./v/"
check "playwright test allowed with --headed" 0 "$(run_gate_with Bash 'npx playwright test tests/login.spec.ts --headed')"

# Case 18: step6_mode=browser-test + HEADFUL=1 → ALLOW
echo "▸ Case 18: browser-test モード + HEADFUL=1 → ALLOW 期待"
ack_ok "browser-test:sequence=UC-01|videos=./v/"
check "playwright test allowed with HEADFUL=1" 0 "$(run_gate_with Bash 'HEADFUL=1 npx playwright test')"

# Case 19: playwright test --help はスキップ (通過)
echo "▸ Case 19: playwright test --help → ALLOW 期待 (help はスキップ)"
ack_ok "off:self-test documentation edit"
check "playwright test --help allowed" 0 "$(run_gate_with Bash 'npx playwright test --help')"

# Case 20: step6_mode=tdd で playwright test → BLOCK (tdd の browser-verify は別途 browser-test 再宣言が必要)
echo "▸ Case 20: tdd モードで playwright test → BLOCK 期待"
ack_ok "tdd:root-cause=r|fix=f|unit-test=u|deploy=d|browser-verify=v"
check "playwright test blocked in tdd mode" 2 "$(run_gate_with Bash 'npx playwright test')"

# Case 21: heredoc 内の "playwright test" 文字列 → ALLOW (false-positive 回避)
# git commit -m "$(cat <<'EOF' ... playwright test ... EOF)" 型の documentation を誤検知しない
echo "▸ Case 21: heredoc 内の 'playwright test' 文字列 → ALLOW 期待 (false-positive 回避)"
ack_ok "off:documentation-only edit for regression test"
HEREDOC_CMD='git commit -m "$(cat <<'"'"'EOF'"'"'
feat: mention playwright test in docs — not executing it
This message describes when npx playwright test was misused historically.
EOF
)"'
check "heredoc-embedded playwright test not detected as execution" 0 "$(run_gate_with Bash "$HEREDOC_CMD")"

# --------------------------------------------------------------------------
# v0.5.0 追加: videos=off:<reason> validation
# --------------------------------------------------------------------------

# Case 22: browser-test で videos=off:short (< 8 文字) → ack exit 5
echo "▸ Case 22: videos=off:short (< 8) → ack exit 5 期待"
rc=0
bash "$ACK" --step1 a --step2 b --step3 c --step4 d --step5 e \
  --step6 "browser-test:sequence=UC-01|videos=off:short|headed=true" >/dev/null 2>&1 || rc=$?
check "ack fails on videos=off:<8 chars reason" 5 "$rc"

# Case 23: browser-test で videos=off:validated-reason-abc → ack ok
echo "▸ Case 23: videos=off:validated-reason (>= 8) → ack ok + ALLOW 期待"
rc=0
bash "$ACK" --step1 a --step2 b --step3 c --step4 d --step5 e \
  --step6 "browser-test:sequence=UC-01|videos=off:user-not-requested-video|headed=true" >/dev/null 2>&1 || rc=$?
check "ack succeeds on videos=off:>=8 chars" 0 "$rc"
check "Read allowed after videos=off ack" 0 "$(run_gate_with Read)"

# Case 24: tdd で browser-verify=off:short (< 8) → ack exit 5
echo "▸ Case 24: browser-verify=off:short (< 8) → ack exit 5 期待"
rc=0
bash "$ACK" --step1 a --step2 b --step3 c --step4 d --step5 e \
  --step6 "tdd:root-cause=r|fix=f|unit-test=u|deploy=d|browser-verify=off:x" >/dev/null 2>&1 || rc=$?
check "ack fails on browser-verify=off:<8 chars" 5 "$rc"

# Case 25: tdd で browser-verify=off:validated-reason → ack ok
echo "▸ Case 25: browser-verify=off:validated-reason (>= 8) → ack ok 期待"
rc=0
bash "$ACK" --step1 a --step2 b --step3 c --step4 d --step5 e \
  --step6 "tdd:root-cause=r|fix=f|unit-test=u|deploy=d|browser-verify=off:no-video-requested" >/dev/null 2>&1 || rc=$?
check "ack succeeds on browser-verify=off:>=8 chars" 0 "$rc"

# Case 26: ack marker JSON に step6_video_state 記録確認
echo "▸ Case 26: marker JSON に step6_video_state=off 記録"
ack_ok "browser-test:sequence=UC-01|videos=off:user-not-requested-video|headed=true"
VS=$(python3 -c "import json; print(json.load(open('$TMP/.claude/state/protocol-ack.turn'))['step6_video_state'])")
if [ "$VS" = "off" ]; then
  echo "  ✅ PASS: step6_video_state=off recorded"
  pass=$((pass+1))
else
  echo "  ❌ FAIL: step6_video_state expected=off actual=$VS"
  fail=$((fail+1))
fi

# Case 27: ack marker JSON に step6_video_state=on 記録
echo "▸ Case 27: marker JSON に step6_video_state=on 記録"
ack_ok "browser-test:sequence=UC-01|videos=.test-logs/videos/|headed=true"
VS=$(python3 -c "import json; print(json.load(open('$TMP/.claude/state/protocol-ack.turn'))['step6_video_state'])")
if [ "$VS" = "on" ]; then
  echo "  ✅ PASS: step6_video_state=on recorded"
  pass=$((pass+1))
else
  echo "  ❌ FAIL: step6_video_state expected=on actual=$VS"
  fail=$((fail+1))
fi

# =============================================================================
# STEP 7: 日本語出力調整ゲート (v0.7.0) — 非阻止・自動判定
# =============================================================================

# marker の任意フィールドを読み出す helper
marker_field() {
  python3 -c "import json,sys; print(json.load(open('$TMP/.claude/state/protocol-ack.turn')).get(sys.argv[1],''))" "$1"
}

# 判定材料を完全に断つための helper (uname を Linux 詐称して地域設定判定を回避)
mkdir -p "$TMP/fakebin"
printf '#!/bin/sh\necho Linux\n' > "$TMP/fakebin/uname"
chmod +x "$TMP/fakebin/uname"

ack_raw() {
  # 全引数をそのまま ack に渡し、stdout を返す
  env -u LANG -u LC_ALL -u LC_MESSAGES PATH="$TMP/fakebin:$PATH" \
    CLAUDE_PROJECT_DIR="$TMP" bash "$ACK" "$@" 2>&1
}

# Case 28: 宣言文に かな → step7_ja_output=on
echo "▸ Case 28: 宣言文に かな を含む → STEP 7 適用 (on)"
ack_raw --step1 "接続確認 完了" --step2 declared --step3 foreground \
        --step4 "設定ファイルの修正" --step5 "作業手順" \
        --step6 "off:設定ファイルのみの編集で閲覧器操作なし" >/dev/null
check "step7_ja_output=on (かな検出)" "on" "$(marker_field step7_ja_output)"

# Case 29: 判定材料なし → step7_ja_output=off
echo "▸ Case 29: 英字のみ + 言語設定/地域設定なし → STEP 7 対象外 (off)"
ack_raw --step1 connected --step2 declared --step3 foreground \
        --step4 "edit config" --step5 "scope-contract" \
        --step6 "off:config-only edit no browser" >/dev/null
check "step7_ja_output=off (材料なし)" "off" "$(marker_field step7_ja_output)"

# Case 30: --ja-output on で強制適用
echo "▸ Case 30: --ja-output on → 強制適用"
ack_raw --step1 connected --step2 declared --step3 foreground \
        --step4 "edit config" --step5 "scope-contract" \
        --step6 "off:config-only edit no browser" --ja-output on >/dev/null
check "step7_ja_output=on (--ja-output on)" "on" "$(marker_field step7_ja_output)"

# Case 31: --ja-output off で強制無効
echo "▸ Case 31: 日本語宣言 + --ja-output off → 強制無効"
ack_raw --step1 "接続確認 完了" --step2 declared --step3 foreground \
        --step4 "設定ファイルの修正" --step5 "作業手順" \
        --step6 "off:設定ファイルのみの編集で閲覧器操作なし" --ja-output off >/dev/null
check "step7_ja_output=off (--ja-output off)" "off" "$(marker_field step7_ja_output)"

# Case 32: 環境変数 CCAGI_JA_OUTPUT=on
echo "▸ Case 32: 環境変数 CCAGI_JA_OUTPUT=on → 適用"
env -u LANG -u LC_ALL -u LC_MESSAGES PATH="$TMP/fakebin:$PATH" \
  CCAGI_JA_OUTPUT=on CLAUDE_PROJECT_DIR="$TMP" bash "$ACK" \
  --step1 connected --step2 declared --step3 foreground \
  --step4 "edit config" --step5 "scope-contract" \
  --step6 "off:config-only edit no browser" >/dev/null 2>&1
check "step7_ja_output=on (環境変数)" "on" "$(marker_field step7_ja_output)"

# Case 33: --ja-output 不正値 → exit 6
echo "▸ Case 33: --ja-output 不正値 → exit 6 期待"
rc=0
ack_raw --step1 connected --step2 declared --step3 foreground \
        --step4 "edit config" --step5 "scope-contract" \
        --step6 "off:config-only edit no browser" --ja-output yes >/dev/null 2>&1 || rc=$?
check "ack rejects invalid --ja-output" 6 "$rc"

# Case 34: 適用時に指針本文が出力される / 非適用時は出力されない
echo "▸ Case 34: 適用時のみ指針本文を出力"
OUT_ON="$(ack_raw --step1 connected --step2 declared --step3 foreground \
        --step4 "edit config" --step5 "scope-contract" \
        --step6 "off:config-only edit no browser" --ja-output on)"
OUT_OFF="$(ack_raw --step1 connected --step2 declared --step3 foreground \
        --step4 "edit config" --step5 "scope-contract" \
        --step6 "off:config-only edit no browser" --ja-output off)"
check "指針本文あり (on)"  1 "$(printf '%s' "$OUT_ON"  | grep -c '調整指針' || true)"
check "指針本文なし (off)" 0 "$(printf '%s' "$OUT_OFF" | grep -c '調整指針' || true)"

# Case 35: STEP 7 は阻止しない (適用時も ack は exit 0)
echo "▸ Case 35: STEP 7 適用時も ack は exit 0 (非阻止)"
rc=0
ack_raw --step1 "接続確認 完了" --step2 declared --step3 foreground \
        --step4 "設定ファイルの修正" --step5 "作業手順" \
        --step6 "off:設定ファイルのみの編集で閲覧器操作なし" >/dev/null 2>&1 || rc=$?
check "ack exit 0 with STEP 7 applied" 0 "$rc"

# Case 36: .claude/lib/ja-output-policy.md でプロジェクト独自指針に差し替え
echo "▸ Case 36: プロジェクト定義の指針で差し替え"
mkdir -p "$TMP/.claude/lib"
printf 'プロジェクト独自の指針 marker-XYZ です。\n' > "$TMP/.claude/lib/ja-output-policy.md"
OUT_CUSTOM="$(ack_raw --step1 connected --step2 declared --step3 foreground \
        --step4 "edit config" --step5 "scope-contract" \
        --step6 "off:config-only edit no browser" --ja-output on)"
check "プロジェクト定義が出力される" 1 "$(printf '%s' "$OUT_CUSTOM" | grep -c 'marker-XYZ' || true)"
rm -f "$TMP/.claude/lib/ja-output-policy.md"

# Case 37: protocol_version が 0.7.0
echo "▸ Case 37: marker の protocol_version=0.7.0"
check "protocol_version=0.7.0" "0.7.0" "$(marker_field protocol_version)"

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
