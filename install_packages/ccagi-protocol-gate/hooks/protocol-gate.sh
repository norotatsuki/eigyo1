#!/usr/bin/env bash
# ccagi-protocol-gate — PreToolUse hook (v0.5.0)
# CLAUDE.md STEP 1-6 未完了時にツール使用を BLOCK する構造的ゲート
#
# ブロック対象 tool: matcher で外部指定 (Read|Edit|Write|Bash|Task|MultiEdit|NotebookEdit)
# 通過条件:
#   1. マーカーファイル .claude/state/protocol-ack.turn が存在する
#   2. マーカーが有効な JSON で step1〜step6 が非空
#   3. step6_mode が browser-test / tdd / off のいずれか
#   4. acked_at が現在時刻から 60 分以内
#
# 追加 (STEP 6): Playwright 遅延パス検出
#   Bash コマンドが `playwright test` / `npx playwright test` を呼ぶ場合、
#   下記 2 条件を **両方** 満たさないと BLOCK:
#     A) step6_mode == "browser-test"
#     B) コマンドに --headed が付与されている、
#        または env HEADFUL=1 / PWDEBUG=1 / PLAYWRIGHT_HEADLESS=0 が指定されている
#   これは request copy/20260723 の再発防止:
#     過去に request.post/get のみで rendered browser を一度も走らせず
#     「137 tests PASS」と虚偽報告した事故 (fact-first-execution.md 違反)。
#
# v0.5.0 追加:
#   step6_video_state == "on" の場合、playwright config で video 記録が有効になっている
#   ことを playwright.config.ts の 'video:' フィールドで簡易的に確認する。
#   step6_video_state == "off" の場合、動画記録の要求を課さない (ユーザー指示なし)。
#
# 特別許可 (Bash のみ):
#   - コマンドが `ccagi-protocol-ack.sh` を呼ぶ場合 -> 常に通過 (再宣言のため)
#   - コマンドが `ccagi-pre-verdict-audit.sh` を呼ぶ場合 -> 常に通過 (verdict marker 生成)
#   - コマンドが `ccagi-verify-uc-coverage.sh` を呼ぶ場合 -> 常に通過 (UC 網羅チェック)
set -euo pipefail

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
MARKER="${PROJECT_ROOT}/.claude/state/protocol-ack.turn"
MAX_AGE_MIN=60

INPUT="$(cat)"

TOOL_NAME="$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); print(d.get("tool_name",""))
except Exception:
  pass' 2>/dev/null || true)"

CMD=""
if [ "$TOOL_NAME" = "Bash" ]; then
  CMD="$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); print(d.get("tool_input",{}).get("command",""))
except Exception:
  pass' 2>/dev/null || true)"
  # 各種 ack/audit script 呼び出しは無条件許可 (bypass)
  # 誤検知回避: コメント内 keyword ではなく実コマンドとして含まれる場合のみ
  if printf '%s' "$CMD" | grep -qE '(^|[[:space:]&;|])bash[[:space:]]+[^#]*ccagi-protocol-ack\.sh'; then
    exit 0
  fi
  if printf '%s' "$CMD" | grep -qE '(^|[[:space:]&;|])bash[[:space:]]+[^#]*ccagi-pre-verdict-audit\.sh'; then
    exit 0
  fi
  if printf '%s' "$CMD" | grep -qE '(^|[[:space:]&;|])bash[[:space:]]+[^#]*ccagi-verify-uc-coverage\.sh'; then
    exit 0
  fi
fi

# --------------------------------------------------------------------------
# マーカー検査 (STEP 1-6 + 有効期限 + 経過時間)
# --------------------------------------------------------------------------
STEP6_MODE=""
STEP6_VIDEO_STATE=""
if [ -f "$MARKER" ]; then
  VALIDATION="$(python3 - "$MARKER" "$MAX_AGE_MIN" <<'PY' 2>/dev/null || echo "invalid||"
import json, sys
from datetime import datetime, timezone, timedelta
path, max_min = sys.argv[1], int(sys.argv[2])
try:
    with open(path) as f:
        d = json.load(f)
    for k in ("acked_at", "step1_mcp", "step2_declaration", "step3_mode",
              "step4_scope", "step5_claudemd", "step6_evidence", "step6_mode"):
        if not d.get(k):
            print("missing:"+k+"||"); sys.exit(0)
    mode = d.get("step6_mode", "")
    if mode not in ("browser-test", "tdd", "off"):
        print("bad-step6-mode:"+mode+"||"); sys.exit(0)
    ts = d["acked_at"].rstrip("Z")
    acked = datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) - acked > timedelta(minutes=max_min):
        print("expired||"); sys.exit(0)
    vstate = d.get("step6_video_state", "n/a")
    print("ok|"+mode+"|"+vstate)
