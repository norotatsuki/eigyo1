#!/usr/bin/env bash
# ccagi-pre-verdict-audit — PASS 宣言前 self-audit marker 生成 CLI
#
# tdd-perfection-gate v1.0.0
#
# 「PASS」verdict を宣言する前に、self-audit の結果を marker として
# .claude/state/ に記録する。ccagi-protocol-gate v0.5.0 の Stop hook は
# `step6_mode=tdd|browser-test` かつ 応答文中に verdict 系キーワード
# (PASS/完璧/GREEN/verdict:) 検出時、以下 3 marker の存在を要求する:
#
#   .claude/state/tdd-db-probe-verified.turn
#   .claude/state/tdd-audit-trail-verified.turn
#   .claude/state/tdd-external-effect-verified.turn
#
# 本 script はこれらを一括生成する。
#
# Usage:
#   bash ccagi-pre-verdict-audit.sh \
#     --db-probe "<Q1: DB probe 結果>" \
#     --audit-trail "<Q2: audit trail delta 結果>" \
#     --external-effect "<Q3: external side-effect 到達確認 or 該当なし理由>" \
#     --uc-coverage "<Q4: UC md ↔ test 1:1 mapping 結果>" \
#     --verdict "<UI-PASS|CONTRACT-PASS|SEQUENCE-PASS|SPEC-PASS|FAIL|AUDIT-MISSING|...>"
#
# 5 flag 全て必須。1 つでも欠けたら error。
# 各 flag の値は 8 文字以上を要求 ("n/a" 等の逃げを構造的に阻止)。
# ただし「該当なし」を含む場合は 4 文字以上に緩和 (例: "n/a: read-only").
#
# 参照:
#   rules/sequence-complete-verify.md — 4 tier verify 定義
#   rules/audit-trail-mandatory.md — audit_logs delta 必須
#   rules/verdict-vocabulary.md — 4 tier verdict マップ
#   rules/pre-verdict-self-audit.md — Q1-Q4 self-audit
#
set -euo pipefail

DB_PROBE=""
AUDIT_TRAIL=""
EXTERNAL_EFFECT=""
UC_COVERAGE=""
VERDICT=""

usage() {
  cat <<'H'
Usage:
  ccagi-pre-verdict-audit.sh \
    --db-probe        "<Q1 result>" \
    --audit-trail     "<Q2 result>" \
    --external-effect "<Q3 result>" \
    --uc-coverage     "<Q4 result>" \
    --verdict         "<verdict tier>"

Records self-audit results as marker files under .claude/state/,
which are required by ccagi-protocol-gate v0.5.0 Stop hook when
verdict-like keywords are detected in the assistant response.

Verdict tiers (rules/verdict-vocabulary.md):
  UI-PASS         — HTTP 200 + DOM only (Tier 1)
  CONTRACT-PASS   — + API schema verify (Tier 1+2)
  SEQUENCE-PASS   — + DB delta + external side-effect (Tier 1+2+3)
  SPEC-PASS       — + audit trail (Tier 1+2+3+4)
  PARTIAL-COVERAGE / AUDIT-MISSING / EXTERNAL-UNVERIFIED / FAIL / FLAKY / REGRESSION

Environment:
  CLAUDE_PROJECT_DIR   Project root (default: pwd)

Example (SPEC-PASS with all 4 tiers verified):
  ccagi-pre-verdict-audit.sh \
    --db-probe "prisma.audit_logs.count invoked=Y (before=100, after=101, delta=1)" \
    --audit-trail "audit_logs.LOGIN_SUCCESS delta=1" \
    --external-effect "welcome mail 到達確認 (Blast Engine dashboard msgId=abc123)" \
    --uc-coverage "arrows=8 assertions=8 ratio=100%" \
    --verdict "SPEC-PASS"

Example (UI-PASS for read-only screen):
  ccagi-pre-verdict-audit.sh \
    --db-probe "n/a: read-only screen, no DB write" \
    --audit-trail "n/a: read-only, no audit event" \
    --external-effect "n/a: no external side-effect" \
    --uc-coverage "arrows=5 assertions=5 ratio=100%" \
    --verdict "UI-PASS"
H
}

while [ $# -gt 0 ]; do
  case "$1" in
    --db-probe)        DB_PROBE="${2:-}"; shift 2 ;;
    --audit-trail)     AUDIT_TRAIL="${2:-}"; shift 2 ;;
    --external-effect) EXTERNAL_EFFECT="${2:-}"; shift 2 ;;
    --uc-coverage)     UC_COVERAGE="${2:-}"; shift 2 ;;
    --verdict)         VERDICT="${2:-}"; shift 2 ;;
    -h|--help)         usage; exit 0 ;;
    *) echo "❌ Unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

