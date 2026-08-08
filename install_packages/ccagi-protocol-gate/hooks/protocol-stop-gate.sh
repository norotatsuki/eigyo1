#!/usr/bin/env bash
# ccagi-protocol-stop-gate — Stop hook (v0.5.0)
# Claude がターンを終える瞬間に発火。
# CLAUDE.md STEP 1-6 の ack マーカーが「本ターン中に」更新されていない場合、
# 終了を拒否して STEP 1-6 の宣言を強制する。
#
# PreToolUse フックの弱点 (テキスト応答時に一度もフックが走らない) を補完する。
#
# 通過条件:
#   1. マーカー .claude/state/protocol-ack.turn が存在する
#   2. マーカーが有効な JSON で step1〜step6 が非空
#   3. step6_mode が browser-test / tdd / off のいずれか
#   4. acked_at が現在時刻から 60 分以内
#
# v0.5.0 追加 (PASS 宣言前 3 mandatory):
#   step6_mode が tdd または browser-test の場合、応答文中の PASS/完璧/GREEN/verdict
#   キーワード検出時に以下 3 marker の存在を要求:
#     .claude/state/tdd-db-probe-verified.turn
#     .claude/state/tdd-audit-trail-verified.turn
#     .claude/state/tdd-external-effect-verified.turn
#   marker は ccagi-pre-verdict-audit.sh (tdd-perfection-gate パッケージ) が生成する。
#   失敗レポート §4.3 (2026-07-24) 対応。
#
# ブロック時: exit 2 で Claude Code に「終了不可・追加応答必要」を伝達
set -euo pipefail

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
MARKER="${PROJECT_ROOT}/.claude/state/protocol-ack.turn"
STATE_DIR="${PROJECT_ROOT}/.claude/state"
MAX_AGE_MIN=60

INPUT="$(cat 2>/dev/null || true)"
TRANSCRIPT="$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); print(d.get("transcript_path",""))
except Exception:
  pass' 2>/dev/null || true)"

# 過剰ブロック防止用の一時カウンタ (同一ターン内で 2 回発火した場合は通す)
COUNTER_FILE="${STATE_DIR}/stop-gate.count"
mkdir -p "$STATE_DIR" 2>/dev/null || true

# v0.8.0: 完璧テスト駆動 態勢が活性のときは 回数による無条件通過を封じる。
#   従来は 3 回目の発火で必ず exit 0 していたため、STEP 1-6 の門も
#   PASS 宣言前 3 点セットの門も、2 回粘れば無条件で抜けられた。
#   これは「証跡が無いまま完璧と宣言する」経路として常時開いていた。
#   通常運用では 無限ループ防止のため 従来の脱出を維持する。
PERFECT_ACTIVE=0
if [ -f "${STATE_DIR}/perfect-tdd-mode.turn" ] || [ -f "${STATE_DIR}/perfect-tdd-word-ban.turn" ]; then
  PERFECT_ACTIVE=1
fi

if [ -f "$COUNTER_FILE" ]; then
  COUNT="$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)"
  if [ "$COUNT" -ge 2 ] && [ "$PERFECT_ACTIVE" = "0" ]; then
    rm -f "$COUNTER_FILE"
    exit 0
  fi
  echo $((COUNT + 1)) > "$COUNTER_FILE"
else
  echo 1 > "$COUNTER_FILE"
fi

# --------------------------------------------------------------------------
# STEP 1-6 マーカー検査
# --------------------------------------------------------------------------
STEP6_MODE=""
if [ -f "$MARKER" ]; then
  VALIDATION="$(python3 - "$MARKER" "$MAX_AGE_MIN" <<'PY' 2>/dev/null || echo "invalid|"
import json, sys
from datetime import datetime, timezone, timedelta
path, max_min = sys.argv[1], int(sys.argv[2])
try:
    with open(path) as f:
        d = json.load(f)
    for k in ("acked_at", "step1_mcp", "step2_declaration", "step3_mode",
              "step4_scope", "step5_claudemd", "step6_evidence", "step6_mode"):
        if not d.get(k):
            print("missing:"+k+"|"); sys.exit(0)
    mode = d.get("step6_mode","")
    if mode not in ("browser-test", "tdd", "off"):
        print("bad-step6-mode:"+mode+"|"); sys.exit(0)
    ts = d["acked_at"].rstrip("Z")
    acked = datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) - acked > timedelta(minutes=max_min):
        print("expired|"); sys.exit(0)
    print("ok|"+mode)
except Exception as e:
    print("invalid:"+str(e)+"|")
PY
)"
  VALID="${VALIDATION%%|*}"
  STEP6_MODE="${VALIDATION#*|}"
  if [ "$VALID" != "ok" ]; then
    REASON="$VALID"
    MARKER_OK=0
  fi
else
  REASON="marker-missing"
  MARKER_OK=0
fi

# --------------------------------------------------------------------------
# marker NG -> STEP 1-6 未完了 BLOCK
# --------------------------------------------------------------------------
if [ "${MARKER_OK:-1}" != "1" ]; then
  cat >&2 <<EOF
🚫 CCAGI Protocol Stop Gate — 終了拒否 (reason: ${REASON})

このターンで CLAUDE.md STEP 1-6 が宣言されていません。
テキストのみの応答も含め、全ての応答は STEP 1-6 を通過している必要があります。

