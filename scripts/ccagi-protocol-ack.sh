#!/usr/bin/env bash
# ccagi-protocol-ack — CLAUDE.md STEP 1-6 完了マーカーを生成
#
# v0.7.0 変更点 (STEP 7: 日本語出力調整ゲート):
#   1. 利用者が日本語話者だと判定できる場合、本 script が「日本語出力の調整指針」を
#      出力し、marker に step7_ja_output / step7_ja_signals を記録する。
#   2. 判定材料 (いずれか 1 つでも該当すれば ON):
#        - STEP 1-6 の宣言文に ひらがな / カタカナ が含まれる
#        - CLAUDE.md の日本語文字比率が 5% 以上
#        - 環境の言語設定 (LC_ALL / LC_MESSAGES / LANG) が ja で始まる
#        - macOS の地域設定 (AppleLocale) が ja で始まる
#   3. --ja-output on|off|auto (既定 auto) / 環境変数 CCAGI_JA_OUTPUT で上書き可。
#   4. **このゲートは阻止しない (非 BLOCK)**。
#      応答終了時に禁止語で終了拒否する方式は、書き直しの繰り返しで
#      処理能力を落とすことが実測されたため採用しない (2026-07-27 判断)。
#      ack 時点で 1 度だけ指針を提示し、判断そのものは文脈込みで Claude に委ねる。
#
# v0.5.0 変更点:
#   1. videos=off:<8文字以上の理由> を明示的に許容 (キャプチャ動画の既定 OFF)
#      -> 「ユーザーから動画指示なし」を宣言できる。指示があれば videos=<path> を宣言する。
#   2. tdd モードの browser-verify=off:<理由> も同様に許容
#   3. PASS 宣言前 3 マーカー enforcement (--db-probe / --audit-trail / --external-effect)
#      は別 CLI (ccagi-pre-verdict-audit.sh, tdd-perfection-gate パッケージ) が担当
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
# CLAUDE.md が存在しなければ error 終了する (構造的強制)。
#
# STEP 6 の値は次の 3 モードのどれかで開始する必要がある:
#   browser-test:sequence=<name>|videos=<glob-or-dir>|headed=true
#     -> 「ブラウザ操作テストの実施」を宣言。ユーザー指示ありの場合、動画キャプチャ必須。
#        page.request.* のみで済ませる HTTP-only 手法は STEP 6 違反として block される。
#     -> ユーザー指示なしの場合: videos=off:<8文字以上の理由> で宣言する。
#   browser-test:sequence=<name>|videos=off:user-not-requested|headed=true (video 既定 OFF 例)
#
#   tdd:root-cause=<x>|fix=<x>|unit-test=<x>|deploy=<x>|browser-verify=<video-glob>
#     -> 「TDD ベースのバグ修正」を宣言。5 フェーズ (根本原因→改修→単体テスト→
#        デプロイ→ブラウザで根治確認) 全ての証跡パスを 1 行で列挙する。
#     -> ユーザーから動画指示なしの場合: browser-verify=off:<8文字以上の理由> で宣言する。
#
#   off:<8文字以上の理由>
#     -> 「ブラウザテスト/バグ修正のどちらでもない」ことを明示的に宣言。
#        設定編集やドキュメント作業などが該当。この場合でも
#        `npx playwright test` 系の遅延呼び出しは gate で block される。
set -euo pipefail

STEP1=""; STEP2=""; STEP3=""; STEP4=""; STEP5=""; STEP6=""
JA_OUTPUT_FLAG=""

