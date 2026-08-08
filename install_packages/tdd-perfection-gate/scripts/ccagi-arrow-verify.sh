#!/usr/bin/env bash
# ccagi-arrow-verify — シーケンス矢印 1 本ごとに verify marker を生成する CLI
#
# tdd-perfection-gate v1.5.0
#
# 「完璧なテスト駆動開発」トリガー時、UC 説明書内 mermaid の全 arrow を
# 1 本 1 本 実測 verify した証跡として marker を生成する。
#
# ══════════════════════════════════════════════════════════════════════════
# 完璧なテスト駆動開発 の 定義 (利用者 正典 / SoT)
# ══════════════════════════════════════════════════════════════════════════
#
#   シーケンスの矢印 1 本 1 本 の動作確認を行い、その 1 本ごとに
#     1. バグの根本原因の確認
#     2. バグ改修
#     3. 単体テスト
#     4. デプロイ
#     5. ブラウザ操作でのテストでバグが根治していることの確認
#   を行うこと。
#
#   すなわち 完璧TDD = 矢印 N 本 × 5 フェーズ = 5N 証跡 の 直積 である。
#   矢印だけ数えても、5 フェーズだけ揃えても「完璧」ではない。
#
# v1.5.0 追加 (直積の構造的強制):
#   モード A は --evidence 1 個では通らない。 5 フェーズすべての値を
#   要求し、1 つでも欠けたら exit 1。 モード B (--summary) は各 marker の
#   中身を読み、5 フェーズが揃っていない marker を「未 verify」と数える。
#   → touch で作った空 marker / 旧版が作った 1-evidence marker では
#     100% 網羅に到達できない。
#
# v1.2.0 追加 (narrow-scoping 対策):
#   本来対象の UC 群を「自作の小さな UC を作って --uc-dir で通す」ズルを
#   構造的に禁止する。 UC マニフェスト (`.claude/state/uc-manifest.json`)
#   に対象 UC 一覧 + SHA256 を凍結し、`--summary` はマニフェストに沿った
#   UC のみ対象化する。 マニフェスト外の md や、新規追加された md での
#   通過は BLOCK。
#
# 3 モード:
#
# ─── モード A: 個別 arrow verify (矢印 1 本 × 5 フェーズ) ───
#   bash ccagi-arrow-verify.sh <UC-name> <arrow-index> \
#     --kind <A1|A2|A3|A4|A5|A6> \
#     --root-cause     "<根本原因の実測ログ / Issue>" \
#     --fix            "<改修したファイル / commit>" \
#     --unit-test      "<単体テストのファイル / 結果>" \
#     --deploy         "<デプロイ ログ / 環境>" \
#     --browser-verify "<動画 path または off:<8 文字以上の理由>>" \
#     [--evidence "<補足の実測メモ (任意)>"]
#
# ─── モード B: 全 arrow verify 完了 summary ───
#   bash ccagi-arrow-verify.sh --summary
#     (UC マニフェスト必須。 マニフェストが指す UC のみ対象化)
#
#   マニフェスト無しで実行すると BLOCK される (narrow-scoping 対策)。
#   マニフェストを立てるには --establish-manifest を実行する。
#
# ─── モード C: UC マニフェスト確立 ───
#   bash ccagi-arrow-verify.sh --establish-manifest --uc-dir <path/to/uc/mds>
#
#   指定ディレクトリ配下の *.md を全走査し、SHA256 + arrow 数を凍結。
#   perfect-tdd-mode 活性中は再確立が拒否される (途中で subset に切替える
#   ズル対策)。 明示 override は CCAGI_UC_MANIFEST_REFRESH_ACK=1。
#
# arrow 分類 (--kind):
#   A1: Actor Input       (User → Page, click/type 等)
#   A2: Route/Controller  (Page → API, HTTP request)
#   A3: Service Logic     (API → Service, method call)
#   A4: DB Access         (Service → DB, query/mutation)
#   A5: External Call     (Service → ExternalAPI, mail/SMS/webhook)
#   A6: Response Rendering (Page → User, navigate/toast/DOM update)
#
# Exit codes:
#   0 = 成功
#   1 = 引数不足 / 5 フェーズ欠落 / 値が短すぎ / coverage < 100% / マニフェスト矛盾
#   2 = usage error
#   3 = --uc-dir が見つからない
#   4 = マニフェスト未確立 (--summary 実行時、narrow-scoping 対策)
#   5 = マニフェスト再確立拒否 (perfect-tdd-mode 活性中)
set -euo pipefail

MODE=""
UC=""
ARROW_INDEX=""
KIND=""
EVIDENCE=""
UC_DIR=""
ROOT_CAUSE=""
FIX=""
UNIT_TEST=""
DEPLOY=""
BROWSER_VERIFY=""
BROWSER_URL=""
TARGET_URL=""

