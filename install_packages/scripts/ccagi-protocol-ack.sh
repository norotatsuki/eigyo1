#!/usr/bin/env bash
# ccagi-protocol-ack — CLAUDE.md STEP 1-6 完了マーカーを生成
#
# Usage:
#   bash ccagi-protocol-ack.sh \
#     --step1 "<MCP 検証結果>" \
#     --step2 "<宣言内容>" \
#     --step3 "<実行方式>" \
#     --step4 "<スコープ要約>" \
#     --step5 "<CLAUDE.md 適用ルール要約>" \
#     --step6 "<成果物証跡モード:詳細>"
#
# 6 flag すべて必須。1 つでも欠けたら error。
# STEP 5 は自動で PROJECT_ROOT/CLAUDE.md の存在確認と SHA256 記録を行う。
# CLAUDE.md が存在しなければ error 終了する（構造的強制）。
#
# STEP 6 の値は次の 3 モードのどれかで開始する必要がある:
#   browser-test:sequence=<name>|videos=<glob-or-dir>|headed=true
#     → 「ブラウザ操作テストの実施」を宣言。証跡として動画キャプチャ必須。
#        page.request.* のみで済ませる HTTP-only spec は STEP 6 違反として block される。
#   tdd:root-cause=<x>|fix=<x>|unit-test=<x>|deploy=<x>|browser-verify=<video-glob>
#     → 「TDD ベースのバグ修正」を宣言。5 フェーズ (根本原因→改修→単体テスト→
#        デプロイ→ブラウザで根治確認) 全ての証跡パスを 1 行で列挙する。
#   off:<reason>
#     → 「ブラウザテスト/バグ修正のどちらでもない」ことを明示的に宣言。
#        設定編集やドキュメント作業などが該当。この場合でも
#        `npx playwright test` 系の lazy 呼び出しは gate で block される。
set -euo pipefail

STEP1=""; STEP2=""; STEP3=""; STEP4=""; STEP5=""; STEP6=""

usage() {
  cat <<'H'
Usage:
  ccagi-protocol-ack.sh --step1 <mcp-status> \
                        --step2 <declaration> \
                        --step3 <mode> \
                        --step4 <scope> \
                        --step5 <claudemd-application> \
                        --step6 <evidence-mode:detail>

Records CLAUDE.md STEP 1-6 completion for the current turn.
All six flags are required and must be non-empty.
STEP 5 additionally requires CLAUDE.md to exist at PROJECT_ROOT
(its SHA256 is auto-captured for traceability).

STEP 6 must begin with one of these three mode prefixes:
  browser-test:<detail>   (Gate A: visible browser + video evidence)
  tdd:<detail>            (Gate B: root-cause → fix → unit-test → deploy → browser-verify)
  off:<reason>            (Gate C: neither browser test nor bug fix)

Environment:
  CLAUDE_PROJECT_DIR   Project root (default: pwd)

Example:
  # Gate A — browser test
  ccagi-protocol-ack.sh \
    --step1 "ccagi-tools connected" \
    --step2 "declared" \
    --step3 "foreground" \
    --step4 "verify UC02-01 login flow" \
    --step5 "work-protocol §2.1 10%進捗 / fact-first-execution E1/E2/E3" \
    --step6 "browser-test:sequence=UC02-01|videos=.test-logs/videos/|headed=true"

  # Gate B — TDD bug fix
  ccagi-protocol-ack.sh \
    --step1 "ccagi-tools connected" \
    --step2 "declared" \
    --step3 "foreground" \
    --step4 "fix login OTP bug (~30 lines)" \
    --step5 "fact-first-execution / scope-contract §3 diff<=50" \
    --step6 "tdd:root-cause=.test-logs/repro.log|fix=src/auth/otp.ts|unit-test=src/auth/otp.test.ts|deploy=.deploy-logs/dev-2026-07-23.log|browser-verify=.test-logs/videos/otp-verify-*.webm"

  # Gate C — off
  ccagi-protocol-ack.sh \
    --step1 "ccagi-tools connected" \
    --step2 "declared" \
    --step3 "foreground" \
    --step4 "add rule doc (~40 lines, no src/ edits)" \
    --step5 "scope-contract §3 diff<=100" \
    --step6 "off:documentation-only edit, no browser interaction, no bug fix"
H
}

