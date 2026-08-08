#!/usr/bin/env bash
# test-perfect-tdd.sh — tdd-perfection-gate v1.4.0 の機能テスト
#
# 検証項目:
#   T1.  検出器: 「完璧なテスト駆動開発」+ 作業依頼 → 態勢目印 生成
#   T2.  検出器: 通常入力 → 態勢目印 生成しない
#   T3.  検出器: perfect TDD 英字 + 作業依頼 → 態勢目印 生成
#   T4.  応答完了門: 態勢目印 無し → 通過 (無関係)
#   T5.  応答完了門: 態勢目印 有り + 5 個 目印 揃い → 通過
#   T6.  応答完了門: 態勢目印 有り + 目印 欠落 → 阻止
#   T7.  応答完了門: 無進捗 3 回連続 → 4 回目 で 態勢解除 通過
#   --- v1.4.0 追加分 ---
#   T8.  検出器: 問い合わせのみ (疑問形 + 作業動詞なし) → 起動しない
#   T9.  検出器: 実行可能性の判定を 態勢目印 に記録する (前提なし → feasible=false)
#   T10. 検出器: 前提あり → feasible=true
#   T11. 応答完了門: feasible=false → 阻止せず通過 (無駄な繰返しを断つ)
#   T12. 応答完了門: 進捗があれば 無進捗上限を超えても阻止し続ける (バグ零まで止まらない)
#   T13. 応答完了門: 封じ込め設定なら feasible=false でも阻止する
#   T14. 途中打切り検出係: 地の文の逃げ口上 → 阻止
#   T15. 途中打切り検出係: ファイル名の一部 / 引用文 / コード塊 → 阻止しない
#
# 使い方: bash test/test-perfect-tdd.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DETECTOR="$PKG_ROOT/hooks/perfect-tdd-detector.sh"
STOP_GATE="$PKG_ROOT/hooks/perfect-tdd-stop-gate.sh"
DEFER_GATE="$PKG_ROOT/hooks/perfect-tdd-defer-detector.sh"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

STATE_DIR="$WORK_DIR/.claude/state"
mkdir -p "$STATE_DIR"

PASS=0
FAIL=0

call_detector() {
  local user_msg="$1"
  local json
  json="$(CCAGI_MSG="$user_msg" python3 -c \
    'import json,os;print(json.dumps({"user_message":os.environ["CCAGI_MSG"]}))')"
  env CLAUDE_PROJECT_DIR="$WORK_DIR" PERFECT_TDD_DETECTOR_QUIET=1 \
    bash "$DETECTOR" <<< "$json"
}

call_stop() {
  env CLAUDE_PROJECT_DIR="$WORK_DIR" "$@" bash "$STOP_GATE" <<< '{}'
}

# 途中打切り検出係は transcript を読むため、偽の記録簿を作って渡す
call_defer() {
  local assistant_text="$1"
  local tr="$WORK_DIR/transcript.jsonl"
  CCAGI_TXT="$assistant_text" python3 - "$tr" <<'PY'
import json, os, sys
with open(sys.argv[1], "w") as f:
    f.write(json.dumps({
        "type": "assistant",
        "message": {"content": [{"type": "text", "text": os.environ["CCAGI_TXT"]}]},
    }) + "\n")
PY
  env CLAUDE_PROJECT_DIR="$WORK_DIR" bash "$DEFER_GATE" \
    <<< "$(python3 -c 'import json,sys;print(json.dumps({"transcript_path":sys.argv[1]}))' "$tr")"
}

make_all_markers() {
  touch "$STATE_DIR/tdd-arrow-summary.turn"
  touch "$STATE_DIR/tdd-zero-bug-verified.turn"
  touch "$STATE_DIR/tdd-db-probe-verified.turn"
  touch "$STATE_DIR/tdd-audit-trail-verified.turn"
  touch "$STATE_DIR/tdd-external-effect-verified.turn"
}

reset_all() {
  rm -f "$STATE_DIR"/tdd-*.turn "$STATE_DIR"/perfect-tdd-*.turn \
        "$STATE_DIR"/perfect-tdd-*.count "$STATE_DIR"/perfect-tdd-*.progress \
        "$STATE_DIR"/perfect-tdd-*.total 2>/dev/null || true
  rm -rf "$WORK_DIR/package.json" "$WORK_DIR/docs" 2>/dev/null || true
}

