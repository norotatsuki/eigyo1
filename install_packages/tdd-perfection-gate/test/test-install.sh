#!/usr/bin/env bash
# tdd-perfection-gate — self-test
# install / uninstall / CLI 動作を検証
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# fake project
mkdir -p "$TMP/.claude/rules" "$TMP/.claude/state" "$TMP/scripts"
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

echo "🧪 tdd-perfection-gate self-test (v$(cat "$SRC/VERSION"))"
echo "   tmp: $TMP"
echo ""

# --------------------------------------------------------------------------
# Case 1: install
# --------------------------------------------------------------------------
echo "▸ Case 1: install に成功する (v1.1.0: 6 rules + 2 hooks + 4 scripts)"
bash "$SRC/install.sh" "$TMP" > /dev/null 2>&1
check "6 rules installed" 6 "$(ls "$TMP/.claude/rules"/*.md 2>/dev/null | wc -l | tr -d ' ')"
check "ccagi-pre-verdict-audit.sh installed" 1 "$([ -f "$TMP/scripts/ccagi-pre-verdict-audit.sh" ] && echo 1 || echo 0)"
check "ccagi-verify-uc-coverage.sh installed" 1 "$([ -f "$TMP/scripts/ccagi-verify-uc-coverage.sh" ] && echo 1 || echo 0)"
check "ccagi-arrow-verify.sh installed (v1.1.0)" 1 "$([ -f "$TMP/scripts/ccagi-arrow-verify.sh" ] && echo 1 || echo 0)"
check "ccagi-zero-bug-loop.sh installed (v1.1.0)" 1 "$([ -f "$TMP/scripts/ccagi-zero-bug-loop.sh" ] && echo 1 || echo 0)"
check "perfect-tdd-detector.sh installed (v1.1.0)" 1 "$([ -f "$TMP/.claude/hooks/perfect-tdd-detector.sh" ] && echo 1 || echo 0)"
check "perfect-tdd-stop-gate.sh installed (v1.1.0)" 1 "$([ -f "$TMP/.claude/hooks/perfect-tdd-stop-gate.sh" ] && echo 1 || echo 0)"
check "helpers copied" 1 "$([ -f "$TMP/tools/browser-test-plus/package.json" ] && echo 1 || echo 0)"
check "CLAUDE.md @import added" 6 "$(grep -c '^@import \.claude/rules/' "$TMP/CLAUDE.md")"
check "settings.json hooks registered (v1.1.0)" 2 "$(python3 -c "import json; d=json.load(open('$TMP/.claude/settings.json')); print(len(d.get('hooks',{})))" 2>/dev/null || echo 0)"

# --------------------------------------------------------------------------
# Case 2: install 2 回目は idempotent
# --------------------------------------------------------------------------
echo "▸ Case 2: 2 回目 install で @import が重複しない"
bash "$SRC/install.sh" "$TMP" > /dev/null 2>&1
check "CLAUDE.md @import still 6 (idempotent)" 6 "$(grep -c '^@import \.claude/rules/' "$TMP/CLAUDE.md")"
check "settings.json hooks still 2 (idempotent)" 2 "$(python3 -c "import json; d=json.load(open('$TMP/.claude/settings.json')); print(len(d.get('hooks',{})))" 2>/dev/null || echo 0)"

# --------------------------------------------------------------------------
# Case 3: ccagi-pre-verdict-audit.sh 5 flag 欠 → exit 1
# --------------------------------------------------------------------------
echo "▸ Case 3: ccagi-pre-verdict-audit.sh --verdict 欠落 → exit 1"
rc=0
bash "$TMP/scripts/ccagi-pre-verdict-audit.sh" \
  --db-probe "prisma.foo delta=1" \
  --audit-trail "audit delta=1" \
  --external-effect "n/a" \
  --uc-coverage "arrows=5 assertions=5" > /dev/null 2>&1 || rc=$?
check "missing --verdict → exit 1" 1 "$rc"