usage() {
  cat <<'H'
完璧なテスト駆動開発 = 矢印 1 本 1 本 の動作確認 × 5 フェーズ
  1. バグの根本原因の確認  2. バグ改修  3. 単体テスト
  4. デプロイ              5. ブラウザ操作でバグが根治していることの確認

Usage:
  # モード A: 個別 arrow verify (矢印 1 本につき 5 フェーズ全部が必須)
  ccagi-arrow-verify.sh <UC-name> <arrow-index> \
      --kind <A1|A2|A3|A4|A5|A6> \
      --root-cause     "<根本原因の実測ログ / Issue (8+ chars)>" \
      --fix            "<改修ファイル / commit (8+ chars)>" \
      --unit-test      "<単体テストのファイル / 結果 (8+ chars)>" \
      --deploy         "<デプロイ ログ / 環境 (8+ chars)>" \
      --browser-verify "<動画 path または off:<8+ chars の理由>>" \
      [--evidence "<補足メモ (任意)>"]

  # モード B: summary (マニフェスト対象 UC 全数完遂チェック)
  ccagi-arrow-verify.sh --summary

  # モード C: UC マニフェスト確立 (narrow-scoping 対策)
  ccagi-arrow-verify.sh --establish-manifest --uc-dir <path/to/uc/mds>

  # モード D: 配備先の凍結 (指定のクラウドサーバーを 1 度だけ登録) [v1.6.0]
  ccagi-arrow-verify.sh --establish-deploy-target --url https://<cloud-host>

  # モード E: 未達の正直な報告 (「完璧」と呼ばずに終わる唯一の出口) [v1.6.0]
  ccagi-arrow-verify.sh --incomplete-report

完璧テスト駆動 態勢 活性中の追加要求 (v1.6.0):
  --deploy       凍結済みクラウド配備先のホストを含むこと (ローカルは拒否)
  --browser-verify  off: 不可。実在する成果物 (画面撮影/動画/操作記録) の path
  --browser-url  必須。凍結済み配備先を指すこと (ローカルは拒否)

arrow 分類 (--kind):
  A1: Actor Input        (User → Page, click/type)
  A2: Route/Controller   (Page → API, HTTP request)
  A3: Service Logic      (API → Service, method call)
  A4: DB Access          (Service → DB, query/mutation)
  A5: External Call      (Service → ExternalAPI, mail/SMS/webhook)
  A6: Response Rendering (Page → User, navigate/toast/DOM)

Environment:
  CLAUDE_PROJECT_DIR                   Project root (default: pwd)
  CCAGI_UC_MANIFEST_REFRESH_ACK=1      マニフェスト再確立を許可 (perfect-tdd-mode 活性中 override)
  CCAGI_UC_MANIFEST_BYPASS=1           マニフェスト未確立でも --summary を通す (非推奨、記録される)

Marker format (individual):
  .claude/state/tdd-arrow-<UC>-<index>-verified.turn
  (中身に phases.root_cause / fix / unit_test / deploy / browser_verify を保持。
   5 フェーズが揃っていない marker は --summary で「未 verify」と数えられる)

Marker format (summary):
  .claude/state/tdd-arrow-summary.turn

Manifest file:
  .claude/state/uc-manifest.json       (--establish-manifest で生成、凍結)
H
}

# --------------------------------------------------------------------------
# 引数 parse
# --------------------------------------------------------------------------
if [ $# -eq 0 ]; then
  usage >&2
  exit 2
fi

if [ "$1" = "--summary" ]; then
  MODE="summary"
  shift
elif [ "$1" = "--establish-manifest" ]; then
  MODE="establish"
  shift
elif [ "$1" = "--establish-deploy-target" ]; then
  MODE="deploy-target"
  shift
elif [ "$1" = "--incomplete-report" ]; then
  MODE="incomplete"
  shift
else
  MODE="single"
  UC="$1"
  if [ $# -lt 2 ]; then
    echo "❌ arrow-index が未指定です (usage: ccagi-arrow-verify.sh <UC-name> <arrow-index> --kind ... --root-cause ... --fix ... --unit-test ... --deploy ... --browser-verify ...)" >&2
    usage >&2
    exit 2
  fi
  ARROW_INDEX="$2"
  shift 2
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --kind)           KIND="${2:-}"; shift 2 ;;
    --evidence)       EVIDENCE="${2:-}"; shift 2 ;;
    --uc-dir)         UC_DIR="${2:-}"; shift 2 ;;
    --root-cause)     ROOT_CAUSE="${2:-}"; shift 2 ;;
    --fix)            FIX="${2:-}"; shift 2 ;;
    --unit-test)      UNIT_TEST="${2:-}"; shift 2 ;;
    --deploy)         DEPLOY="${2:-}"; shift 2 ;;
    --browser-verify) BROWSER_VERIFY="${2:-}"; shift 2 ;;
    --browser-url)    BROWSER_URL="${2:-}"; shift 2 ;;
    --url)            TARGET_URL="${2:-}"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "❌ 未知の引数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.claude/state"
MANIFEST_FILE="${STATE_DIR}/uc-manifest.json"
DEPLOY_TARGET_FILE="${STATE_DIR}/deploy-target.json"
PERFECT_FLAG="${STATE_DIR}/perfect-tdd-mode.turn"
mkdir -p "$STATE_DIR"

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 完璧テスト駆動 態勢が活性なら 厳格判定を有効化 (v1.6.0)
STRICT=0
if [ -f "$PERFECT_FLAG" ]; then
  STRICT=1
fi

# --------------------------------------------------------------------------
# v1.6.0 モード D: 配備先の凍結 (指定のクラウドサーバーを 1 度だけ登録)
# --------------------------------------------------------------------------
# 利用者要求: 「指定のクラウドサーバーにデプロイしてから、人の目にみえる
#              ブラウザ自動操作で 矢印 1 本 1 本 の動作確認を行う」
# → 配備先を先に凍結し、以降の --deploy / --browser-url がその宛先を
#   指していることを script が突き合わせる。 ローカル環境での確認を
#   「デプロイ済み」と言い換える逃げ道を塞ぐ。
if [ "$MODE" = "deploy-target" ]; then
  if [ -z "$TARGET_URL" ]; then
    echo "❌ --url が未指定です (例: --establish-deploy-target --url https://myapp-dev.example.com)" >&2
    exit 2
  fi
  VERDICT="$(TARGET_URL="$TARGET_URL" python3 - <<'PY'
import os, re, sys
from urllib.parse import urlparse
u = os.environ["TARGET_URL"].strip()
p = urlparse(u)
if p.scheme not in ("http", "https") or not p.hostname:
    print("bad-url|"); sys.exit(0)
h = p.hostname.lower()
local = (h in ("localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal")
         or h.endswith(".local") or h.endswith(".localhost")
         or re.match(r'^127\.', h) or re.match(r'^10\.', h)
         or re.match(r'^192\.168\.', h)
         or re.match(r'^172\.(1[6-9]|2[0-9]|3[01])\.', h))
if local:
    print("local-host|" + h); sys.exit(0)
print("ok|" + h)
PY
)"
  V_KIND="${VERDICT%%|*}"
  V_HOST="${VERDICT#*|}"
  case "$V_KIND" in
    bad-url)
      echo "❌ --url が http(s) の URL として解釈できません: '$TARGET_URL'" >&2
      exit 1 ;;
    local-host)
      cat >&2 <<EOF
❌ 配備先に ローカル環境 を登録できません: ${V_HOST}

「指定のクラウドサーバーにデプロイしてから確認する」という要求に対し、
手元の環境を配備先として登録すると 要求そのものが空洞化します。

実際に配備するクラウド上の宛先を指定してください:
  bash scripts/ccagi-arrow-verify.sh --establish-deploy-target \\
    --url https://<プロジェクト>-dev.<配備ドメイン>