usage() {
  cat <<'H'
Usage:
  ccagi-protocol-ack.sh --step1 <mcp-status> \
                        --step2 <declaration> \
                        --step3 <mode> \
                        --step4 <scope> \
                        --step5 <claudemd-application> \
                        --step6 <evidence-mode:detail> \
                        [--ja-output auto|on|off]

Records CLAUDE.md STEP 1-6 completion for the current turn.
All six flags are required and must be non-empty.
STEP 5 additionally requires CLAUDE.md to exist at PROJECT_ROOT
(its SHA256 is auto-captured for traceability).

STEP 6 must begin with one of these three mode prefixes:
  browser-test:<detail>   (Gate A: visible browser + video evidence)
  tdd:<detail>            (Gate B: root-cause -> fix -> unit-test -> deploy -> browser-verify)
  off:<reason>            (Gate C: neither browser test nor bug fix)

v0.5.0: videos and browser-verify fields accept "off:<8+char-reason>" to explicitly
declare that the user did NOT request video capture (video default OFF policy).
When the user requests video capture, provide a real path/glob instead.

STEP 7 (v0.7.0) — Japanese output adjustment gate (advisory, never blocks):
  When the user is detected as a Japanese speaker, this script prints an output
  policy telling Claude to avoid unnecessary alphabet/katakana notation and to
  prefer plain Japanese, while keeping proper nouns, file paths, commands and
  code identifiers untouched. Detection signals are recorded in the marker as
  step7_ja_output / step7_ja_signals.
  --ja-output auto (default) | on (force) | off (disable)

Environment:
  CLAUDE_PROJECT_DIR   Project root (default: pwd)
  CCAGI_JA_OUTPUT      auto|on|off — overrides auto detection (flag wins over env)

Example:
  # Gate A — browser test (video ON, user requested)
  ccagi-protocol-ack.sh \
    --step1 "ccagi-tools connected" \
    --step2 "declared" \
    --step3 "foreground" \
    --step4 "verify UC02-01 login flow" \
    --step5 "work-protocol §2.1 10%進捗 / fact-first-execution E1/E2/E3" \
    --step6 "browser-test:sequence=UC02-01|videos=.test-logs/videos/|headed=true"

  # Gate A — browser test (video OFF, user did not request)
  ccagi-protocol-ack.sh \
    --step1 "ccagi-tools connected" \
    --step2 "declared" \
    --step3 "foreground" \
    --step4 "verify UC02-01 login flow" \
    --step5 "work-protocol §2.1 10%進捗 / fact-first-execution E1/E2/E3" \
    --step6 "browser-test:sequence=UC02-01|videos=off:user-not-requested-video|headed=true"

  # Gate B — TDD bug fix (browser-verify video OFF)
  ccagi-protocol-ack.sh \
    --step1 "ccagi-tools connected" \
    --step2 "declared" \
    --step3 "foreground" \
    --step4 "fix login OTP bug (~30 lines)" \
    --step5 "fact-first-execution / scope-contract §3 diff<=50" \
    --step6 "tdd:root-cause=.test-logs/repro.log|fix=src/auth/otp.ts|unit-test=src/auth/otp.test.ts|deploy=.deploy-logs/dev-2026-07-24.log|browser-verify=off:user-not-requested-video"

  # Gate C — off (documentation)
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
    --ja-output) JA_OUTPUT_FLAG="${2:-}"; shift 2 ;;
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

# STEP 7 (v0.7.0): 日本語出力調整ゲートの動作指定を確定 (flag > 環境変数 > auto)
JA_OUTPUT_SETTING="${JA_OUTPUT_FLAG:-${CCAGI_JA_OUTPUT:-auto}}"
case "$JA_OUTPUT_SETTING" in
  auto|on|off) : ;;
  *)
    echo "❌ --ja-output の値が不正です: $JA_OUTPUT_SETTING (auto / on / off のいずれか)" >&2
    exit 6
    ;;
esac

# STEP 6: モード prefix を構造的に検証 (browser-test / tdd / off のいずれかで開始)
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

# -----------------------------------------------------------------------------
# v0.5.0 追加: field 値抽出 helper (bash 内で `key=` の値を pipe 区切りで抽出)
# -----------------------------------------------------------------------------
extract_field() {
  # $1 = detail 文字列 (pipe 区切り)  $2 = key 名
  # 出力: key= の値 (最初の一致のみ)。無ければ空文字。
  printf '%s' "$1" | tr '|' '\n' | awk -F= -v k="$2" '$1==k { sub(/^[^=]+=/, ""); print; exit }'
}

# -----------------------------------------------------------------------------
# v0.5.0 追加: video field 検証 (videos=<path> または videos=off:<8文字以上の理由>)
# -----------------------------------------------------------------------------
validate_video_field() {
  # $1 = field 値, $2 = field 名 (エラー表示用)
  local value="$1"
  local field="$2"
  if [ -z "$value" ]; then
    echo "❌ STEP 6 違反: '${field}=' の値が空です" >&2
    return 5
  fi
  case "$value" in
    off:*)
      local reason="${value#off:}"
      if [ ${#reason} -lt 8 ]; then
        echo "❌ STEP 6 違反: '${field}=off:<reason>' の理由が 8 文字未満です (${#reason} 文字)" >&2
        echo "   例: ${field}=off:user-not-requested-video" >&2
        return 5
      fi
      ;;
    "")
      echo "❌ STEP 6 違反: '${field}=' の値が空です" >&2
      return 5
      ;;
    *)
      # path 形式は自由。glob / 相対 path / 絶対 path いずれも許容。
      :
      ;;
  esac
  return 0
}