# --------------------------------------------------------------------------
# Case 4: ccagi-pre-verdict-audit.sh 全 flag 供給 → marker 3+1 生成
# --------------------------------------------------------------------------
echo "▸ Case 4: 全 flag 供給 → 4 marker 生成"
export CLAUDE_PROJECT_DIR="$TMP"
bash "$TMP/scripts/ccagi-pre-verdict-audit.sh" \
  --db-probe "prisma.audit_logs.count invoked=Y (before=100, after=101)" \
  --audit-trail "audit_logs.LOGIN_SUCCESS delta=1" \
  --external-effect "welcome mail 到達確認 (msgId=abc)" \
  --uc-coverage "arrows=5 assertions=5 ratio=100%" \
  --verdict "SPEC-PASS" > /dev/null 2>&1
check "db-probe marker created" 1 "$([ -f "$TMP/.claude/state/tdd-db-probe-verified.turn" ] && echo 1 || echo 0)"
check "audit-trail marker created" 1 "$([ -f "$TMP/.claude/state/tdd-audit-trail-verified.turn" ] && echo 1 || echo 0)"
check "external-effect marker created" 1 "$([ -f "$TMP/.claude/state/tdd-external-effect-verified.turn" ] && echo 1 || echo 0)"
check "verdict-recorded marker created" 1 "$([ -f "$TMP/.claude/state/tdd-verdict-recorded.turn" ] && echo 1 || echo 0)"

# --------------------------------------------------------------------------
# Case 5: 無効 verdict → exit 6
# --------------------------------------------------------------------------
echo "▸ Case 5: --verdict 無効値 → exit 6"
rc=0
bash "$TMP/scripts/ccagi-pre-verdict-audit.sh" \
  --db-probe "abcdefghij" \
  --audit-trail "abcdefghij" \
  --external-effect "abcdefghij" \
  --uc-coverage "abcdefghij" \
  --verdict "INVALID-VERDICT" > /dev/null 2>&1 || rc=$?
check "invalid --verdict → exit 6" 6 "$rc"

# --------------------------------------------------------------------------
# Case 6: 短すぎる flag 値 → exit 5
# --------------------------------------------------------------------------
echo "▸ Case 6: --db-probe が 8 文字未満 (非 n/a) → exit 5"
rc=0
bash "$TMP/scripts/ccagi-pre-verdict-audit.sh" \
  --db-probe "short" \
  --audit-trail "abcdefghij" \
  --external-effect "abcdefghij" \
  --uc-coverage "abcdefghij" \
  --verdict "UI-PASS" > /dev/null 2>&1 || rc=$?
check "short --db-probe → exit 5" 5 "$rc"

# --------------------------------------------------------------------------
# Case 7: n/a は 4 文字以上に緩和
# --------------------------------------------------------------------------
echo "▸ Case 7: --db-probe 'n/a: read-only' → 通過"
rc=0
bash "$TMP/scripts/ccagi-pre-verdict-audit.sh" \
  --db-probe "n/a: read-only" \
  --audit-trail "n/a: read-only" \
  --external-effect "n/a: no external" \
  --uc-coverage "arrows=5 assertions=5" \
  --verdict "UI-PASS" > /dev/null 2>&1 || rc=$?
check "n/a-prefixed values allowed" 0 "$rc"

# --------------------------------------------------------------------------
# Case 8: ccagi-verify-uc-coverage.sh — sample UC md + test で 100%
# --------------------------------------------------------------------------
echo "▸ Case 8: verify-uc-coverage で 100% ratio"
cat > "$TMP/uc-sample.md" <<'EOF'
# UC-SAMPLE

```mermaid
sequenceDiagram
  User->>Server: request
  Server->>DB: query
  DB-->>Server: rows
  Server-->>User: response
```
EOF
cat > "$TMP/test-sample.spec.ts" <<'EOF'
expect(a).toBeDefined();
expect(b).toBe(1);
assert(c);
expect(d).toEqual({});
EOF
rc=0
bash "$TMP/scripts/ccagi-verify-uc-coverage.sh" "$TMP/uc-sample.md" "$TMP/test-sample.spec.ts" > "$TMP/verify.out" 2>&1 || rc=$?
check "verify-uc-coverage exit 0 (100%)" 0 "$rc"
check "output contains FULL-COVERAGE" 1 "$(grep -c 'FULL-COVERAGE' "$TMP/verify.out")"