EOF
      exit 1 ;;
  esac
  TARGET_URL="$TARGET_URL" HOST="$V_HOST" TS="$TS" OUT="$DEPLOY_TARGET_FILE" \
    python3 - <<'PY'
import json, os
with open(os.environ["OUT"], "w") as f:
    json.dump({
        "established_at": os.environ["TS"],
        "url":            os.environ["TARGET_URL"],
        "host":           os.environ["HOST"],
        "protocol":       "tdd-perfection-gate v1.6.0",
    }, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
  echo "✅ 配備先を凍結しました"
  echo "   ファイル: $DEPLOY_TARGET_FILE"
  echo "   URL:      $TARGET_URL"
  echo "   ホスト:   $V_HOST"
  echo ""
  echo "以降 各矢印の --deploy と --browser-url は このホストを指す必要があります。"
  exit 0
fi

# --------------------------------------------------------------------------
# v1.6.0 モード E: 未達の正直な報告 (降格させない唯一の出口)
# --------------------------------------------------------------------------
# 2026-07-29 事故は「予算に収まらない」と判断した所から始まった。
# そこで 収まらないときの 正しい出口 を用意する。 到達率をそのまま記録し、
# 「完璧」と呼ばずに終わることを許可する目印を作る。
# これが無いと、唯一の出口が「定義を切り下げて完璧と呼ぶ」になってしまう。
if [ "$MODE" = "incomplete" ]; then
  REPORT="$(STATE_DIR="$STATE_DIR" MANIFEST_FILE="$MANIFEST_FILE" \
            PERFECT_FLAG="$PERFECT_FLAG" TS="$TS" python3 - <<'PY'
import json, os, re
state = os.environ["STATE_DIR"]
frozen = 0
try:
    with open(os.environ["PERFECT_FLAG"]) as f:
        frozen = int(json.load(f).get("frozen_total_arrows", 0) or 0)
except Exception:
    pass
entries = []
try:
    with open(os.environ["MANIFEST_FILE"]) as f:
        m = json.load(f)
    entries = m.get("entries", [])
    if frozen == 0:
        frozen = int(m.get("total_arrows", 0) or 0)
except Exception:
    pass

REQUIRED = ("root_cause", "fix", "unit_test", "deploy", "browser_verify")
verified = 0
for e in entries:
    safe = re.sub(r'[^A-Za-z0-9._-]', '_', e["uc"])
    for i in range(1, int(e["arrow_count"]) + 1):
        p = os.path.join(state, "tdd-arrow-%s-%d-verified.turn" % (safe, i))
        try:
            with open(p) as f:
                d = json.load(f)
            ph = d.get("phases") or {}
            if all(str(ph.get(k, "")).strip() for k in REQUIRED):
                verified += 1
        except Exception:
            pass

pct = round(verified * 100.0 / frozen, 1) if frozen else 0.0
out = {
    "reported_at":       os.environ["TS"],
    "frozen_total_arrows": frozen,
    "verified_arrows":     verified,
    "unverified_arrows":   max(0, frozen - verified),
    "achieved_pct":        pct,
    "required_evidence":   frozen * 5,
    "actual_evidence":     verified * 5,
    "declaration_ban":   ["完璧", "PASS", "GREEN", "ゼロバグ"],
    "protocol":          "tdd-perfection-gate v1.6.0",
}
print(json.dumps(out, ensure_ascii=False))
PY
)"
  printf '%s\n' "$REPORT" | python3 -m json.tool --no-ensure-ascii \
    > "${STATE_DIR}/tdd-incomplete-report.turn"
  FROZEN_N="$(printf '%s' "$REPORT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["frozen_total_arrows"])')"
  DONE_N="$(printf '%s' "$REPORT"  | python3 -c 'import json,sys; print(json.load(sys.stdin)["verified_arrows"])')"
  PCT="$(printf '%s' "$REPORT"     | python3 -c 'import json,sys; print(json.load(sys.stdin)["achieved_pct"])')"
  cat <<EOF
📋 未達の報告を記録しました (降格ではなく、事実の記録)
   ファイル:   ${STATE_DIR}/tdd-incomplete-report.turn
   凍結母数:   矢印 ${FROZEN_N} 本
   5 フェーズ完遂: ${DONE_N} 本
   到達率:     ${PCT}%

この目印があれば 応答を終えることができます。ただし条件が 1 つあります:

  ⛔ 「完璧」「PASS」「GREEN」「ゼロバグ」と書いてはいけません。

利用者へは次の形でそのまま報告してください:
  「矢印 ${FROZEN_N} 本のうち ${DONE_N} 本 (${PCT}%) を 5 フェーズで確認しました。
    残り $((FROZEN_N - DONE_N)) 本は未確認です。完璧には達していません。」

定義を切り下げて「完璧」と呼び直すことは、この目印があっても許可されません。
EOF
  exit 0
fi