STEP6_DETAIL="${STEP6#*:}"
case "$STEP6_MODE" in
  browser-test)
    # sequence= は必須 (v0.4.0 と同じ)
    if ! printf '%s' "$STEP6_DETAIL" | grep -q 'sequence='; then
      echo "❌ STEP 6 (browser-test) 違反: 'sequence=<name>' が必要です" >&2
      exit 5
    fi
    if ! printf '%s' "$STEP6_DETAIL" | grep -q 'videos='; then
      echo "❌ STEP 6 (browser-test) 違反: 'videos=<path-or-off:reason>' が必要です" >&2
      echo "   ユーザーから動画指示なしの場合: videos=off:user-not-requested-video" >&2
      echo "   ユーザーから動画指示ありの場合: videos=<録画出力先ディレクトリ>" >&2
      exit 5
    fi
    # v0.5.0: videos= の値を検証 (path OR off:<8+char>)
    VIDEO_VALUE="$(extract_field "$STEP6_DETAIL" videos)"
    validate_video_field "$VIDEO_VALUE" videos || exit 5
    ;;
  tdd)
    # 5 フェーズ全てのキーが必要
    for key in root-cause fix unit-test deploy browser-verify; do
      if ! printf '%s' "$STEP6_DETAIL" | grep -q "${key}="; then
        echo "❌ STEP 6 (tdd) 違反: '${key}=<path-or-id>' が必要です" >&2
        echo "   完璧な TDD は root-cause / fix / unit-test / deploy / browser-verify 全証跡を要求します" >&2
        exit 5
      fi
    done
    # v0.5.0: browser-verify= の値を video field と同じ規則で検証
    BV_VALUE="$(extract_field "$STEP6_DETAIL" browser-verify)"
    validate_video_field "$BV_VALUE" browser-verify || exit 5

    # ----------------------------------------------------------------------
    # v0.8.0: 完璧テスト駆動 態勢 活性中の追加検証
    # ----------------------------------------------------------------------
    # 利用者要求「指定のクラウドサーバーに配備してから、人の目にみえる
    # ブラウザ自動操作で確認する」を ターン宣言の段階でも突き合わせる。
    # 態勢 非活性 (通常運用) では従来どおり緩い判定のまま。
    ACK_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
    if [ -f "${ACK_ROOT}/.claude/state/perfect-tdd-mode.turn" ]; then
      ACK_TARGET_FILE="${ACK_ROOT}/.claude/state/deploy-target.json"
      if [ ! -f "$ACK_TARGET_FILE" ]; then
        cat >&2 <<'EOF'
❌ STEP 6 (tdd) 違反: 配備先が凍結されていません (完璧テスト駆動 態勢 活性中)

「指定のクラウドサーバーに配備してから確認する」ことが要求されています。
先に 1 度だけ配備先を登録してください:

  bash scripts/ccagi-arrow-verify.sh --establish-deploy-target \
    --url https://<配備先のクラウド URL>
EOF
        exit 5
      fi
      ACK_HOST="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("host",""))' \
                   "$ACK_TARGET_FILE" 2>/dev/null || echo "")"
      DEPLOY_VALUE="$(extract_field "$STEP6_DETAIL" deploy)"
      case "$DEPLOY_VALUE" in
        *localhost*|*127.0.0.1*|*0.0.0.0*|*ローカル*|*未デプロイ*|*未配備*)
          echo "❌ STEP 6 (tdd) 違反: deploy= がローカル環境を指しています: '$DEPLOY_VALUE'" >&2
          echo "   凍結済みクラウド配備先 (${ACK_HOST}) への配備証跡が必要です。" >&2
          exit 5 ;;
      esac
      if [ -n "$ACK_HOST" ]; then
        case "$DEPLOY_VALUE" in
          *"$ACK_HOST"*) : ;;
          *)
            echo "❌ STEP 6 (tdd) 違反: deploy= に凍結済み配備先 '${ACK_HOST}' が含まれていません" >&2
            echo "   受け取った値: '$DEPLOY_VALUE'" >&2
            exit 5 ;;
        esac
      fi
      case "$BV_VALUE" in
        off:*)
          cat >&2 <<EOF