# --------------------------------------------------------------------------
# Case 9: verify-uc-coverage — assertion 不足で exit 1
# --------------------------------------------------------------------------
echo "▸ Case 9: verify-uc-coverage で assertion 不足 → exit 1"
cat > "$TMP/test-sparse.spec.ts" <<'EOF'
expect(a).toBeDefined();
EOF
rc=0
bash "$TMP/scripts/ccagi-verify-uc-coverage.sh" "$TMP/uc-sample.md" "$TMP/test-sparse.spec.ts" > "$TMP/verify.out" 2>&1 || rc=$?
check "verify-uc-coverage exit 1 (< 100%)" 1 "$rc"
check "output contains verdict: PARTIAL-COVERAGE" 1 "$(grep -c 'verdict: PARTIAL-COVERAGE' "$TMP/verify.out")"

# --------------------------------------------------------------------------
# Case 10: verify-uc-coverage — 発明 symbol 検出
# --------------------------------------------------------------------------
echo "▸ Case 10: verify-uc-coverage で F番号発明 symbol 検出"
cat > "$TMP/uc-invented.md" <<'EOF'
# UC-INVENTED (F11 API History)

```mermaid
sequenceDiagram
  User->>F11 Page: request
  F11 Page->>Server: fetch
```
EOF
bash "$TMP/scripts/ccagi-verify-uc-coverage.sh" "$TMP/uc-invented.md" "$TMP/test-sample.spec.ts" > "$TMP/invent.out" 2>&1 || true
check "invented symbol warned" 1 "$(grep -c 'suspicious invented symbols' "$TMP/invent.out")"

# --------------------------------------------------------------------------
# Case 11: v1.1.0 — perfect-tdd-detector が「完璧TDD」を検出して flag 生成
# --------------------------------------------------------------------------
echo "▸ Case 11 (v1.1.0): perfect-tdd-detector で trigger 検出"
rm -f "$TMP/.claude/state/perfect-tdd-mode.turn"
printf '%s' '{"user_message":"完璧なテスト駆動開発でこのシステムを実装してください"}' | \
  PERFECT_TDD_DETECTOR_QUIET=1 CLAUDE_PROJECT_DIR="$TMP" \
  bash "$TMP/.claude/hooks/perfect-tdd-detector.sh" > /dev/null 2>&1
check "perfect-tdd-mode.turn generated (v1.1.0)" 1 "$([ -f "$TMP/.claude/state/perfect-tdd-mode.turn" ] && echo 1 || echo 0)"

# 非トリガー時は no-op
rm -f "$TMP/.claude/state/perfect-tdd-mode.turn"
printf '%s' '{"user_message":"普通の質問"}' | \
  PERFECT_TDD_DETECTOR_QUIET=1 CLAUDE_PROJECT_DIR="$TMP" \
  bash "$TMP/.claude/hooks/perfect-tdd-detector.sh" > /dev/null 2>&1
check "non-trigger → no flag" 0 "$([ -f "$TMP/.claude/state/perfect-tdd-mode.turn" ] && echo 1 || echo 0)"

# --------------------------------------------------------------------------
# Case 12: v1.5.0 — ccagi-arrow-verify.sh 個別 arrow (矢印 1 本 × 5 フェーズ)
#
#   完璧TDD の定義 = シーケンスの矢印 1 本 1 本の動作確認 × 5 フェーズ
#     1 根本原因 / 2 改修 / 3 単体テスト / 4 デプロイ / 5 ブラウザ検証
# --------------------------------------------------------------------------
echo "▸ Case 12 (v1.5.0): 矢印 1 本につき 5 フェーズ全部を要求する"

# 5 フェーズ全部を渡すヘルパー (上書きしたい flag は引数で後置)
arrow_ok() {
  local uc="$1" idx="$2" kind="$3"; shift 3
  CLAUDE_PROJECT_DIR="$TMP" bash "$TMP/scripts/ccagi-arrow-verify.sh" \
    "$uc" "$idx" --kind "$kind" \
    --root-cause     ".test-logs/repro-${uc}-${idx}.log" \
    --fix            "src/${uc}.ts" \
    --unit-test      "src/${uc}.test.ts" \
    --deploy         ".deploy-logs/dev-2026-07-27.log" \
    --browser-verify "off:user-not-requested-video" \
    "$@"
}

