#!/usr/bin/env bash
# ccagi-zero-bug-loop — テスト失敗数=0 を実測ループで確認する CLI
#
# tdd-perfection-gate v1.2.0
#
# 指定コマンドを foreground で --min-streak 回連続 pass するまで実行し、
# 成立したら .claude/state/tdd-zero-bug-verified.turn marker を生成する。
#
# v1.2.0 追加 (subset-scoping 対策):
#   --cmd に「テストの一部だけを回すズル」を仕込むと BLOCK する。
#     禁止 pattern 例:
#       --cmd "npm test -- --grep uuid"
#       --cmd "npm test -- some.test.ts"
#       --cmd "vitest run tests/uuid.test.ts"
#       --cmd "pytest -k uuid"
#       --cmd "jest --testPathPattern=uuid"
#     許可 pattern 例 (canonical form):
#       --cmd "npm test"
#       --cmd "pnpm test"
#       --cmd "yarn test"
#       --cmd "pytest"
#       --cmd "vitest run"
#       --cmd "playwright test"
#       --cmd "go test ./..."
#       --cmd "cargo test"
#   subset を意図的に許可したい場合は明示 override が必要:
#     CCAGI_ZERO_BUG_ALLOW_SUBSET=1 bash ccagi-zero-bug-loop.sh --cmd "..."
#   (marker に allow_subset=true が記録され、後で監査可能)
#
# Usage:
#   bash ccagi-zero-bug-loop.sh \
#     --cmd "<test command>" \
#     [--min-streak <N>] \
#     [--max-iterations <M>] \
#     [--timeout-sec <sec-per-run>] \
#     [--label <name>]
#
# Exit codes:
#   0 = zero-bug marker 生成 (連続 pass 達成)
#   1 = min-streak 未達 (途中失敗が残る)
#   2 = usage error / --cmd 検証失敗 (subset-scoping 検出)
#   3 = max-iterations 到達
#   124 = timeout (単発)
set -Eeuo pipefail

CMD=""
MIN_STREAK="${PERFECT_TDD_MIN_PASS_STREAK:-3}"
MAX_ITER=30
TIMEOUT_SEC=1800
LABEL="test"

usage() {
  cat <<'H'
Usage:
  ccagi-zero-bug-loop.sh --cmd "<test command>" \
      [--min-streak <N>]        default: 3
      [--max-iterations <M>]    default: 30
      [--timeout-sec <sec>]     default: 1800
      [--label <name>]          default: test

許可される --cmd (canonical form, 全体走行のみ):
  "npm test" / "npm run test"
  "pnpm test" / "pnpm run test"
  "yarn test"
  "pytest" (or "pytest -x" / "pytest --tb=short")
  "vitest run"
  "playwright test"
  "jest" (options 無し)
  "go test ./..."
  "cargo test"
  "mvn test"
  "gradle test"

BLOCK される --cmd (subset-scoping):
  "--grep <pattern>"           test 名で絞込
  "--only <name>"              単一 test
  "-t <pattern>"               test 名 filter
  "-k <pattern>"               pytest keyword filter
  "--testPathPattern=<...>"    jest path filter
  "--test-name-pattern=<...>"  vitest name filter
  "<foo>.test.ts" 系            単一 file 指定
  "<foo>.spec.js" 系            単一 file 指定
  "-- <path>"                   test runner への path 渡し

Environment:
  CCAGI_ZERO_BUG_ALLOW_SUBSET=1     subset 実行を明示許可 (記録される)
  CLAUDE_PROJECT_DIR                Project root (default: pwd)
  ZERO_BUG_QUIET=1                  各 run の tail 表示抑制

Marker output:
  .claude/state/tdd-zero-bug-verified.turn
H
}

while [ $# -gt 0 ]; do
  case "$1" in
    --cmd)            CMD="${2:-}"; shift 2 ;;
    --min-streak)     MIN_STREAK="${2:-}"; shift 2 ;;
    --max-iterations) MAX_ITER="${2:-}"; shift 2 ;;
    --timeout-sec)    TIMEOUT_SEC="${2:-}"; shift 2 ;;
    --label)          LABEL="${2:-}"; shift 2 ;;
    -h|--help)        usage; exit 0 ;;
    *) echo "❌ 未知の引数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$CMD" ]; then
  echo "❌ --cmd が必要です" >&2
  usage >&2
  exit 2
fi

for name in MIN_STREAK MAX_ITER TIMEOUT_SEC; do
  val="$(eval echo "\$$name")"
  case "$val" in
    ''|*[!0-9]*)
      echo "❌ --${name,,} の値が数値ではありません: '$val'" >&2
      exit 2
      ;;
  esac
done

if [ "$MIN_STREAK" -lt 1 ]; then
  echo "❌ --min-streak は 1 以上" >&2
  exit 2
fi