except Exception as e:
    print("invalid:"+str(e)+"||")
PY
)"
  VALID="$(printf '%s' "$VALIDATION" | awk -F'|' '{print $1}')"
  STEP6_MODE="$(printf '%s' "$VALIDATION" | awk -F'|' '{print $2}')"
  STEP6_VIDEO_STATE="$(printf '%s' "$VALIDATION" | awk -F'|' '{print $3}')"
  if [ "$VALID" = "ok" ]; then
    :
  else
    REASON="$VALID"
    MARKER_OK=0
  fi
else
  REASON="marker-missing"
  MARKER_OK=0
fi

# --------------------------------------------------------------------------
# 追加ガード: Bash + playwright 遅延パス検出 (marker OK 時のみ実行)
# --------------------------------------------------------------------------
if [ "${MARKER_OK:-1}" = "1" ] && [ "$TOOL_NAME" = "Bash" ]; then
  CMD_STRIPPED="$(printf '%s' "$CMD" | python3 -c '
import re, sys
s = sys.stdin.read()
pattern = re.compile(
    r"<<-?\s*[\x27\x22]?([A-Za-z_][A-Za-z0-9_]*)[\x27\x22]?"
    r".*?^\1\s*$",
    re.DOTALL | re.MULTILINE
)
s = pattern.sub("<<HEREDOC_STRIPPED>>", s)
sys.stdout.write(s)
' 2>/dev/null || printf '%s' "$CMD")"
  if printf '%s' "$CMD_STRIPPED" \
    | grep -Ev -- '--(help|version)' \
    | grep -qE '(^|[[:space:]&;|])(npx[[:space:]]+(--yes[[:space:]]+)?|pnpm[[:space:]]+(exec[[:space:]]+)?|yarn[[:space:]]+)?playwright[[:space:]]+test\b'; then
    if [ "$STEP6_MODE" = "browser-test" ]; then
      if printf '%s' "$CMD" | grep -qE '(^|[[:space:]&;|])(--headed\b|HEADFUL=1\b|PWDEBUG=[^0[:space:]]|PLAYWRIGHT_HEADLESS=0\b)'; then
        # 可視ブラウザ signal あり -> video 状態のさらなる検証
        if [ "$STEP6_VIDEO_STATE" = "on" ]; then
          # playwright.config.ts / playwright.config.js を軽く検査:
          # 'video:' フィールドが 'off' 以外に設定されているか確認
          CONFIG_FOUND=0
          VIDEO_OK=0
          for f in playwright.config.ts playwright.config.js playwright.config.mjs; do
            if [ -f "${PROJECT_ROOT}/${f}" ]; then
              CONFIG_FOUND=1
              # video: 'on' / 'retain-on-failure' / 'on-first-retry' などを許可
              if grep -qE "video[[:space:]]*:[[:space:]]*['\"](on|retain-on-failure|on-first-retry)['\"]" "${PROJECT_ROOT}/${f}"; then
                VIDEO_OK=1
                break
              fi
            fi
          done
          if [ "$CONFIG_FOUND" = "1" ] && [ "$VIDEO_OK" = "0" ]; then
            cat >&2 <<EOF
🚫 CCAGI Protocol Gate — STEP 6 違反 (video capture 要求だが playwright.config で無効)

step6_video_state: on (ユーザー指示ありと解釈)
playwright.config 内 'video:' 設定が 'on' / 'retain-on-failure' / 'on-first-retry' の
いずれでもありません。

対処:
  1. playwright.config.ts の use ブロックで video: 'retain-on-failure' 等に設定する
  2. または STEP 6 を videos=off:<8文字以上の理由> で再宣言する
     (ユーザーから動画指示なしを明示する)

理由: 過去事故 request copy/20260723 で「動画があるはず」と虚偽報告した事案あり。
EOF
            exit 2
          fi
        fi
        exit 0
      fi
      cat >&2 <<EOF
🚫 CCAGI Protocol Gate — STEP 6 違反 (browser-test モードで可視ブラウザ signal なし)