while [ $# -gt 0 ]; do
  case "$1" in
    --step1) STEP1="${2:-}"; shift 2 ;;
    --step2) STEP2="${2:-}"; shift 2 ;;
    --step3) STEP3="${2:-}"; shift 2 ;;
    --step4) STEP4="${2:-}"; shift 2 ;;
    --step5) STEP5="${2:-}"; shift 2 ;;
    --step6) STEP6="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "❌ Unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

MISSING=""
[ -z "$STEP1" ] && MISSING="$MISSING --step1"
[ -z "$STEP2" ] && MISSING="$MISSING --step2"
[ -z "$STEP3" ] && MISSING="$MISSING --step3"
[ -z "$STEP4" ] && MISSING="$MISSING --step4"
[ -z "$STEP5" ] && MISSING="$MISSING --step5"
[ -z "$STEP6" ] && MISSING="$MISSING --step6"

if [ -n "$MISSING" ]; then
  echo "❌ Missing required args:$MISSING" >&2
  echo "" >&2
  usage >&2
  exit 1
fi

# STEP 6: モード prefix を構造的に検証（browser-test / tdd / off のいずれかで開始）
STEP6_MODE=""
case "$STEP6" in
  browser-test:*) STEP6_MODE="browser-test" ;;
  tdd:*)          STEP6_MODE="tdd" ;;
  off:*)          STEP6_MODE="off" ;;
  *)
    echo "❌ STEP 6 違反: --step6 は 'browser-test:' / 'tdd:' / 'off:' のいずれかで開始してください" >&2
    echo "   受け取った値: $STEP6" >&2
    echo "" >&2
    usage >&2
    exit 4
    ;;
esac

# STEP 6 モード別のフィールド要件検証（早期に落として不完全宣言を防ぐ）
STEP6_DETAIL="${STEP6#*:}"
case "$STEP6_MODE" in
  browser-test)
    # sequence= / videos= の両方が必要（headed= は推奨だが必須ではない — hook 側で追加検証）
    if ! printf '%s' "$STEP6_DETAIL" | grep -q 'sequence='; then
      echo "❌ STEP 6 (browser-test) 違反: 'sequence=<name>' が必要です" >&2
      exit 5
    fi
    if ! printf '%s' "$STEP6_DETAIL" | grep -q 'videos='; then
      echo "❌ STEP 6 (browser-test) 違反: 'videos=<path-or-glob>' が必要です" >&2
      echo "   全キャプチャ動画の出力先ディレクトリ or glob を明示してください" >&2
      exit 5
    fi
    ;;
  tdd)
    # 5 フェーズ全てのキーが必要
    for key in root-cause fix unit-test deploy browser-verify; do
      if ! printf '%s' "$STEP6_DETAIL" | grep -q "${key}="; then
        echo "❌ STEP 6 (tdd) 違反: '${key}=<path-or-id>' が必要です" >&2
        echo "   完璧なTDD は root-cause / fix / unit-test / deploy / browser-verify 全証跡を要求します" >&2
        exit 5
      fi
    done
    ;;
  off)
    # 理由は自由記述だが 8 文字以上を要求（"n/a" 等の逃げを構造的に阻止）
    if [ "${#STEP6_DETAIL}" -lt 8 ]; then
      echo "❌ STEP 6 (off) 違反: 理由が短すぎます (>=8 chars)" >&2
      echo "   ブラウザテスト/バグ修正ではない具体的な理由を記述してください" >&2
      exit 5
    fi
    ;;
esac

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.claude/state"
MARKER="${STATE_DIR}/protocol-ack.turn"
CLAUDE_MD="${PROJECT_ROOT}/CLAUDE.md"