# 実行可能性の前提を揃える (全体走行テスト + 使用場面書)
setup_capabilities() {
  python3 - "$WORK_DIR/package.json" <<'PY'
import json, sys
with open(sys.argv[1], "w") as f:
    json.dump({"name": "t", "scripts": {"test": "echo ok"}}, f)
PY
  mkdir -p "$WORK_DIR/docs/use_case"
}

assert_rc() {
  local expected="$1" actual="$2" label="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✅ $label (rc=$actual)"; PASS=$((PASS + 1))
  else
    echo "  ❌ $label (期待 rc=$expected, 実測 rc=$actual)"; FAIL=$((FAIL + 1))
  fi
}

assert_exists() {
  if [ -f "$1" ]; then echo "  ✅ $2 (存在)"; PASS=$((PASS + 1))
  else echo "  ❌ $2 (不在)"; FAIL=$((FAIL + 1)); fi
}

assert_absent() {
  if [ ! -f "$1" ]; then echo "  ✅ $2 (不在)"; PASS=$((PASS + 1))
  else echo "  ❌ $2 (存在してはならない)"; FAIL=$((FAIL + 1)); fi
}

assert_json_field() {
  local path="$1" field="$2" expected="$3" label="$4"
  local actual
  actual="$(P="$path" F="$field" python3 -c \
    'import json,os;print(json.dumps(json.load(open(os.environ["P"])).get(os.environ["F"])))' \
    2>/dev/null || echo "ERROR")"
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $label ($field=$actual)"; PASS=$((PASS + 1))
  else
    echo "  ❌ $label (期待 $field=$expected, 実測 $actual)"; FAIL=$((FAIL + 1))
  fi
}

run_stop() {
  set +e
  call_stop "$@" > /dev/null 2>&1
  local rc=$?
  set -e
  echo "$rc"
}

# --------------------------------------------------------------------------
echo "=== T1: 検出器: 完璧号令 + 作業依頼 → 態勢目印 生成 ==="
reset_all
call_detector "完璧なテスト駆動開発で修正してください" > /dev/null 2>&1
assert_exists "$STATE_DIR/perfect-tdd-mode.turn" "T1: 完璧号令 + 作業依頼 → 態勢目印 生成"

echo ""
echo "=== T2: 検出器: 通常 入力 → 態勢目印 生成しない ==="
reset_all
call_detector "普通の依頼です" > /dev/null 2>&1
assert_absent "$STATE_DIR/perfect-tdd-mode.turn" "T2: 通常 入力 → 態勢目印 生成せず"

echo ""
echo "=== T3: 検出器: perfect TDD 英字 + 作業依頼 → 態勢目印 生成 ==="
reset_all
call_detector "perfect TDD で implement してください" > /dev/null 2>&1
assert_exists "$STATE_DIR/perfect-tdd-mode.turn" "T3: perfect TDD 英字 → 態勢目印 生成"

echo ""
echo "=== T4: 応答完了門: 態勢目印 無し → 通過 (無関係) ==="
reset_all
assert_rc 0 "$(run_stop)" "T4: 態勢目印 無 → 通過"

echo ""
echo "=== T5: 応答完了門: 態勢目印 有り + 5 個 目印 揃い → 通過 ==="
reset_all
touch "$STATE_DIR/perfect-tdd-mode.turn"
make_all_markers
assert_rc 0 "$(run_stop)" "T5: 態勢目印 有 + 5 目印 揃 → 通過"

echo ""
echo "=== T6: 応答完了門: 態勢目印 有り + 目印 欠落 → 阻止 ==="
reset_all
setup_capabilities
call_detector "完璧なテスト駆動開発で修正してください" > /dev/null 2>&1
touch "$STATE_DIR/tdd-db-probe-verified.turn"
touch "$STATE_DIR/tdd-audit-trail-verified.turn"
touch "$STATE_DIR/tdd-external-effect-verified.turn"
assert_rc 2 "$(run_stop)" "T6: 態勢目印 有 + 目印 欠落 → 阻止"