❌ STEP 6 (tdd) 違反: browser-verify=off: は使えません (完璧テスト駆動 態勢 活性中)

「人の目にみえるブラウザ自動操作で確認する」ことが要求されています。
off: は 可視ブラウザで操作した事実を何も示しません。

可視ブラウザで実際に操作して残った成果物を指定してください:
  --step6 "tdd:root-cause=...|fix=...|unit-test=...|deploy=<配備ログ (${ACK_HOST})>|browser-verify=<成果物 path>"
EOF
          exit 5 ;;
      esac
    fi
    ;;
  off)
    # 理由は自由記述だが 8 文字以上を要求 ("n/a" 等の逃げを構造的に阻止)
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

# CLAUDE.md SHA256 を自動記録 (marker に含めてトレーサビリティ確保)
if command -v shasum >/dev/null 2>&1; then
  CLAUDE_MD_SHA="$(shasum -a 256 "$CLAUDE_MD" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  CLAUDE_MD_SHA="$(sha256sum "$CLAUDE_MD" | awk '{print $1}')"
else
  CLAUDE_MD_SHA="sha-tool-unavailable"
fi

mkdir -p "$STATE_DIR"

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# -----------------------------------------------------------------------------
# STEP 7 (v0.7.0): 日本語出力調整ゲート — 利用者が日本語話者かを事実材料から判定
#   判定は「推測」ではなく観測可能な材料のみを使う (fact-first-execution 準拠)。
#   1 つでも該当すれば ON。materials が皆無なら OFF (無理に適用しない)。
# -----------------------------------------------------------------------------
JA_SIGNALS=""
if [ "$JA_OUTPUT_SETTING" = "off" ]; then
  JA_OUTPUT_STATE="off"
  JA_SIGNALS="利用者指定により無効化 (--ja-output off)"
else
  JA_DETECT_RAW="$(
    ARGS_TEXT="$STEP1 $STEP2 $STEP3 $STEP4 $STEP5 $STEP6" \
    CLAUDE_MD_PATH="$CLAUDE_MD" \
    LOCALE_HINT="${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" \
    python3 - <<'PY'
import os, re

KANA = re.compile(r'[぀-ゟ゠-ヿ]')
HAN  = re.compile(r'[一-鿿]')

signals = []

args = os.environ.get("ARGS_TEXT", "")
if KANA.search(args):
    signals.append("宣言文に かな を検出")

loc = os.environ.get("LOCALE_HINT", "")
if loc.lower().startswith("ja"):
    signals.append("環境の言語設定=" + loc)

path = os.environ.get("CLAUDE_MD_PATH", "")
try:
    with open(path, encoding="utf-8", errors="ignore") as fh:
        text = fh.read(200000)
    if text:
        jp = len(KANA.findall(text)) + len(HAN.findall(text))
        ratio = jp / len(text)
        if ratio >= 0.05:
            signals.append("CLAUDE.md の日本語比率=%.1f%%" % (ratio * 100))
except OSError:
    pass

print(" / ".join(signals))
PY
  )" || JA_DETECT_RAW=""

  # 材料が無い場合のみ macOS の地域設定を追加確認 (余計な subprocess を避ける)
  if [ -z "$JA_DETECT_RAW" ] && [ "$(uname -s)" = "Darwin" ] && command -v defaults >/dev/null 2>&1; then
    APPLE_LOCALE="$(defaults read -g AppleLocale 2>/dev/null || true)"
    case "$APPLE_LOCALE" in
      ja*) JA_DETECT_RAW="macOS の地域設定=$APPLE_LOCALE" ;;
    esac
  fi

  if [ "$JA_OUTPUT_SETTING" = "on" ]; then
    JA_OUTPUT_STATE="on"
    JA_SIGNALS="${JA_DETECT_RAW:-利用者指定により強制有効化 (--ja-output on)}"
  elif [ -n "$JA_DETECT_RAW" ]; then
    JA_OUTPUT_STATE="on"
    JA_SIGNALS="$JA_DETECT_RAW"
  else
    JA_OUTPUT_STATE="off"
    JA_SIGNALS="判定材料なし (日本語話者と断定できず)"
  fi