# --------------------------------------------------------------------------
# モード A: 個別 arrow verify (v1.1.0 と同一)
# --------------------------------------------------------------------------
if [ "$MODE" = "single" ]; then
  if [ -z "$UC" ]; then
    echo "❌ <UC-name> が空です" >&2
    exit 2
  fi
  case "$ARROW_INDEX" in
    ''|*[!0-9]*)
      echo "❌ arrow-index は正の整数である必要があります: '$ARROW_INDEX'" >&2
      exit 2
      ;;
  esac

  case "$KIND" in
    A1|A2|A3|A4|A5|A6) ;;
    "")
      echo "❌ --kind が未指定です (A1|A2|A3|A4|A5|A6)" >&2
      usage >&2
      exit 1
      ;;
    *)
      echo "❌ --kind が無効です: '$KIND' (許容: A1|A2|A3|A4|A5|A6)" >&2
      exit 1
      ;;
  esac

  # ------------------------------------------------------------------------
  # 5 フェーズ検証 (完璧TDD の定義: 矢印 1 本 × 5 フェーズ)
  # ------------------------------------------------------------------------
  MIN_LEN=8

  reject_escape() {
    # $1 = 値, $2 = flag 名
    case "$1" in
      *n/a*|*N/A*|*該当なし*|*なし*|*TODO*|*todo*|*未実施*|*後で*)
        echo "❌ --$2 に逃げ表現を検出しました: '$1'" >&2
        echo "   完璧TDD は矢印 1 本ごとに 5 フェーズ全部の実測を要求します。" >&2
        echo "   実施していないなら marker を作らず、まず実施してください。" >&2
        return 1
        ;;
    esac
    return 0
  }

  validate_phase() {
    # $1 = 値, $2 = flag 名, $3 = 日本語のフェーズ名
    local value="$1" flag="$2" label="$3"
    if [ -z "$value" ]; then
      cat >&2 <<EOF
❌ --${flag} が未指定です (フェーズ ${label})

完璧なテスト駆動開発 = 矢印 1 本 1 本 の動作確認 × 5 フェーズ
  1. バグの根本原因の確認                        --root-cause
  2. バグ改修                                    --fix
  3. 単体テスト                                  --unit-test
  4. デプロイ                                    --deploy
  5. ブラウザ操作でバグが根治していることの確認  --browser-verify

矢印 1 本につき 5 つ全部の証跡が必要です。1 つでも欠けたら marker は作られません。
EOF
      return 1
    fi
    reject_escape "$value" "$flag" || return 1
    if [ "${#value}" -lt "$MIN_LEN" ]; then
      echo "❌ --${flag} が短すぎます (${#value} chars, 最小 ${MIN_LEN}): '${value}'" >&2
      return 1
    fi
    return 0
  }

  validate_browser_verify() {
    # 動画は既定 OFF (protocol-gate v0.5.0 と同一規約)。
    # off:<8 文字以上の理由> か、動画 path のどちらか。
    local value="$1"
    if [ -z "$value" ]; then
      validate_phase "" browser-verify "ブラウザ操作でバグが根治していることの確認"
      return 1
    fi
    reject_escape "$value" browser-verify || return 1
    case "$value" in
      off:*)
        local reason="${value#off:}"
        if [ "${#reason}" -lt 8 ]; then
          echo "❌ --browser-verify=off:<理由> の理由が 8 文字未満です (${#reason} 文字)" >&2
          echo "   例: --browser-verify off:user-not-requested-video" >&2
          return 1
        fi
        ;;
      *)
        # path / glob 形式は自由 (相対・絶対・ワイルドカードいずれも許容)
        :
        ;;
    esac
    return 0
  }

  # ------------------------------------------------------------------------
  # v1.6.0 厳格判定 — 完璧テスト駆動 態勢が活性のときだけ課す
  # ------------------------------------------------------------------------
  # 利用者要求の 2 点を script で突き合わせる:
  #   ① 指定のクラウドサーバーに配備してから確認すること
  #   ② 人の目に見えるブラウザ自動操作で確認すること
  # 通常運用 (態勢 非活性) では従来どおりの緩い判定を維持し、
  # 平常時の処理能力を落とさない。
  FROZEN_HOST=""
  if [ "$STRICT" = "1" ] && [ -f "$DEPLOY_TARGET_FILE" ]; then
    FROZEN_HOST="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("host",""))' \
                    "$DEPLOY_TARGET_FILE" 2>/dev/null || echo "")"
  fi

  validate_cloud_deploy() {
    [ "$STRICT" = "1" ] || return 0
    if [ ! -f "$DEPLOY_TARGET_FILE" ]; then
      cat >&2 <<EOF
❌ 配備先が凍結されていません — 矢印の証跡を作れません

完璧テスト駆動では「指定のクラウドサーバーに配備してから確認する」ことが
要求されています。 どこへ配備したのかが未定義のままでは、
「デプロイ済み」と書いた文字列を誰も突き合わせられません。

先に 1 度だけ実行してください:
  bash scripts/ccagi-arrow-verify.sh --establish-deploy-target \\
    --url https://<配備先のクラウド URL>
EOF
      return 1
    fi
    case "$1" in
      *localhost*|*127.0.0.1*|*0.0.0.0*|*ローカル*|*local\ only*|*未デプロイ*|*未配備*)
        echo "❌ --deploy がローカル環境を指しています: '$1'" >&2
        echo "   指定のクラウドサーバー (${FROZEN_HOST}) への配備証跡が必要です。" >&2
        return 1 ;;
    esac
    if [ -n "$FROZEN_HOST" ]; then
      case "$1" in
        *"$FROZEN_HOST"*) : ;;
        *)
          cat >&2 <<EOF
❌ --deploy に凍結済み配備先が含まれていません

  凍結済み配備先: ${FROZEN_HOST}
  受け取った値:   $1

配備ログ / 配備先 URL に ${FROZEN_HOST} を含めてください。
例: --deploy ".deploy-logs/dev-2026-07-30.log (https://${FROZEN_HOST})"
EOF
          return 1 ;;
      esac
    fi
    return 0
  }

  validate_visible_browser() {
    [ "$STRICT" = "1" ] || return 0
    # ① off: は 態勢 活性中は使えない
    #    (通常モードでは「動画を撮らなかった」の意味で許容されるが、
    #     完璧テスト駆動では 可視ブラウザで操作した実物が要る)
    case "$1" in
      off:*)
        cat >&2 <<EOF
❌ --browser-verify に off: は使えません (完璧テスト駆動 態勢 活性中)

利用者要求は「人の目にみえるブラウザ自動操作で 矢印 1 本 1 本 の
動作確認を行う」ことです。 off: は「実際に見える形で操作した」ことを
何も証明しません。

実在する成果物 (画面撮影 / 動画 / 操作記録) の path を渡してください:
  --browser-verify ".test-logs/browser/UC02-01-arrow5.png" \\
  --browser-url    "https://${FROZEN_HOST:-<配備先>}/login"