rc=0
arrow_ok UC-SAMPLE 1 A1 > /dev/null 2>&1 || rc=$?
check "arrow verify (5 フェーズ揃い) → exit 0" 0 "$rc"
check "arrow marker generated" 1 "$([ -f "$TMP/.claude/state/tdd-arrow-UC-SAMPLE-1-verified.turn" ] && echo 1 || echo 0)"
check "marker に phases が記録される" 1 "$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
p=d.get("phases") or {}
need=("root_cause","fix","unit_test","deploy","browser_verify")
print(1 if all(str(p.get(k,"")).strip() for k in need) else 0)
' "$TMP/.claude/state/tdd-arrow-UC-SAMPLE-1-verified.turn" 2>/dev/null || echo 0)"

# 旧形式 (--evidence だけ) は通してはならない — これが今回の是正点
rc=0
CLAUDE_PROJECT_DIR="$TMP" bash "$TMP/scripts/ccagi-arrow-verify.sh" \
  UC-SAMPLE 9 --kind A1 --evidence "page.click triggered; DOM=OK" > /dev/null 2>&1 || rc=$?
check "arrow verify (--evidence のみ → 5 フェーズ欠落) → exit 1" 1 "$rc"
check "5 フェーズ欠落時は marker を作らない" 0 "$([ -f "$TMP/.claude/state/tdd-arrow-UC-SAMPLE-9-verified.turn" ] && echo 1 || echo 0)"

# 5 フェーズを 1 つずつ欠けさせて、どれが欠けても拒否されることを確認
for miss in root-cause fix unit-test deploy browser-verify; do
  rc=0
  args=(UC-SAMPLE 8 --kind A1)
  if [ "$miss" != "root-cause" ];     then args+=(--root-cause ".test-logs/r.log"); fi
  if [ "$miss" != "fix" ];            then args+=(--fix "src/a.ts"); fi
  if [ "$miss" != "unit-test" ];      then args+=(--unit-test "src/a.test.ts"); fi
  if [ "$miss" != "deploy" ];         then args+=(--deploy ".deploy-logs/dev.log"); fi
  if [ "$miss" != "browser-verify" ]; then args+=(--browser-verify "off:user-not-requested-video"); fi
  CLAUDE_PROJECT_DIR="$TMP" bash "$TMP/scripts/ccagi-arrow-verify.sh" \
    "${args[@]}" > /dev/null 2>&1 || rc=$?
  check "フェーズ ${miss} 欠落 → exit 1" 1 "$rc"
done

# 逃げ表現は 5 フェーズのどこに書いても拒否
rc=0
arrow_ok UC-SAMPLE 7 A4 --deploy "n/a: skip" > /dev/null 2>&1 || rc=$?
check "deploy=n/a (逃げ表現) → exit 1" 1 "$rc"

# ブラウザ検証の off: は 8 文字以上の理由が必要
rc=0
arrow_ok UC-SAMPLE 6 A6 --browser-verify "off:short" > /dev/null 2>&1 || rc=$?
check "browser-verify=off:<8文字未満> → exit 1" 1 "$rc"

# --------------------------------------------------------------------------
# Case 13: v1.5.0 — summary は「矢印 × 5 フェーズ」の直積で判定する
# --------------------------------------------------------------------------
echo "▸ Case 13 (v1.5.0): summary は 5 フェーズ完遂のみを網羅に数える"
mkdir -p "$TMP/docs/use_case"
cat > "$TMP/docs/use_case/UC-DEMO.md" <<'EOF'
# UC-DEMO
```mermaid
sequenceDiagram
    User->>API: request
    API-->>User: response
```
EOF
rm -f "$TMP/.claude/state"/tdd-arrow-*.turn "$TMP/.claude/state/uc-manifest.json"
CLAUDE_PROJECT_DIR="$TMP" bash "$TMP/scripts/ccagi-arrow-verify.sh" \
  --establish-manifest --uc-dir docs/use_case > /dev/null 2>&1