今すぐ以下を実行してください:

  1. mcp__ccagi-tools__ccagi__get_status を呼ぶ (STEP 1)
  2. ユーザーへ「CC AGI で作業を開始します」と明言する (STEP 2)
  3. 実行モード (foreground) を宣言する (STEP 3)
  4. スコープ (CHANGE / NOT CHANGE / DIFF BUDGET) を宣言する (STEP 4)
  5. プロジェクト直下 CLAUDE.md の適用ルールを 1 行で宣言する (STEP 5)
  6. 成果物証跡 (browser-test / tdd / off) を宣言する (STEP 6)
  7. bash scripts/ccagi-protocol-ack.sh --step1 ... --step2 ... --step3 ... \\
       --step4 ... --step5 ... --step6 ...
  8. その後にユーザーへの本来の返信を続ける

ゲートは次のユーザー入力で自動リセットされます。
EOF
  exit 2
fi

# --------------------------------------------------------------------------
# v0.5.0 追加: PASS 宣言前 3 mandatory marker enforcement
#   step6_mode が tdd または browser-test の場合、応答文中の verdict 系
#   キーワード検出時に以下 3 marker を要求:
#     tdd-db-probe-verified.turn
#     tdd-audit-trail-verified.turn
#     tdd-external-effect-verified.turn
# --------------------------------------------------------------------------
NEED_VERDICT_CHECK=0
case "$STEP6_MODE" in
  tdd|browser-test) NEED_VERDICT_CHECK=1 ;;
esac

if [ "$NEED_VERDICT_CHECK" = "1" ] && [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  # transcript の最後の assistant message からテキストを抽出
  LAST_ASSISTANT_TEXT="$(python3 - "$TRANSCRIPT" <<'PY' 2>/dev/null || echo ""
import json, sys
path = sys.argv[1]
last_text = ""
try:
    with open(path) as f:
        lines = f.readlines()
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        # Claude Code transcript format: {"type":"assistant","message":{"content":[{"type":"text","text":"..."},...]}}
        typ = e.get("type", "")
        role = e.get("role", "")
        if typ == "assistant" or role == "assistant":
            msg = e.get("message", {})
            content = msg.get("content", "") if isinstance(msg, dict) else ""
            if isinstance(content, list):
                text_parts = []
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "text":
                        text_parts.append(c.get("text", ""))
                last_text = "\n".join(text_parts)
            elif isinstance(content, str):
                last_text = content
            if last_text:
                break
except Exception:
    pass
print(last_text)
PY
)"

  # 検出パターン: verdict 系キーワード
  # word-boundary で PASSWORD などの誤検知を抑制
  # 「PASS」単独 / 「完璧 GREEN」 / 「SPEC-PASS」等
  if printf '%s' "$LAST_ASSISTANT_TEXT" | grep -qE '(\bPASS\b|\bGREEN\b|完璧|SPEC-PASS|SEQUENCE-PASS|CONTRACT-PASS|UI-PASS|verdict[[:space:]:：]+)'; then
    MISSING_MARKERS=""
    for m in db-probe audit-trail external-effect; do
      if [ ! -f "${STATE_DIR}/tdd-${m}-verified.turn" ]; then
        MISSING_MARKERS="${MISSING_MARKERS} tdd-${m}-verified.turn"
      fi
    done
    if [ -n "$MISSING_MARKERS" ]; then
      cat >&2 <<EOF
🚫 CCAGI Protocol Stop Gate — PASS 宣言前 3 mandatory 違反

step6_mode: ${STEP6_MODE}
応答文中に verdict 系キーワード (PASS / 完璧 / GREEN / verdict) を検出しました。

しかし以下の必須 marker が生成されていません:
${MISSING_MARKERS}

失敗レポート (request copy/20260724) の §4.3 対応:
  過去に UI navigability レベルの assertion のみで「PASS 8/8 完璧 GREEN」と宣言し、
  実 DB write / audit trail / 外部 side-effect の verify を系統的に skip していた事故。

「PASS」宣言前に必ず以下の 3 マーカーを生成してください:

  bash scripts/ccagi-pre-verdict-audit.sh \\
    --db-probe "prisma.<table>.count invoked=Y (before=X, after=Y, delta=Z)" \\
    --audit-trail "audit_logs.<event> delta=<N>" \\
    --external-effect "実 mail/SMS/Lark/external-API 到達確認 or 未該当理由" \\
    --uc-coverage "arrows=<N> assertions=<N> ratio=<%>" \\
    --verdict "SPEC-PASS または SEQUENCE-PASS または UI-PASS"

上記が実行不可能な場合、応答内の verdict 表現を訂正してください:
  - 「PASS」単独 -> 「UI-PASS のみ」/「SEQUENCE-PARTIAL」/「AUDIT-MISSING」等の下位 tier に downgrade
  - 「完璧 GREEN」-> 事実に基づく制限付き表現に置換
  - 参照: rules/verdict-vocabulary.md
EOF
      exit 2
    fi
  fi
fi

# --------------------------------------------------------------------------
# Pass: consume marker + counter + PASS-verified markers
# --------------------------------------------------------------------------
rm -f "$COUNTER_FILE" "$MARKER"
rm -f "${STATE_DIR}/tdd-db-probe-verified.turn" \
      "${STATE_DIR}/tdd-audit-trail-verified.turn" \
      "${STATE_DIR}/tdd-external-effect-verified.turn" 2>/dev/null || true
exit 0
