#!/usr/bin/env bash
# test-protocol-gate.sh — ccagi-protocol-gate v0.5.0 の機能テスト
#
# 検証項目:
#   T1. 動作目印 無し + Bash 呼び出し    → exit 2 (阻止)
#   T2. 動作目印 無し + Read 呼び出し    → exit 2 (阻止)
#   T3. 動作目印 有り + Bash 呼び出し    → exit 0 (通過)
#   T4. 動作目印 に ccagi-protocol-ack.sh を含む Bash → 常に通過 (再宣言許可)
#   T5. 動作目印 有り + 60 分超過 → exit 2 (期限切れ阻止)
#   T6. 応答完了門: 動作目印 有り → exit 0
#   T7. 応答完了門: 動作目印 無し → exit 2
#
# 使い方: bash test/test-protocol-gate.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATE_HOOK="$PKG_ROOT/hooks/protocol-gate.sh"
STOP_HOOK="$PKG_ROOT/hooks/protocol-stop-gate.sh"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

STATE_DIR="$WORK_DIR/.claude/state"
mkdir -p "$STATE_DIR"

PASS=0
FAIL=0

# 有効な 動作目印 を生成
make_valid_marker() {
  local age_min="${1:-0}"  # 秒指定で年齢を入れる場合は 0 = 現在時刻
  local acked_at
  if [ "$age_min" = "0" ]; then
    acked_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  else
    # macOS date と GNU date の両対応
    if date -v-${age_min}M > /dev/null 2>&1; then
      acked_at="$(date -u -v-${age_min}M +%Y-%m-%dT%H:%M:%SZ)"
    else
      acked_at="$(date -u -d "${age_min} minutes ago" +%Y-%m-%dT%H:%M:%SZ)"
    fi
  fi
  cat > "$STATE_DIR/protocol-ack.turn" <<JSON
{
  "acked_at": "$acked_at",
  "step1_mcp": "verified",
  "step2_declaration": "declared",
  "step3_mode": "foreground",
  "step4_scope": "test scope",
  "step5_claudemd": "test rules",
  "step5_claudemd_sha": "0000000000000000000000000000000000000000000000000000000000000000",
  "step6_evidence": "off:test only 8 chars",
  "step6_mode": "off",
  "step6_video_state": "n/a",
  "protocol_version": "0.5.0"
}
JSON
}

remove_marker() {
  rm -f "$STATE_DIR/protocol-ack.turn"
}

# 割込動作 呼び出し
call_gate() {
  local tool_name="$1"
  local cmd="${2:-}"
  local input_json
  if [ "$tool_name" = "Bash" ]; then
    input_json="$(python3 -c "import json;print(json.dumps({'tool_name':'Bash','tool_input':{'command':'$cmd'}}))")"
  else
    input_json="{\"tool_name\":\"$tool_name\"}"
  fi
  env CLAUDE_PROJECT_DIR="$WORK_DIR" bash "$GATE_HOOK" <<< "$input_json"
}

call_stop() {
  local input_json="{}"
  env CLAUDE_PROJECT_DIR="$WORK_DIR" bash "$STOP_HOOK" <<< "$input_json"
}

assert_rc() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✅ $label (rc=$actual)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label (期待 rc=$expected, 実測 rc=$actual)"
    FAIL=$((FAIL + 1))
  fi
}

# --------------------------------------------------------------------------
echo "=== T1: 動作目印 無し + Bash → 阻止 ==="
remove_marker
set +e
call_gate Bash "ls -la" > /dev/null 2>&1
rc=$?
set -e
assert_rc 2 "$rc" "T1: 動作目印 無 + Bash 呼び出し → 阻止"

# --------------------------------------------------------------------------
echo ""
echo "=== T2: 動作目印 無し + Read → 阻止 ==="
remove_marker
set +e
call_gate Read > /dev/null 2>&1
rc=$?
set -e
assert_rc 2 "$rc" "T2: 動作目印 無 + Read → 阻止"

# --------------------------------------------------------------------------
echo ""
echo "=== T3: 動作目印 有り + Bash → 通過 ==="
make_valid_marker 0
set +e
call_gate Bash "ls -la" > /dev/null 2>&1
rc=$?
set -e
assert_rc 0 "$rc" "T3: 動作目印 有 + 一般 Bash → 通過"

# --------------------------------------------------------------------------
echo ""
echo "=== T4: 動作目印 無し + ack 補助 呼び出し → 常に通過 ==="
remove_marker
set +e
call_gate Bash "bash scripts/ccagi-protocol-ack.sh --step1 verified" > /dev/null 2>&1
rc=$?
set -e
assert_rc 0 "$rc" "T4: 動作目印 無 + ack 補助 → 特別 許可 通過"

# --------------------------------------------------------------------------
echo ""
echo "=== T5: 動作目印 61 分 経過 → 期限切れ 阻止 ==="
make_valid_marker 61
set +e
call_gate Bash "ls -la" > /dev/null 2>&1
rc=$?
set -e
assert_rc 2 "$rc" "T5: 61 分 経過 動作目印 → 期限切れ 阻止"

# --------------------------------------------------------------------------
echo ""
echo "=== T6: 応答完了門: 動作目印 有り → 通過 ==="
make_valid_marker 0
set +e
call_stop > /dev/null 2>&1
rc=$?
set -e
assert_rc 0 "$rc" "T6: 応答完了門 + 動作目印 → 通過"

# --------------------------------------------------------------------------
echo ""
echo "=== T7: 応答完了門: 動作目印 無し → 阻止 ==="
remove_marker
set +e
call_stop > /dev/null 2>&1
rc=$?
set -e
assert_rc 2 "$rc" "T7: 応答完了門 + 動作目印 無 → 阻止"

# --------------------------------------------------------------------------
echo ""
echo "=== 集計 ==="
echo "  合格: $PASS"
echo "  失敗: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "❌ 機能 テスト 失敗"
  exit 1
fi
echo ""
echo "✅ 全 機能 テスト 合格"