# 13-a: touch で作った空 marker では 100% にならない (証跡の偽装対策)
touch "$TMP/.claude/state/tdd-arrow-UC-DEMO-1-verified.turn"
touch "$TMP/.claude/state/tdd-arrow-UC-DEMO-2-verified.turn"
rc=0
CLAUDE_PROJECT_DIR="$TMP" bash "$TMP/scripts/ccagi-arrow-verify.sh" \
  --summary > /dev/null 2>&1 || rc=$?
check "touch で作った空 marker → summary 拒否 (exit 1)" 1 "$rc"
check "偽装 marker では summary marker を作らない" 0 "$([ -f "$TMP/.claude/state/tdd-arrow-summary.turn" ] && echo 1 || echo 0)"

# 13-b: 5 フェーズ完遂の marker で 100%
rm -f "$TMP/.claude/state"/tdd-arrow-*.turn
arrow_ok UC-DEMO 1 A1 > /dev/null 2>&1
arrow_ok UC-DEMO 2 A6 > /dev/null 2>&1
rc=0
CLAUDE_PROJECT_DIR="$TMP" bash "$TMP/scripts/ccagi-arrow-verify.sh" \
  --summary > /dev/null 2>&1 || rc=$?
check "summary 100% (全矢印 5 フェーズ完遂) → exit 0" 0 "$rc"
check "summary marker generated" 1 "$([ -f "$TMP/.claude/state/tdd-arrow-summary.turn" ] && echo 1 || echo 0)"
check "summary に必要証跡数 (矢印x5) が入る" 10 "$(python3 -c '
import json,sys; print(json.load(open(sys.argv[1]))["total_obligations"])
' "$TMP/.claude/state/tdd-arrow-summary.turn" 2>/dev/null || echo ERR)"

# --------------------------------------------------------------------------
# Case 14: zero-bug-loop 正常系
#
#   v1.4.0 で「部分絞込 (--cmd に一部テストだけを渡す) 阻止」が入ったため、
#   --cmd には全体走行の指示 (npm test 等) しか渡せない。
#   テスト用に package.json の test script を差し替えて全体走行を模す。
# --------------------------------------------------------------------------
echo "▸ Case 14: zero-bug-loop で連続 pass → marker 生成"

set_test_script() {
  # $1 = package.json の test script 本体
  S="$1" python3 - "$TMP/package.json" <<'PY'
import json, os, sys
with open(sys.argv[1], "w") as f:
    json.dump({"name": "tdd-gate-selftest", "version": "0.0.0",
               "scripts": {"test": os.environ["S"]}}, f)
PY
}

# 14-a: 部分絞込 (--cmd "true") は 全体走行 ではないので拒否される
rc=0
CLAUDE_PROJECT_DIR="$TMP" ZERO_BUG_QUIET=1 bash "$TMP/scripts/ccagi-zero-bug-loop.sh" \
  --cmd "true" --min-streak 2 --max-iterations 3 --label subset > /dev/null 2>&1 || rc=$?
check "zero-bug-loop (--cmd 'true' = 部分絞込) → 拒否 (exit 2)" 2 "$rc"

# 14-b: 全体走行が連続 pass → marker 生成
set_test_script "exit 0"
rm -f "$TMP/.claude/state/tdd-zero-bug-verified.turn"
rc=0
CLAUDE_PROJECT_DIR="$TMP" ZERO_BUG_QUIET=1 bash "$TMP/scripts/ccagi-zero-bug-loop.sh" \
  --cmd "npm test" --min-streak 2 --max-iterations 3 --label demo > /dev/null 2>&1 || rc=$?
check "zero-bug-loop (全体走行 all pass) → exit 0" 0 "$rc"
check "zero-bug marker generated" 1 "$([ -f "$TMP/.claude/state/tdd-zero-bug-verified.turn" ] && echo 1 || echo 0)"

# 14-c: 全体走行が全 fail → exit 3
set_test_script "exit 1"
rm -f "$TMP/.claude/state/tdd-zero-bug-verified.turn"
rc=0
CLAUDE_PROJECT_DIR="$TMP" ZERO_BUG_QUIET=1 bash "$TMP/scripts/ccagi-zero-bug-loop.sh" \
  --cmd "npm test" --min-streak 2 --max-iterations 3 --label fail > /dev/null 2>&1 || rc=$?