fi

# v0.5.0 追加: video 状態 (on/off) を marker に記録し、下流 hook が参照可能に
VIDEO_STATE="n/a"
if [ "$STEP6_MODE" = "browser-test" ]; then
  case "${VIDEO_VALUE:-}" in
    off:*) VIDEO_STATE="off" ;;
    "")    VIDEO_STATE="n/a" ;;
    *)     VIDEO_STATE="on" ;;
  esac
elif [ "$STEP6_MODE" = "tdd" ]; then
  case "${BV_VALUE:-}" in
    off:*) VIDEO_STATE="off" ;;
    "")    VIDEO_STATE="n/a" ;;
    *)     VIDEO_STATE="on" ;;
  esac
fi

# Safe JSON write via Python (handles quoting)
S1="$STEP1" S2="$STEP2" S3="$STEP3" S4="$STEP4" S5="$STEP5" \
S6="$STEP6" S6_MODE="$STEP6_MODE" VS="$VIDEO_STATE" \
JA_STATE="$JA_OUTPUT_STATE" JA_SIG="$JA_SIGNALS" JA_SET="$JA_OUTPUT_SETTING" \
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
    "step6_video_state":   os.environ["VS"],
    "step7_ja_output":     os.environ["JA_STATE"],
    "step7_ja_setting":    os.environ["JA_SET"],
    "step7_ja_signals":    os.environ["JA_SIG"],
    "protocol_version":    "0.7.0",
}
with open(os.environ["MARKER"], "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

# v0.5.0 追加: video 状態を人間可読形式で最終出力に含める
case "$VIDEO_STATE" in
  on)  VIDEO_MSG="録画あり (ユーザー指示ありと解釈)" ;;
  off) VIDEO_MSG="録画なし (ユーザー指示なしの明示宣言)" ;;
  *)   VIDEO_MSG="対象外" ;;
esac

case "$JA_OUTPUT_STATE" in
  on)  JA_MSG="適用 (${JA_SIGNALS})" ;;
  *)   JA_MSG="対象外 (${JA_SIGNALS})" ;;
esac

cat <<EOF
✅ CCAGI Protocol Ack recorded (v0.7.0)
   marker:  $MARKER
   acked:   $TS
   STEP 1 (MCP):        $STEP1
   STEP 2 (Declare):    $STEP2
   STEP 3 (Mode):       $STEP3
   STEP 4 (Scope):      $STEP4
   STEP 5 (CLAUDE.md):  $STEP5
        sha256:         ${CLAUDE_MD_SHA:0:16}…
   STEP 6 (Evidence):   [${STEP6_MODE}] $STEP6
   Video capture:       ${VIDEO_MSG}
   STEP 7 (日本語出力): ${JA_MSG}
EOF

# -----------------------------------------------------------------------------
# 完璧TDD 態勢が活性なら、矢印 × 5 フェーズ の直積が要ることを毎回明示する。
#
#   STEP 6 の tdd: 宣言は「ターン全体で 1 セット」の粒度でしかない。
#   利用者正典の定義は「シーケンスの矢印 1 本 1 本 の動作確認を行い、
#   その 1 本ごとに 根本原因→改修→単体テスト→デプロイ→ブラウザ検証」であり、
#   矢印の本数だけ 5 フェーズを回す必要がある。
#   ここで黙っていると「ターン宣言で足りた」と誤解する事故が起きるため、
#   ack のたびに残り本数を実測して提示する。
# -----------------------------------------------------------------------------
PERFECT_TDD_FLAG="${PROJECT_ROOT}/.claude/state/perfect-tdd-mode.turn"
if [ -f "$PERFECT_TDD_FLAG" ]; then
  ARROW_PROGRESS=""
  if command -v python3 >/dev/null 2>&1; then
    ARROW_PROGRESS="$(STATE_DIR="${PROJECT_ROOT}/.claude/state" python3 - <<'PY' 2>/dev/null || true
import json, os, re

state_dir = os.environ["STATE_DIR"]
manifest  = os.path.join(state_dir, "uc-manifest.json")
REQUIRED  = ("root_cause", "fix", "unit_test", "deploy", "browser_verify")

if not os.path.exists(manifest):
    print("   進捗:            使用場面一覧が未凍結 (--establish-manifest から開始)")
    raise SystemExit(0)