MISSING=""
[ -z "$DB_PROBE" ]        && MISSING="$MISSING --db-probe"
[ -z "$AUDIT_TRAIL" ]     && MISSING="$MISSING --audit-trail"
[ -z "$EXTERNAL_EFFECT" ] && MISSING="$MISSING --external-effect"
[ -z "$UC_COVERAGE" ]     && MISSING="$MISSING --uc-coverage"
[ -z "$VERDICT" ]         && MISSING="$MISSING --verdict"
if [ -n "$MISSING" ]; then
  echo "❌ Missing required args:$MISSING" >&2
  echo "" >&2
  usage >&2
  exit 1
fi

# 各 flag の最小文字数チェック
# "n/a", "N/A", "該当なし" を含む場合は 4 文字以上に緩和、それ以外は 8 文字以上
validate_flag() {
  local name="$1" value="$2"
  local min=8
  case "$value" in
    *n/a*|*N/A*|*該当なし*|*not[[:space:]]applicable*)
      min=4
      ;;
  esac
  if [ "${#value}" -lt "$min" ]; then
    echo "❌ ${name} が短すぎます (${#value} chars, 最小 ${min})" >&2
    echo "   受け取った値: $value" >&2
    return 5
  fi
  return 0
}

validate_flag "--db-probe" "$DB_PROBE"               || exit 5
validate_flag "--audit-trail" "$AUDIT_TRAIL"         || exit 5
validate_flag "--external-effect" "$EXTERNAL_EFFECT" || exit 5
validate_flag "--uc-coverage" "$UC_COVERAGE"         || exit 5

# verdict の値検証
VERDICT_VALID=0
for v in UI-PASS CONTRACT-PASS SEQUENCE-PASS SPEC-PASS PARTIAL-COVERAGE AUDIT-MISSING EXTERNAL-UNVERIFIED SEQUENCE-PARTIAL FAIL FLAKY REGRESSION; do
  if [ "$VERDICT" = "$v" ]; then
    VERDICT_VALID=1
    break
  fi
done
if [ "$VERDICT_VALID" = "0" ]; then
  echo "❌ --verdict の値が無効です: $VERDICT" >&2
  echo "   許容値: UI-PASS / CONTRACT-PASS / SEQUENCE-PASS / SPEC-PASS /" >&2
  echo "           PARTIAL-COVERAGE / AUDIT-MISSING / EXTERNAL-UNVERIFIED /" >&2
  echo "           SEQUENCE-PARTIAL / FAIL / FLAKY / REGRESSION" >&2
  exit 6
fi

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.claude/state"
mkdir -p "$STATE_DIR"

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

write_marker() {
  local name="$1" body="$2"
  local file="${STATE_DIR}/tdd-${name}-verified.turn"
  DB="$body" TS="$TS" VERDICT="$VERDICT" MARKER="$file" NAME="$name" \
    python3 - <<'PY'
import json, os
data = {
    "verified_at": os.environ["TS"],
    "verdict":     os.environ["VERDICT"],
    "field":       os.environ["NAME"],
    "value":       os.environ["DB"],
    "protocol":    "tdd-perfection-gate v1.0.0",
}
with open(os.environ["MARKER"], "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
}

write_marker "db-probe"        "$DB_PROBE"
write_marker "audit-trail"     "$AUDIT_TRAIL"
write_marker "external-effect" "$EXTERNAL_EFFECT"

# 追加: uc-coverage + verdict も記録 (Stop hook 追加検証用)
COVERAGE_MARKER="${STATE_DIR}/tdd-verdict-recorded.turn"
DB="$UC_COVERAGE" TS="$TS" VERDICT="$VERDICT" MARKER="$COVERAGE_MARKER" \
  DBP="$DB_PROBE" AT="$AUDIT_TRAIL" EE="$EXTERNAL_EFFECT" \
  python3 - <<'PY'
import json, os
data = {
    "verified_at":     os.environ["TS"],
    "verdict":         os.environ["VERDICT"],
    "db_probe":        os.environ["DBP"],
    "audit_trail":     os.environ["AT"],
    "external_effect": os.environ["EE"],
    "uc_coverage":     os.environ["DB"],
    "protocol":        "tdd-perfection-gate v1.0.0",
}
with open(os.environ["MARKER"], "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

cat <<EOF
✅ Pre-Verdict Self-Audit recorded (tdd-perfection-gate v1.0.0)
   verdict:              $VERDICT
   marker (Q1 db-probe): $STATE_DIR/tdd-db-probe-verified.turn
   marker (Q2 audit):    $STATE_DIR/tdd-audit-trail-verified.turn
   marker (Q3 external): $STATE_DIR/tdd-external-effect-verified.turn
   marker (Q4+verdict):  $STATE_DIR/tdd-verdict-recorded.turn

   Q1 DB probe:          $DB_PROBE
   Q2 Audit trail:       $AUDIT_TRAIL
   Q3 External effect:   $EXTERNAL_EFFECT
   Q4 UC coverage:       $UC_COVERAGE

Stop hook のブロックが解除されました。応答内で "$VERDICT" を宣言可能です。
verdict 表現は rules/verdict-vocabulary.md の 4 tier いずれかを使用してください。
EOF