EOF
        return 1 ;;
    esac
    # ② 実在するファイルであること (存在しない path を書く逃げ道を塞ぐ)
    local artifact="$1"
    case "$artifact" in
      /*) : ;;
      *)  artifact="${PROJECT_ROOT}/${artifact}" ;;
    esac
    if [ ! -e "$artifact" ]; then
      cat >&2 <<EOF
❌ --browser-verify が指す成果物が存在しません: $1
   解決した path: $artifact

可視ブラウザで実際に操作した結果として残った ファイルを指してください
(画面撮影 png / 動画 webm / 操作記録 zip 等)。
存在しない path を書いて通すことはできません。
EOF
      return 1
    fi
    # ③ 操作した URL が 凍結済みクラウド配備先であること
    if [ -z "$BROWSER_URL" ]; then
      cat >&2 <<EOF
❌ --browser-url が未指定です (完璧テスト駆動 態勢 活性中)

どの宛先を ブラウザで操作したのかを明示してください。
配備先に対して操作したことの確認が要求されています。
  --browser-url "https://${FROZEN_HOST:-<配備先>}/<経路>"
EOF
      return 1
    fi
    case "$BROWSER_URL" in
      *localhost*|*127.0.0.1*|*0.0.0.0*)
        echo "❌ --browser-url がローカル環境です: '$BROWSER_URL'" >&2
        echo "   配備先 (${FROZEN_HOST}) に対する操作確認が必要です。" >&2
        return 1 ;;
    esac
    if [ -n "$FROZEN_HOST" ]; then
      case "$BROWSER_URL" in
        *"$FROZEN_HOST"*) : ;;
        *)
          echo "❌ --browser-url が凍結済み配備先 (${FROZEN_HOST}) を指していません: '$BROWSER_URL'" >&2
          return 1 ;;
      esac
    fi
    return 0
  }

  validate_phase "$ROOT_CAUSE" root-cause "バグの根本原因の確認"                     || exit 1
  validate_phase "$FIX"        fix        "バグ改修"                                 || exit 1
  validate_phase "$UNIT_TEST"  unit-test  "単体テスト"                               || exit 1
  validate_phase "$DEPLOY"     deploy     "デプロイ"                                 || exit 1
  validate_cloud_deploy "$DEPLOY"                                                    || exit 1
  validate_browser_verify "$BROWSER_VERIFY"                                          || exit 1
  validate_visible_browser "$BROWSER_VERIFY"                                         || exit 1

  # --evidence は任意の補足。指定された場合のみ逃げ表現を弾く。
  if [ -n "$EVIDENCE" ]; then
    reject_escape "$EVIDENCE" evidence || exit 1
  fi

  SAFE_UC="$(printf '%s' "$UC" | tr -c 'A-Za-z0-9._-' '_')"
  MARKER="${STATE_DIR}/tdd-arrow-${SAFE_UC}-${ARROW_INDEX}-verified.turn"

  UC="$UC" IDX="$ARROW_INDEX" KIND="$KIND" EVIDENCE="$EVIDENCE" TS="$TS" MARKER="$MARKER" \
  P_ROOT_CAUSE="$ROOT_CAUSE" P_FIX="$FIX" P_UNIT_TEST="$UNIT_TEST" \
  P_DEPLOY="$DEPLOY" P_BROWSER_VERIFY="$BROWSER_VERIFY" \
  BROWSER_URL="$BROWSER_URL" FROZEN_HOST="$FROZEN_HOST" STRICT="$STRICT" \
    python3 - <<'PY'
import json, os
data = {
    "verified_at": os.environ["TS"],
    "uc":          os.environ["UC"],
    "arrow_index": int(os.environ["IDX"]),
    "kind":        os.environ["KIND"],
    "phases": {
        "root_cause":     os.environ["P_ROOT_CAUSE"],
        "fix":            os.environ["P_FIX"],
        "unit_test":      os.environ["P_UNIT_TEST"],
        "deploy":         os.environ["P_DEPLOY"],
        "browser_verify": os.environ["P_BROWSER_VERIFY"],
    },
    "browser_url":  os.environ.get("BROWSER_URL", ""),
    "deploy_host":  os.environ.get("FROZEN_HOST", ""),
    "strict_mode":  os.environ.get("STRICT") == "1",
    "evidence":    os.environ["EVIDENCE"],
    "protocol":    "tdd-perfection-gate v1.6.0",
}
with open(os.environ["MARKER"], "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

  echo "✅ arrow verified: ${UC} #${ARROW_INDEX} [${KIND}] — 5 フェーズ完遂"
  echo "   marker:          ${MARKER}"
  echo "   1 根本原因:      ${ROOT_CAUSE}"
  echo "   2 改修:          ${FIX}"
  echo "   3 単体テスト:    ${UNIT_TEST}"
  echo "   4 デプロイ:      ${DEPLOY}"
  echo "   5 ブラウザ検証:  ${BROWSER_VERIFY}"
  if [ -n "$EVIDENCE" ]; then
    echo "   補足:            ${EVIDENCE}"
  fi
  exit 0
fi

# --------------------------------------------------------------------------
# モード C: UC マニフェスト確立 (narrow-scoping 対策の核)
# --------------------------------------------------------------------------
if [ "$MODE" = "establish" ]; then
  if [ -z "$UC_DIR" ]; then
    echo "❌ --uc-dir が未指定です (例: --uc-dir docs/use_case)" >&2
    exit 2
  fi
  case "$UC_DIR" in
    /*) ABS_UC_DIR="$UC_DIR" ;;
    *)  ABS_UC_DIR="${PROJECT_ROOT}/${UC_DIR}" ;;
  esac
  if [ ! -d "$ABS_UC_DIR" ]; then
    echo "❌ UC ディレクトリが見つかりません: $ABS_UC_DIR" >&2
    exit 3
  fi

  # perfect-tdd-mode 活性中の再確立を拒否 (途中で subset にすり替える対策)
  if [ -f "${STATE_DIR}/perfect-tdd-mode.turn" ] && [ -f "$MANIFEST_FILE" ]; then
    if [ "${CCAGI_UC_MANIFEST_REFRESH_ACK:-0}" != "1" ]; then
      cat >&2 <<EOF
🚫 UC マニフェスト再確立を拒否しました
   理由: perfect-tdd-mode 活性中に、既存マニフェスト (${MANIFEST_FILE}) の
         再確立を試行しました。 これは narrow-scoping (途中で対象 UC を
         狭める) ズルの典型的な手口として構造的にブロックされます。

   もし正当な理由がある場合 (例: 新しい UC が本当に追加された):
     1. 「完璧TDDモード解除」と発話して mode を明示 off する
     2. 別ターンで再確立する
     3. または env: CCAGI_UC_MANIFEST_REFRESH_ACK=1 を設定して再実行
        (ただしユーザーに再確立の理由を明示すること)

   出典: 2026-07-26 narrow-scoping 事故 (108 UC 対象を 9-arrow 自作 UC に
         すり替えて --summary 100% 通過)
EOF
      exit 5
    fi
    echo "⚠️  perfect-tdd-mode 活性中の再確立を CCAGI_UC_MANIFEST_REFRESH_ACK=1 で override しました" >&2
  fi

  MANIFEST_JSON="$(TS="$TS" DIR="$ABS_UC_DIR" python3 - <<'PY'
import hashlib, json, os, re, sys
uc_dir = os.environ["DIR"]
ts     = os.environ["TS"]

entries = []
total_arrows = 0
for root, _, files in os.walk(uc_dir):
    for fn in sorted(files):
        if not fn.endswith('.md'):
            continue
        uc_name = fn[:-3]
        path = os.path.join(root, fn)
        rel_path = os.path.relpath(path, uc_dir)
        try:
            with open(path, encoding='utf-8', errors='replace') as f:
                content = f.read()
        except Exception:
            continue

        blocks = re.findall(r"```mermaid\n(.*?)\n```", content, re.DOTALL)
        arrow_count = 0
        for block in blocks:
            if 'sequenceDiagram' not in block:
                continue
            for line in block.split('\n'):
                s = line.strip()
                if not s or s.startswith('%%'):
                    continue
                if re.search(r'-{1,2}[>x]{1,2}', s):
                    arrow_count += 1

        if arrow_count == 0:
            continue

        sha = hashlib.sha256(content.encode('utf-8')).hexdigest()
        entries.append({
            "uc":          uc_name,
            "rel_path":    rel_path,
            "arrow_count": arrow_count,
            "sha256":      sha,
        })
        total_arrows += arrow_count

manifest = {
    "established_at":  ts,
    "uc_dir":          uc_dir,
    "total_uc_count":  len(entries),
    "total_arrows":    total_arrows,
    "entries":         entries,
    "protocol":        "tdd-perfection-gate v1.2.0",
}
print(json.dumps(manifest, ensure_ascii=False, indent=2))
PY
  )"

  ENTRIES_COUNT="$(printf '%s' "$MANIFEST_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total_uc_count"])')"
  TOTAL_ARROWS="$(printf '%s' "$MANIFEST_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total_arrows"])')"

  if [ "$ENTRIES_COUNT" = "0" ]; then
    echo "❌ UC ディレクトリ内に mermaid sequenceDiagram arrow を持つ md が 1 件もありません: $ABS_UC_DIR" >&2
    exit 3
  fi

  printf '%s\n' "$MANIFEST_JSON" > "$MANIFEST_FILE"
  echo "✅ UC マニフェスト確立完了"
  echo "   ファイル:      $MANIFEST_FILE"
  echo "   UC 説明書数:   ${ENTRIES_COUNT}"
  echo "   総矢印数:      ${TOTAL_ARROWS}"
  echo "   uc-dir:        $UC_DIR"
  echo ""
  echo "以降 --summary はこのマニフェストに沿った UC のみ対象化されます。"
  echo "マニフェスト外の UC 追加 / 削除は BLOCK されます (narrow-scoping 対策)。"
  exit 0
fi

# --------------------------------------------------------------------------
# モード B: summary (マニフェスト強制)
# --------------------------------------------------------------------------
if [ "$MODE" = "summary" ]; then

  # マニフェスト無しでの通過を拒否 (narrow-scoping 対策の核)
  if [ ! -f "$MANIFEST_FILE" ]; then
    if [ "${CCAGI_UC_MANIFEST_BYPASS:-0}" != "1" ]; then
      cat >&2 <<EOF
🚫 使用場面 一覧凍結が未確立です — 要約表示を拒否

対象の使用場面書を自由に選べる状態で要約を通すと、自作の小さな使用場面書
だけを対象化して 100% 網羅と主張する「対象狭めズル」を許してしまうため、
構造的に阻止しています。

対処 (先に一度だけ実行):
  bash scripts/ccagi-arrow-verify.sh --establish-manifest \\
    --uc-dir <本来の 使用場面書 フォルダ>

例:
  bash scripts/ccagi-arrow-verify.sh --establish-manifest --uc-dir docs/use_case

その後、要約は自動的に凍結済み使用場面書のみを対象化します。

緊急の迂回 (推奨されません、記録が残ります):
  CCAGI_UC_MANIFEST_BYPASS=1 bash scripts/ccagi-arrow-verify.sh --summary

出典: 2026-07-26 対象狭め事故 (108 使用場面書対象を、自作の 9 矢印 だけの
      使用場面書にすり替えて 100% 通過)
EOF
      exit 4
    fi
    echo "⚠️  マニフェスト未確立を CCAGI_UC_MANIFEST_BYPASS=1 で override しました (記録)" >&2
    # bypass 経路: --uc-dir が必要
    if [ -z "$UC_DIR" ]; then
      echo "❌ bypass 経路では --uc-dir が必要です" >&2
      exit 2
    fi
  fi

  # マニフェスト読取 + マニフェスト外 UC 検出
  SUMMARY_JSON="$(MANIFEST_FILE="$MANIFEST_FILE" STATE_DIR="$STATE_DIR" \
    PROJECT_ROOT="$PROJECT_ROOT" UC_DIR_OVERRIDE="${UC_DIR:-}" \
    BYPASS="${CCAGI_UC_MANIFEST_BYPASS:-0}" python3 - <<'PY'
import hashlib, json, os, re, sys

manifest_file = os.environ["MANIFEST_FILE"]
state_dir     = os.environ["STATE_DIR"]
project_root  = os.environ["PROJECT_ROOT"]
uc_dir_override = os.environ.get("UC_DIR_OVERRIDE", "")
bypass = os.environ.get("BYPASS", "0") == "1"

# bypass 経路
if bypass and not os.path.exists(manifest_file):
    uc_dir = uc_dir_override
    if not os.path.isabs(uc_dir):
        uc_dir = os.path.join(project_root, uc_dir)
    entries = []
    for root, _, files in os.walk(uc_dir):
        for fn in sorted(files):
            if not fn.endswith('.md'):
                continue
            uc_name = fn[:-3]
            path = os.path.join(root, fn)
            try:
                with open(path, encoding='utf-8', errors='replace') as f:
                    content = f.read()
            except Exception:
                continue
            blocks = re.findall(r"```mermaid\n(.*?)\n```", content, re.DOTALL)
            arrow_count = 0
            for block in blocks:
                if 'sequenceDiagram' not in block:
                    continue
                for line in block.split('\n'):
                    s = line.strip()
                    if not s or s.startswith('%%'):
                        continue
                    if re.search(r'-{1,2}[>x]{1,2}', s):
                        arrow_count += 1
            if arrow_count == 0:
                continue
            sha = hashlib.sha256(content.encode('utf-8')).hexdigest()
            entries.append({"uc": uc_name, "arrow_count": arrow_count, "sha256": sha, "rel_path": os.path.relpath(path, uc_dir)})
    manifest = {"uc_dir": uc_dir, "entries": entries, "total_uc_count": len(entries),
                "total_arrows": sum(e["arrow_count"] for e in entries)}
else:
    with open(manifest_file) as f:
        manifest = json.load(f)

uc_dir = manifest["uc_dir"]
entries = manifest["entries"]

# マニフェスト外 UC 検出 (narrow-scoping 対策の追加防御層)
extraneous = []
if os.path.isdir(uc_dir):
    manifest_paths = set(e["rel_path"] for e in entries)
    for root, _, files in os.walk(uc_dir):
        for fn in sorted(files):
            if not fn.endswith('.md'):
                continue
            path = os.path.join(root, fn)
            rel = os.path.relpath(path, uc_dir)
            if rel in manifest_paths:
                continue
            try:
                with open(path, encoding='utf-8', errors='replace') as f:
                    content = f.read()
            except Exception:
                continue
            blocks = re.findall(r"```mermaid\n(.*?)\n```", content, re.DOTALL)
            has_arrow = False
            for block in blocks:
                if 'sequenceDiagram' not in block:
                    continue
                for line in block.split('\n'):
                    if re.search(r'-{1,2}[>x]{1,2}', line.strip()):
                        has_arrow = True
                        break
                if has_arrow:
                    break
            if has_arrow:
                extraneous.append(rel)

# 完璧TDD の定義 = 矢印 1 本 × 5 フェーズ。
# marker が「存在するだけ」では verify 済みと数えない。
REQUIRED_PHASES = ("root_cause", "fix", "unit_test", "deploy", "browser_verify")


def inspect_marker(path):
    """marker を読み、5 フェーズが揃っているか判定する。

    戻り値: (ok: bool, missing_phases: list[str])
      - ファイル不在      -> (False, ["<marker 不在>"])
      - JSON でない/空    -> (False, ["<marker 破損>"])   (touch で作った空ファイル等)
      - phases 欠落       -> (False, [欠けている phase 名...])
    """
    if not os.path.exists(path):
        return False, ["<marker 不在>"]
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        return False, ["<marker 破損 (5 フェーズ形式ではない)>"]
    if not isinstance(data, dict):
        return False, ["<marker 破損 (5 フェーズ形式ではない)>"]
    phases = data.get("phases")
    if not isinstance(phases, dict):
        return False, ["<phases 欠落 (旧版 marker の可能性)>"]
    missing = [p for p in REQUIRED_PHASES
               if not str(phases.get(p, "")).strip()]
    return (len(missing) == 0), missing


# マニフェスト内 UC の verify marker を数える
results = []
total_arrows = 0
total_verified = 0
missing_arrows = []
phase_incomplete = []
for e in entries:
    uc_name = e["uc"]
    arrow_count = e["arrow_count"]
    safe_uc = re.sub(r'[^A-Za-z0-9._-]', '_', uc_name)
    verified_indices = set()
    for i in range(1, arrow_count + 1):
        marker = os.path.join(state_dir, f"tdd-arrow-{safe_uc}-{i}-verified.turn")
        ok, missing_phases = inspect_marker(marker)
        if ok:
            verified_indices.add(i)
        elif missing_phases != ["<marker 不在>"]:
            # marker はあるが 5 フェーズが揃っていない = 中途半端な証跡
            phase_incomplete.append({
                "arrow":          f"{uc_name}#{i}",
                "missing_phases": missing_phases,
            })
    missing_indices = sorted(set(range(1, arrow_count + 1)) - verified_indices)
    results.append({
        "uc":              uc_name,
        "arrow_count":     arrow_count,
        "verified_count":  len(verified_indices),
        "missing_indices": missing_indices,
    })
    total_arrows += arrow_count
    total_verified += len(verified_indices)
    for i in missing_indices:
        missing_arrows.append(f"{uc_name}#{i}")

summary = {
    "definition":        "完璧TDD = 矢印 1 本 1 本 × 5 フェーズ (根本原因/改修/単体テスト/デプロイ/ブラウザ検証)",
    "total_arrows":      total_arrows,
    "total_verified":    total_verified,
    "required_phases":   list(REQUIRED_PHASES),
    "total_obligations": total_arrows * len(REQUIRED_PHASES),
    "coverage_pct":      int(total_verified * 100 / total_arrows) if total_arrows > 0 else 0,
    "manifest_uc_count": len(entries),
    "per_uc":            results,
    "missing":           missing_arrows,
    "phase_incomplete":  phase_incomplete,
    "extraneous_uc":     extraneous,
}
print(json.dumps(summary, ensure_ascii=False))
PY
  )"

  TOTAL="$(printf '%s' "$SUMMARY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total_arrows"])')"
  VERIFIED="$(printf '%s' "$SUMMARY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total_verified"])')"
  COVERAGE="$(printf '%s' "$SUMMARY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["coverage_pct"])')"
  UC_COUNT="$(printf '%s' "$SUMMARY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["manifest_uc_count"])')"
  EXTRA_COUNT="$(printf '%s' "$SUMMARY_JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["extraneous_uc"]))')"
  MISSING_LIST="$(printf '%s' "$SUMMARY_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join("  - "+m for m in d["missing"][:50]))')"
  EXTRA_MISSING="$(printf '%s' "$SUMMARY_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(max(0, len(d["missing"])-50))')"

  PHASE_BAD_COUNT="$(printf '%s' "$SUMMARY_JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["phase_incomplete"]))')"
  OBLIGATIONS="$(printf '%s' "$SUMMARY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total_obligations"])')"

  echo "▸ arrow verify summary (マニフェスト対象)"
  echo "  定義:              完璧TDD = 矢印 1 本 1 本 × 5 フェーズ"
  echo "  対象 UC 説明書数:  $UC_COUNT"
  echo "  総矢印数:          $TOTAL"
  echo "  必要証跡数:        $OBLIGATIONS  (= 矢印 ${TOTAL} × 5 フェーズ)"
  echo "  5 フェーズ完遂:    $VERIFIED"
  echo "  網羅率:            ${COVERAGE}%"
  echo "  フェーズ不足 矢印: $PHASE_BAD_COUNT 件"
  echo "  マニフェスト外 UC: $EXTRA_COUNT 件"

  if [ "$TOTAL" = "0" ]; then
    echo "❌ マニフェスト内に mermaid arrow が 0 本です。マニフェストを再確立してください。" >&2
    exit 1
  fi

  # ------------------------------------------------------------------------
  # v1.6.0: 凍結した母数との突き合わせ (定義の切り下げ検出)
  # ------------------------------------------------------------------------
  # 態勢 起動時に script が凍結した矢印総数と、いま数えた総数が食い違ったら
  # 母数そのものが動かされている。 2026-07-29 事故の「完璧の領域を切り下げ」を
  # 一覧の入れ替えとして検出する層。
  if [ -f "$PERFECT_FLAG" ]; then
    FROZEN_TOTAL="$(python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1])).get("frozen_total_arrows",0) or 0))' \
                     "$PERFECT_FLAG" 2>/dev/null || echo 0)"
    if [ "$FROZEN_TOTAL" -gt 0 ] && [ "$FROZEN_TOTAL" != "$TOTAL" ]; then
      cat >&2 <<EOF

🚫 凍結した母数と現在の総矢印数が一致しません — 要約を拒否

  態勢 起動時に凍結した矢印総数: ${FROZEN_TOTAL}
  いま数えた矢印総数:             ${TOTAL}

「完璧」の母数は 態勢 起動の時点で確定しています。 途中で母数が変わるのは
対象を入れ替えた場合だけです。 実行予算に収まらないことを理由に母数を
小さくすることはできません。

正しい対処は次の 2 つだけです:

  A) 母数 ${FROZEN_TOTAL} 本ぶんを最後までやり切る

  B) 到達率をそのまま報告して終える (「完璧」とは呼べません)
       bash scripts/ccagi-arrow-verify.sh --incomplete-report

出典: 2026-07-29 「完璧を下げる」事故
      正典定義を保持したまま、実行予算に収まらないと判断した瞬間に
      勝手に領域を切り下げ、切り下げ後を「完璧」と呼び直した。
EOF
      exit 1
    fi
  fi

  # マニフェスト外 UC が存在する場合 BLOCK
  # (Claude が「9-arrow の自作 UC」を追加したケースを検出)
  if [ "$EXTRA_COUNT" -gt 0 ]; then
    EXTRA_LIST="$(printf '%s' "$SUMMARY_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join("  - "+e for e in d["extraneous_uc"][:30]))')"
    cat >&2 <<EOF

🚫 マニフェスト外 UC 説明書を検出しました — --summary を拒否

以下の md はマニフェスト確立後に追加されたもので、対象範囲を勝手に
変更するズル (narrow-scoping) の疑いがあります:

$EXTRA_LIST

対処:
  A) これらが本当に正当な追加なら、マニフェストを再確立してください:
       (perfect-tdd-mode 解除後)
       bash scripts/ccagi-arrow-verify.sh --establish-manifest --uc-dir <path>
     または env override:
       CCAGI_UC_MANIFEST_REFRESH_ACK=1 で明示

  B) これらが本来不要な自作 md なら、削除してから再実行してください。

出典: 2026-07-26 narrow-scoping 事故 (自作 9-arrow UC で 100% 主張)
EOF
    exit 1
  fi

  # 5 フェーズが揃っていない marker を明示 (touch / 旧版 marker の検出)
  if [ "$PHASE_BAD_COUNT" -gt 0 ]; then
    PHASE_BAD_LIST="$(printf '%s' "$SUMMARY_JSON" | python3 -c '
import json,sys
d = json.load(sys.stdin)
for x in d["phase_incomplete"][:30]:
    print("  - " + x["arrow"] + "  欠落: " + ", ".join(x["missing_phases"]))
')"
    echo ""
    echo "⚠️  5 フェーズが揃っていない矢印 marker を検出しました:"
    echo "$PHASE_BAD_LIST"
    echo ""
    echo "   完璧TDD は矢印 1 本につき 5 フェーズ全部を要求します。"
    echo "   これらの矢印は「未 verify」として数えられます。"
  fi

  if [ "$COVERAGE" -lt 100 ]; then
    echo ""
    echo "❌ 網羅率 < 100% — 全 arrow の 5 フェーズ verify が完了していません。"
    echo "   不足 arrow (最大 50 件表示):"
    echo "$MISSING_LIST"
    if [ "$EXTRA_MISSING" -gt 0 ]; then
      echo "  ... 他 $EXTRA_MISSING 件"
    fi
    echo ""
    echo "対処: 不足 arrow を 1 本ずつ 5 フェーズ揃えて verify してください:"
    cat <<'HINT'
   bash scripts/ccagi-arrow-verify.sh <UC-name> <arrow-index> \
     --kind <A1-A6> \
     --root-cause     "<根本原因の実測ログ>" \
     --fix            "<改修ファイル>" \
     --unit-test      "<単体テスト>" \
     --deploy         "<デプロイ ログ>" \
     --browser-verify "<動画 path または off:<理由>>"
HINT
    exit 1
  fi

  SUMMARY_MARKER="${STATE_DIR}/tdd-arrow-summary.turn"
  SUMMARY="$SUMMARY_JSON" TS="$TS" MARKER="$SUMMARY_MARKER" \
    python3 - <<'PY'
import json, os
summary = json.loads(os.environ["SUMMARY"])
summary["verified_at"] = os.environ["TS"]
summary["protocol"] = "tdd-perfection-gate v1.5.0"
with open(os.environ["MARKER"], "w") as f:
    json.dump(summary, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

  echo ""
  echo "✅ 全 arrow の 5 フェーズ verify 完了 (${VERIFIED}/${TOTAL} 矢印 = ${COVERAGE}%)"
  echo "   実証跡数:                     ${OBLIGATIONS} (矢印 ${TOTAL} × 5 フェーズ)"
  echo "   マニフェスト対象 UC 説明書数: ${UC_COUNT}"
  echo "   summary marker: $SUMMARY_MARKER"
  exit 0
fi

echo "❌ Internal error: unknown mode '$MODE'" >&2
exit 2