# STEP 5: CLAUDE.md の存在は構造的に必須
if [ ! -f "$CLAUDE_MD" ]; then
  echo "❌ STEP 5 違反: $CLAUDE_MD が存在しません" >&2
  echo "   プロジェクト直下 CLAUDE.md を配置してから再実行してください" >&2
  exit 3
fi

# CLAUDE.md SHA256 を自動記録（marker に含めてトレーサビリティ確保）
if command -v shasum >/dev/null 2>&1; then
  CLAUDE_MD_SHA="$(shasum -a 256 "$CLAUDE_MD" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  CLAUDE_MD_SHA="$(sha256sum "$CLAUDE_MD" | awk '{print $1}')"
else
  CLAUDE_MD_SHA="sha-tool-unavailable"
fi

mkdir -p "$STATE_DIR"

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Safe JSON write via Python (handles quoting)
S1="$STEP1" S2="$STEP2" S3="$STEP3" S4="$STEP4" S5="$STEP5" \
S6="$STEP6" S6_MODE="$STEP6_MODE" \
SHA="$CLAUDE_MD_SHA" TS="$TS" MARKER="$MARKER" \
python3 - <<'PY'
import json, os
data = {
    "acked_at":            os.environ["TS"],
    "step1_mcp":           os.environ["S1"],
    "step2_declaration":   os.environ["S2"],
    "step3_mode":          os.environ["S3"],
    "step4_scope":         os.environ["S4"],
    "step5_claudemd":      os.environ["S5"],
    "step5_claudemd_sha":  os.environ["SHA"],
    "step6_evidence":      os.environ["S6"],
    "step6_mode":          os.environ["S6_MODE"],
}
with open(os.environ["MARKER"], "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

cat <<EOF
✅ CCAGI Protocol Ack recorded
   marker:  $MARKER
   acked:   $TS
   STEP 1 (MCP):        $STEP1
   STEP 2 (Declare):    $STEP2
   STEP 3 (Mode):       $STEP3
   STEP 4 (Scope):      $STEP4
   STEP 5 (CLAUDE.md):  $STEP5
        sha256:         ${CLAUDE_MD_SHA:0:16}…
   STEP 6 (Evidence):   [${STEP6_MODE}] $STEP6
EOF

# -----------------------------------------------------------------------------
# 完璧TDD 態勢が活性なら、矢印 × 5 フェーズ の直積が要ることを毎回明示する。
#   STEP 6 の tdd: 宣言は「ターン全体で 1 セット」の粒度でしかない。
#   利用者正典の定義は「シーケンスの矢印 1 本 1 本 の動作確認を行い、
#   その 1 本ごとに 根本原因→改修→単体テスト→デプロイ→ブラウザ検証」。
# -----------------------------------------------------------------------------
if [ -f "${STATE_DIR}/perfect-tdd-mode.turn" ]; then
  cat <<'EOF'

⚠️  完璧テスト駆動 態勢が活性です — この STEP 6 宣言だけでは終了できません

   完璧なテスト駆動開発 = シーケンスの矢印 1 本 1 本 × 5 フェーズ
     1. バグの根本原因の確認
     2. バグ改修
     3. 単体テスト
     4. デプロイ
     5. ブラウザ操作でのテストでバグが根治していることの確認

   STEP 6 の宣言は「ターン全体で 1 セット」の粒度です。
   矢印の本数だけ 5 フェーズを回してください:

     bash scripts/ccagi-arrow-verify.sh <UC-name> <arrow-index> \
       --kind <A1-A6> \
       --root-cause "..." --fix "..." --unit-test "..." \
       --deploy "..." --browser-verify "<path or off:reason>"

     bash scripts/ccagi-arrow-verify.sh --summary
EOF
fi

cat <<EOF

このターンのツール使用が解禁されました。
次のユーザー入力で自動的にリセットされます。
EOF