check "zero-bug-loop (全体走行 all fail) → exit 3" 3 "$rc"
check "fail 時は zero-bug marker を作らない" 0 "$([ -f "$TMP/.claude/state/tdd-zero-bug-verified.turn" ] && echo 1 || echo 0)"

# --------------------------------------------------------------------------
# Case 15: perfect-tdd-stop-gate 動作
#
#   v1.4.0 で「実行可能性 (feasible) の判定」が入った。
#   全体走行できるテスト指示と使用場面書フォルダが揃っていない環境では
#   feasible=false となり、無駄な繰返しを避けるため阻止しない。
#   ここでは両方揃った (feasible=true) 状態で阻止されることを確認する。
# --------------------------------------------------------------------------
echo "▸ Case 15: perfect-tdd-stop-gate — flag なし → exit 0, 実行可能 + marker 欠落 → exit 2"
# flag なし
rm -f "$TMP/.claude/state/perfect-tdd-mode.turn" "$TMP/.claude/state/perfect-tdd-stop.count"
rc=0
echo '{}' | CLAUDE_PROJECT_DIR="$TMP" bash "$TMP/.claude/hooks/perfect-tdd-stop-gate.sh" > /dev/null 2>&1 || rc=$?
check "stop-gate (no flag) → exit 0" 0 "$rc"

# 実行可能な前提を揃える (全体走行テスト + 使用場面書フォルダ)
set_test_script "exit 0"
mkdir -p "$TMP/docs/use_case"

# flag あり + marker 欠落
printf '%s' '{"user_message":"完璧TDD で修正してください"}' | \
  PERFECT_TDD_DETECTOR_QUIET=1 CLAUDE_PROJECT_DIR="$TMP" \
  bash "$TMP/.claude/hooks/perfect-tdd-detector.sh" > /dev/null 2>&1
check "detector が feasible=true を記録する" true "$(python3 -c '
import json,sys; print(str(json.load(open(sys.argv[1])).get("feasible")).lower())
' "$TMP/.claude/state/perfect-tdd-mode.turn" 2>/dev/null || echo ERR)"

rm -f "$TMP/.claude/state"/tdd-*.turn "$TMP/.claude/state/perfect-tdd-stop.count"
rc=0
echo '{}' | CLAUDE_PROJECT_DIR="$TMP" bash "$TMP/.claude/hooks/perfect-tdd-stop-gate.sh" > /dev/null 2>&1 || rc=$?
check "stop-gate (実行可能 + marker 欠落) → exit 2" 2 "$rc"

# --------------------------------------------------------------------------
# Case 16: uninstall
# --------------------------------------------------------------------------
echo "▸ Case 16: uninstall で rule / script / hook / helper / settings.json 削除"
bash "$SRC/uninstall.sh" "$TMP" > /dev/null 2>&1
check "rules removed" 0 "$(ls "$TMP/.claude/rules"/*.md 2>/dev/null | wc -l | tr -d ' ')"
check "hooks removed (v1.1.0)" 0 "$(ls "$TMP/.claude/hooks"/*.sh 2>/dev/null | wc -l | tr -d ' ')"
check "pre-verdict-audit removed" 0 "$([ -f "$TMP/scripts/ccagi-pre-verdict-audit.sh" ] && echo 1 || echo 0)"
check "arrow-verify removed (v1.1.0)" 0 "$([ -f "$TMP/scripts/ccagi-arrow-verify.sh" ] && echo 1 || echo 0)"
check "zero-bug-loop removed (v1.1.0)" 0 "$([ -f "$TMP/scripts/ccagi-zero-bug-loop.sh" ] && echo 1 || echo 0)"
check "helpers removed" 0 "$([ -d "$TMP/tools/browser-test-plus" ] && echo 1 || echo 0)"
check "CLAUDE.md @import removed" 0 "$(grep -c '^@import \.claude/rules/' "$TMP/CLAUDE.md")"
check "settings.json hooks removed" 0 "$(python3 -c "import json; d=json.load(open('$TMP/.claude/settings.json')); print(len(d.get('hooks',{})))" 2>/dev/null || echo 0)"

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