echo ""
echo "=== T7: 応答完了門: 無進捗 3 回連続 → 4 回目 で 態勢解除 通過 ==="
reset_all
setup_capabilities
call_detector "完璧なテスト駆動開発で修正してください" > /dev/null 2>&1
rc=0
for i in 1 2 3; do rc="$(run_stop)"; done
assert_rc 2 "$rc" "T7a: 無進捗 3 回目 までは 阻止"
assert_rc 0 "$(run_stop)" "T7b: 無進捗 4 回目 は 態勢解除 通過"
assert_absent "$STATE_DIR/perfect-tdd-mode.turn" "T7c: 態勢解除 後 態勢目印 は 削除"

echo ""
echo "=== T8: 検出器: 問い合わせのみ → 起動しない ==="
reset_all
call_detector "完璧なテスト駆動開発が適用されるゲート6は有効になっていますか？" > /dev/null 2>&1
assert_absent "$STATE_DIR/perfect-tdd-mode.turn" "T8: 疑問形 + 作業動詞なし → 態勢を張らない"

echo ""
echo "=== T9: 検出器: 前提なし → feasible=false を記録 ==="
reset_all
call_detector "完璧なテスト駆動開発で修正してください" > /dev/null 2>&1
assert_json_field "$STATE_DIR/perfect-tdd-mode.turn" "feasible" "false" "T9: 前提なし → feasible=false"

echo ""
echo "=== T10: 検出器: 前提あり → feasible=true を記録 ==="
reset_all
setup_capabilities
call_detector "完璧なテスト駆動開発で修正してください" > /dev/null 2>&1
assert_json_field "$STATE_DIR/perfect-tdd-mode.turn" "feasible" "true" "T10: 前提あり → feasible=true"

echo ""
echo "=== T11: 応答完了門: feasible=false → 阻止せず通過 ==="
reset_all
call_detector "完璧なテスト駆動開発で修正してください" > /dev/null 2>&1
assert_rc 0 "$(run_stop)" "T11: 実行不能 → 1 回目 で 通過 (無駄な繰返しなし)"

echo ""
echo "=== T12: 応答完了門: 進捗があれば 無進捗上限を超えても阻止 (バグ零まで止まらない) ==="
reset_all
setup_capabilities
call_detector "完璧なテスト駆動開発で修正してください" > /dev/null 2>&1
rc=0
# 毎回 矢印 の 証跡 を 1 つずつ増やす = 手を動かし続けている状態
for i in 1 2 3 4 5 6 7 8; do
  touch "$STATE_DIR/tdd-arrow-UC01-${i}-verified.turn"
  rc="$(run_stop)"
done
assert_rc 2 "$rc" "T12: 進捗が続く限り 8 回目 でも 阻止 (回数上限なし)"

echo ""
echo "=== T13: 応答完了門: 封じ込め設定なら feasible=false でも阻止 ==="
reset_all
call_detector "完璧なテスト駆動開発で修正してください" > /dev/null 2>&1
assert_rc 2 "$(run_stop CCAGI_PERFECT_TDD_NO_ESCAPE=1)" "T13: 封じ込め設定 → 実行不能でも 阻止"

echo ""
echo "=== T14: 途中打切り検出係: 地の文の逃げ口上 → 阻止 ==="
reset_all
touch "$STATE_DIR/perfect-tdd-mode.turn"
set +e
call_defer "残りは別セッションで対応します。" > /dev/null 2>&1
rc=$?
set -e
assert_rc 2 "$rc" "T14: 地の文の逃げ口上 → 阻止"

echo ""
echo "=== T15: 途中打切り検出係: ファイル名 / 引用 / コード塊 → 阻止しない ==="
reset_all
touch "$STATE_DIR/perfect-tdd-mode.turn"
set +e
call_defer '設定を確認しました。

`perfect-tdd-defer-detector.sh` が二重登録されています。
門の出力は以下でした:

> 🚫 defer を検出しました

```bash
# defer 用の迂回設定
export CCAGI_PERFECT_TDD_DEFER_ACK=1
```
' > /dev/null 2>&1
rc=$?
set -e
assert_rc 0 "$rc" "T15: 言及にすぎない部分 → 阻止しない"

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