# --------------------------------------------------------------------------
# v1.2.0: --cmd 検証 (subset-scoping 対策の核)
# --------------------------------------------------------------------------
ALLOW_SUBSET="${CCAGI_ZERO_BUG_ALLOW_SUBSET:-0}"

# canonical form 判定
CANONICAL=""
case "$CMD" in
  "npm test"|"npm run test"|"npm test --"|"npm run test --")
    CANONICAL="npm"
    ;;
  "pnpm test"|"pnpm run test"|"pnpm test --"|"pnpm run test --")
    CANONICAL="pnpm"
    ;;
  "yarn test"|"yarn run test")
    CANONICAL="yarn"
    ;;
  "pytest"|"pytest -x"|"pytest --tb=short"|"pytest -x --tb=short"|"pytest -v"|"pytest -q")
    CANONICAL="pytest"
    ;;
  "vitest run"|"vitest"|"npx vitest run"|"npx vitest")
    CANONICAL="vitest"
    ;;
  "playwright test"|"npx playwright test"|"pnpm playwright test")
    CANONICAL="playwright"
    ;;
  "jest"|"npx jest")
    CANONICAL="jest"
    ;;
  "go test ./..."|"go test -race ./...")
    CANONICAL="go"
    ;;
  "cargo test"|"cargo test --all")
    CANONICAL="cargo"
    ;;
  "mvn test"|"mvn -q test")
    CANONICAL="maven"
    ;;
  "gradle test"|"./gradlew test")
    CANONICAL="gradle"
    ;;
esac

# subset-scoping 禁止 pattern
SUBSET_DETECT=""
case "$CMD" in
  *' --grep '*|*' --grep='*)
    SUBSET_DETECT="--grep で test 名フィルタしています"
    ;;
  *' --only '*|*' --only='*)
    SUBSET_DETECT="--only で単一 test に絞込しています"
    ;;
  *' -t '*)
    SUBSET_DETECT="-t で test 名フィルタしています"
    ;;
  *' -k '*)
    SUBSET_DETECT="-k (pytest keyword) で絞込しています"
    ;;
  *'--testPathPattern'*)
    SUBSET_DETECT="--testPathPattern で path フィルタしています"
    ;;
  *'--test-name-pattern'*)
    SUBSET_DETECT="--test-name-pattern で名前フィルタしています"
    ;;
  *'--test-file'*)
    SUBSET_DETECT="--test-file で単一 file を指定しています"
    ;;
  *'--file '*|*'--file='*|*'--files '*|*'--files='*)
    SUBSET_DETECT="--file(s) で file を明示指定しています"
    ;;
  *'.test.ts'*|*'.test.tsx'*|*'.test.js'*|*'.test.jsx'*|*'.test.mjs'*|*'.test.cjs'*|*'.test.py'*)
    SUBSET_DETECT="単一 test file を argv に含んでいます"
    ;;
  *'.spec.ts'*|*'.spec.tsx'*|*'.spec.js'*|*'.spec.jsx'*|*'.spec.mjs'*|*'.spec.cjs'*|*'.spec.py'*)
    SUBSET_DETECT="単一 spec file を argv に含んでいます"
    ;;
esac

if [ -z "$CANONICAL" ] || [ -n "$SUBSET_DETECT" ]; then
  if [ "$ALLOW_SUBSET" != "1" ]; then
    cat >&2 <<EOF
🚫 バグ零繰返しの実行指示を拒否しました (部分絞込 対策)

受け取った --cmd: "$CMD"
検出内容:         ${SUBSET_DETECT:-正規 (全体走行) の形式ではありません}

「テストの一部だけを回して 3 回連続 合格 と主張する」ズルを構造的に禁止
しています。 --cmd には以下の 正規 (全体走行) 指示のみを渡してください:

  "npm test"        "pnpm test"      "yarn test"
  "pytest"          "vitest run"     "playwright test"
  "jest"            "go test ./..."  "cargo test"
  "mvn test"        "gradle test"

もし正当な理由 (単一ファイルだけを走らせる特殊環境等) がある場合、明示上書き:
  CCAGI_ZERO_BUG_ALLOW_SUBSET=1 bash scripts/ccagi-zero-bug-loop.sh --cmd "$CMD" ...

上書き使用時は目印に allow_subset=true が記録されます (監査可能)。
ただし「完璧テスト駆動」 が活性中は allow_subset は許されません
(完璧テスト駆動 停止門が別途拒否します)。

出典: 2026-07-26 部分絞込事故 (テスト全体 108 件対象を、自追加の
      uuid.test.ts (8 件) だけで 3 回連続 合格 と主張)
EOF
    exit 2
  fi
  echo "⚠️  --cmd の subset-scoping を CCAGI_ZERO_BUG_ALLOW_SUBSET=1 で override しました (marker に記録)" >&2
  CANONICAL="subset-override"
fi