検出したコマンド: playwright test
現在の step6_mode: ${STEP6_MODE}
現在の step6_video_state: ${STEP6_VIDEO_STATE}

過去の事故 (request copy/20260723): 「ブラウザ操作」指示を既存 Playwright spec の
HTTP-only 走行にすり替え、rendered browser を一度も走らせず「137 PASS」と虚偽報告した。

以下のいずれかを明示的にコマンドに含めてから再実行してください:
  --headed
  HEADFUL=1
  PWDEBUG=1
  PLAYWRIGHT_HEADLESS=0

また、以下の 3 点セットを満たす必要があります (fact-first-execution.md):
  E1. Execution   : foreground 実行
  E2. Observation : stdout/stderr を目視 (+ 動画キャプチャ保存 = ユーザー指示あり時のみ)
  E3. Exit code   : rc を数値で報告

video 出力先は STEP 6 の 'videos=<path>' で宣言済みのはずです。
動画不要の場合は 'videos=off:<8文字以上の理由>' で宣言してください。
EOF
      exit 2
    else
      cat >&2 <<EOF
🚫 CCAGI Protocol Gate — STEP 6 違反 (playwright test を非 browser-test モードで実行)

検出したコマンド: playwright test
現在の step6_mode: ${STEP6_MODE:-unknown}

ブラウザ操作テストを実施するには、STEP 6 を browser-test モードで再宣言する必要があります:

  bash scripts/ccagi-protocol-ack.sh \\
    --step1 "..." --step2 "..." --step3 "..." --step4 "..." --step5 "..." \\
    --step6 "browser-test:sequence=<name>|videos=<path-or-off:reason>|headed=true"

また、実コマンドには --headed / HEADFUL=1 のいずれかを付与し、rendered browser を走らせてください。
過去の事故 (request copy/20260723): page.request.* だけで済ませて虚偽報告した事案あり。
EOF
      exit 2
    fi
  fi
fi

# --------------------------------------------------------------------------
# marker OK かつ playwright 経路にも該当しなかった場合 -> 通過
# --------------------------------------------------------------------------
if [ "${MARKER_OK:-1}" = "1" ]; then
  exit 0
fi

# --------------------------------------------------------------------------
# BLOCK: STEP 1-6 未完了
# --------------------------------------------------------------------------
cat >&2 <<EOF
🚫 CCAGI Protocol Gate — BLOCKED (reason: ${REASON})

CLAUDE.md STEP 1-6 が未完了のため、tool 使用を拒否しました。
tool_name: ${TOOL_NAME}

以下を順に実行してください:

  STEP 1: MCP 接続確認
    → mcp__ccagi-tools__ccagi__get_status を呼び出す

  STEP 2: CC AGI 呼び出し宣言
    → ユーザーへ「CC AGI で作業を開始します」と明言する

  STEP 3: 実行方式の宣言
    → デフォルト: フォアグラウンド実行

  STEP 4: スコープ契約
    → CHANGE / NOT CHANGE / DIFF BUDGET を宣言する

  STEP 5: プロジェクト直下 CLAUDE.md の強制適用
    → 本ターンのタスクに適用するルールを 1 行で宣言する
      (ack script が CLAUDE.md 存在と SHA256 を自動記録)

  STEP 6: 成果物証跡ゲート (browser-test / tdd / off のいずれか)
    → browser-test:sequence=<name>|videos=<path-or-off:reason>|headed=true
    → tdd:root-cause=<x>|fix=<x>|unit-test=<x>|deploy=<x>|browser-verify=<video-or-off:reason>
    → off:<8文字以上の理由>

  ※ v0.5.0 変更: videos / browser-verify は既定 OFF。
     ユーザーから動画指示なしなら 'off:<8文字以上の理由>' で宣言してください。
     ユーザー指示ありの場合のみ実 path を渡します。

完了したら以下を実行し、ゲートを解除してください:

  bash scripts/ccagi-protocol-ack.sh \\
    --step1 "<MCP 検証結果>" \\
    --step2 "declared" \\
    --step3 "foreground" \\
    --step4 "<スコープ要約>" \\
    --step5 "<CLAUDE.md 適用ルール要約>" \\
    --step6 "<mode>:<detail>"

または slash command: /ccagi-ack を参照してください。

このゲートは次のユーザー入力で自動的にリセットされます (毎ターン再宣言必須)。
EOF
exit 2