with open(manifest) as f:
    m = json.load(f)

total = done = 0
for e in m.get("entries", []):
    safe = re.sub(r'[^A-Za-z0-9._-]', '_', e["uc"])
    for i in range(1, e["arrow_count"] + 1):
        total += 1
        p = os.path.join(state_dir, f"tdd-arrow-{safe}-{i}-verified.turn")
        try:
            with open(p) as f:
                ph = json.load(f).get("phases") or {}
            if all(str(ph.get(k, "")).strip() for k in REQUIRED):
                done += 1
        except Exception:
            pass

pct = int(done * 100 / total) if total else 0
print(f"   進捗:            {done}/{total} 矢印 完遂 ({pct}%) / 必要証跡 {total * 5} 個")
PY
)"
  fi

  cat <<EOF

⚠️  完璧テスト駆動 態勢が活性です — この STEP 6 宣言だけでは終了できません

   完璧なテスト駆動開発 = シーケンスの矢印 1 本 1 本 × 5 フェーズ
     1. バグの根本原因の確認
     2. バグ改修
     3. 単体テスト
     4. デプロイ
     5. ブラウザ操作でのテストでバグが根治していることの確認

   STEP 6 の宣言は「ターン全体で 1 セット」の粒度です。
   矢印の本数だけ 5 フェーズを回してください:
${ARROW_PROGRESS}

     bash scripts/ccagi-arrow-verify.sh <UC-name> <arrow-index> \\
       --kind <A1-A6> \\
       --root-cause "..." --fix "..." --unit-test "..." \\
       --deploy "..." --browser-verify "<path or off:reason>"

     bash scripts/ccagi-arrow-verify.sh --summary
EOF
fi

# -----------------------------------------------------------------------------
# STEP 7 の指針本文 (ON のときのみ出力)
#   プロジェクト側で .claude/lib/ja-output-policy.md を置けば、その内容で差し替える。
# -----------------------------------------------------------------------------
if [ "$JA_OUTPUT_STATE" = "on" ]; then
  JA_POLICY_FILE="${PROJECT_ROOT}/.claude/lib/ja-output-policy.md"
  echo ""
  if [ -f "$JA_POLICY_FILE" ]; then
    echo "── STEP 7 日本語出力の調整指針 (プロジェクト定義: .claude/lib/ja-output-policy.md) ──"
    cat "$JA_POLICY_FILE"
  else
    cat <<'JAPOLICY'
── STEP 7 日本語出力の調整指針 (本ターンの応答文に適用) ──
利用者は日本語話者です。本ターンの応答は、必要以上の英字・カタカナ表記を抑え、
一般的な日本人が読んで意味の取れる日本語で書いてください。

【言い換える】同じ意味の和語・漢語がある英字/カタカナ
  アサイン→割り当て   オンボーディング→受け入れ手順   イテレーション→反復
  バリデーション→入力検証   スケーラビリティ→拡張性   ステータス→状態
  リファクタリング→整理・作り直し   デプロイ→配備   マージ→統合
  ハンドリング→処理   コンフリクト→競合   トレードオフ→利害得失

【そのまま残す】言い換えると かえって伝わらないもの
  - 固有名詞: TypeScript / Playwright / GitHub / Claude / AWS など
  - ファイル名・パス・コマンド・コード上の識別子 (原文のまま)
  - 定着した外来語: テスト / バグ / ファイル / データ / エラー / メール / ページ
  - 略号が実体を指す技術語: JSON / API / URL / HTTP / SQL / MCP / DAG

【文脈を最大限に考慮するときの優先順位】
  1. 正確さが最優先。言い換えで意味がぼやけるなら英字のまま残す
  2. 相手が読む場面を考える。手順書・報告文は日本語寄り、
     コマンド例やログ引用はそのまま
  3. 判断が拮抗したら日本語側に寄せる
  4. 初出の専門語は「英字 (日本語の説明)」の形で 1 度だけ補う

【重要 — 処理能力を落とさないための制約】
  この指針は阻止しません。書き上げた応答を何度も書き直すことは禁止です。
  推敲は送信前の 1 回まで。表現の粗さより、作業を前に進めることを優先します。
JAPOLICY
  fi
fi

cat <<EOF

このターンのツール使用が解禁されました。
次のユーザー入力で自動的にリセットされます。
EOF