SAFE_LABEL="$(printf '%s' "$LABEL" | tr -c 'A-Za-z0-9._-' '_')"

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.claude/state"
LOG_DIR="${STATE_DIR}/zero-bug-logs"
mkdir -p "$LOG_DIR"
MARKER="${STATE_DIR}/tdd-zero-bug-verified.turn"

echo "▸ zero-bug loop starting"
echo "  cmd:          $CMD"
echo "  canonical:    $CANONICAL"
echo "  allow_subset: ${ALLOW_SUBSET}"
echo "  min-streak:   $MIN_STREAK"
echo "  max-iters:    $MAX_ITER"
echo "  timeout/run:  ${TIMEOUT_SEC}s"
echo "  label:        $SAFE_LABEL"
echo "  log-dir:      $LOG_DIR"
echo ""

streak=0
history=""
run_metrics="[]"

for i in $(seq 1 "$MAX_ITER"); do
  LOG_FILE="${LOG_DIR}/${SAFE_LABEL}-$(printf '%03d' "$i").log"
  START_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "─── run #${i} (streak=${streak}/${MIN_STREAK}) at ${START_TS}"

  set +e
  {
    printf '[cmd] %s\n[cwd] %s\n[start] %s\n[timeout] %s sec\n\n' \
      "$CMD" "$PROJECT_ROOT" "$START_TS" "$TIMEOUT_SEC"
    # テスト指示は必ず プロジェクト直下 で走らせる。
    # ここを現在地任せにすると、hook や 別フォルダ から呼ばれたときに
    # 「別プロジェクトのテストが通った」を ゼロバグ と誤認する。
    ( cd "$PROJECT_ROOT" && timeout "$TIMEOUT_SEC" bash -c "$CMD" ) 2>&1
    rc=$?
    printf '\n[end] %s\n[rc]  %d\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rc"
    exit $rc
  } | tee "$LOG_FILE"
  rc=${PIPESTATUS[0]}
  set -e
  END_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  case "$rc" in
    0)   result="PASS"; streak=$((streak + 1)) ;;
    124) result="TIMEOUT"; streak=0 ;;
    *)   result="FAIL"; streak=0 ;;
  esac

  history="${history}${result} "
  run_metrics="$(RM="$run_metrics" I="$i" R="$result" RC="$rc" ST="$START_TS" ET="$END_TS" LF="$LOG_FILE" \
    python3 - <<'PY'
import json, os
arr = json.loads(os.environ["RM"])
arr.append({
    "iter":     int(os.environ["I"]),
    "result":   os.environ["R"],
    "rc":       int(os.environ["RC"]),
    "start":    os.environ["ST"],
    "end":      os.environ["ET"],
    "log_file": os.environ["LF"],
})
print(json.dumps(arr))
PY
  )"

  echo "  result=${result} rc=${rc} streak=${streak}/${MIN_STREAK} log=${LOG_FILE}"

  if [ "$streak" -ge "$MIN_STREAK" ]; then
    TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    METRICS="$run_metrics" TS="$TS" CMD="$CMD" STREAK="$MIN_STREAK" LABEL="$SAFE_LABEL" \
      HISTORY="$history" MARKER="$MARKER" CANONICAL="$CANONICAL" ALLOW_SUBSET="$ALLOW_SUBSET" \
      python3 - <<'PY'
import json, os
data = {
    "verified_at":  os.environ["TS"],
    "cmd":          os.environ["CMD"],
    "canonical":    os.environ["CANONICAL"],
    "allow_subset": os.environ["ALLOW_SUBSET"] == "1",
    "label":        os.environ["LABEL"],
    "min_streak":   int(os.environ["STREAK"]),
    "history":      os.environ["HISTORY"].split(),
    "runs":         json.loads(os.environ["METRICS"]),
    "protocol":     "tdd-perfection-gate v1.2.0",
}
with open(os.environ["MARKER"], "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
    echo ""
    echo "✅ zero-bug verified: 連続 ${MIN_STREAK} 回 PASS 達成"
    echo "   history:      ${history}"
    echo "   canonical:    ${CANONICAL}"
    echo "   allow_subset: ${ALLOW_SUBSET}"
    echo "   marker:       ${MARKER}"
    exit 0
  fi

  if [ "$rc" != "0" ]; then
    echo ""
    echo "  → 失敗検出。streak をリセットして次 iter に進みます。"
    if [ "${ZERO_BUG_QUIET:-}" != "1" ]; then
      echo "  --- last 20 lines of failing log ---"
      tail -n 20 "$LOG_FILE" | sed 's/^/  | /'
      echo ""
    fi
  fi
done

echo ""
echo "❌ max-iterations (${MAX_ITER}) 到達しても連続 ${MIN_STREAK} 回 PASS に到達できず"
echo "   history: ${history}"
echo "   marker は生成されません。個別失敗 log を確認して根本修正してください。"
echo "   log dir: ${LOG_DIR}"
exit 3
