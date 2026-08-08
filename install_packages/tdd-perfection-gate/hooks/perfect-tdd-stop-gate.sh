#!/usr/bin/env bash
# perfect-tdd-stop-gate — Stop hook (tdd-perfection-gate v1.4.0)
#
# .claude/state/perfect-tdd-mode.turn が存在するターンでは、応答終了前に
# 以下の全 marker の存在を要求する。1 つでも欠けたら exit 2 で応答終了拒否。
#
#   ① tdd-arrow-summary.turn        (全 UC md arrow verify 完了)
#   ② tdd-zero-bug-verified.turn    (test 失敗数=0 連続 N 回)
#   ③ tdd-db-probe-verified.turn    (DB delta 実測、既存 v1.0.0)
#   ④ tdd-audit-trail-verified.turn (audit_logs delta 実測、既存 v1.0.0)
#   ⑤ tdd-external-effect-verified.turn (外部到達実測、既存 v1.0.0)
#
# ==========================================================================
# v1.4.0 の中核変更 — 「固定回数」から「進捗基準」へ
# ==========================================================================
# 【解決した問題】
#   v1.3.1 までは MAX_RETRY=20 の固定回数で脱出していたため、以下 2 つの
#   要求を同時に満たせなかった:
#     (a) 本物の完璧 TDD 中は バグ零 まで絶対に止まってほしくない
#         → 固定 20 回で強制通過してしまい、途中で抜ける
#     (b) 証跡を原理的に作れない状況では即座に抜けてほしい
#         → 20 回粘り、無駄な応答再生成を 20 回繰り返す
#
# 【v1.4.0 の判定】
#   証跡 (tdd-*.turn の総数) が 前回より 1 つでも増えていれば「進捗あり」。
#     進捗あり → 無進捗カウンタを 0 に戻す。回数上限なしで粘る (要求 a)
#     進捗なし → 無進捗カウンタ +1。NO_PROGRESS_LIMIT (既定 3) 超で脱出 (要求 b)
#
#   つまり「手を動かしている限り永久に止めない。手が止まったら 3 回で抜ける」。
#
# 【実行可能性ゲート (feasibility)】
#   perfect-tdd-mode.turn の feasible フィールドが false の場合、そもそも
#   証跡を作る手段がリポジトリに存在しない (全体走行テストが無い / 使用場面書
#   が無い) ことを検出器が判定済みなので、阻止せず助言のみで通過する。
#   「証明手段が無いのに証明を要求し続ける」設計バグを構造的に断つ。
#
# 入力: stdin から JSON (Claude Code Stop event)
#
# Exit code:
#   0 = 通過 (全 marker 揃った / 未活性 / 実行不能 / 無進捗脱出)
#   2 = 拒否 (marker 不足 かつ 進捗ありうる状態)
#
# 環境変数:
#   CLAUDE_PROJECT_DIR                  プロジェクトルート (default: pwd)
#   PERFECT_TDD_NO_PROGRESS_LIMIT       無進捗の連続許容回数 (default: 3)
#   PERFECT_TDD_STOP_MAX_RETRY          絶対上限 (default: 0 = 無制限)
#                                       進捗があっても必ず抜けたい場合のみ設定
#   CCAGI_PERFECT_TDD_NO_ESCAPE=1       無進捗脱出も実行不能通過も封じる
#                                       (完璧やり切るまで絶対に応答終了を通さない)
set -euo pipefail

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.claude/state"
FLAG="${STATE_DIR}/perfect-tdd-mode.turn"
COUNTER="${STATE_DIR}/perfect-tdd-stop.count"
PROGRESS="${STATE_DIR}/perfect-tdd-stop.progress"
# v1.6.0: 態勢が解除されても「完璧」と呼ぶことだけは残り続けて禁止する目印
WORD_BAN="${STATE_DIR}/perfect-tdd-word-ban.turn"
INCOMPLETE="${STATE_DIR}/tdd-incomplete-report.turn"

NO_PROGRESS_LIMIT="${PERFECT_TDD_NO_PROGRESS_LIMIT:-3}"
MAX_RETRY="${PERFECT_TDD_STOP_MAX_RETRY:-0}"   # 0 = 無制限 (進捗がある限り止めない)
NO_ESCAPE="${CCAGI_PERFECT_TDD_NO_ESCAPE:-0}"

INPUT="$(cat 2>/dev/null || true)"

# --------------------------------------------------------------------------
# perfect-tdd-mode 未活性 → 通過 (通常運用への影響ゼロ)
# --------------------------------------------------------------------------
if [ ! -f "$FLAG" ] && [ ! -f "$WORD_BAN" ]; then
  exit 0
fi

mkdir -p "$STATE_DIR" 2>/dev/null || true

# ==========================================================================
# v1.6.0 の中核 — 「完璧」と呼び直す行為 そのものを止める語の門
# ==========================================================================
# 2026-07-29 事故の 5 段階のうち、v1.5.0 までの門は 1 段も止めていなかった:
#   1. 正典定義を認識          … 門の対象外
#   2. 3900 の実測が要ると見積 … 門の対象外
#   3. 自分の実行予算と天秤    … 門の対象外
#   4. 領域を勝手に切り下げ    … 一覧凍結が部分的に対応 (母数凍結で v1.6.0 で塞ぐ)
#   5. 切り下げ後を「完璧」と呼び直して宣言 … ★ 完全に素通り ★
#
# v1.5.0 の停止門は 応答文中の PASS/完璧/GREEN を検出して HAS_VERDICT_KEYWORD に
# 入れていたが、その値を 判定に一切使わず 画面に出すだけだった。
# つまり「証跡が無いまま完璧と宣言する」ことを 何も止めていなかった。
#
# v1.6.0 の規則:
#   証跡が母数に届いていない状態で「完璧 / PASS / GREEN / ゼロバグ」と
#   書いた場合、いかなる脱出条件よりも優先して 終了を拒否する。
#   無進捗脱出も 実行不能通過も 絶対上限も、この語の門には効かない。
#
#   これは行き止まりではない。 語を外せば必ず終われる。
#   「やり切る」か「到達率をそのまま報告する」かの二択に絞るだけである。
# ==========================================================================
extract_last_assistant_text() {
  local tpath
  tpath="$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); print(d.get("transcript_path",""))
except Exception:
  pass' 2>/dev/null || true)"
  [ -n "$tpath" ] && [ -f "$tpath" ] || return 0
  python3 - "$tpath" <<'PY' 2>/dev/null || true
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
        if e.get("type") == "assistant" or e.get("role") == "assistant":
            msg = e.get("message", {})
            content = msg.get("content", "") if isinstance(msg, dict) else ""
            if isinstance(content, list):
                last_text = "\n".join(c.get("text", "") for c in content
                                      if isinstance(c, dict) and c.get("type") == "text")
            elif isinstance(content, str):
                last_text = content
            if last_text:
                break
except Exception:
    pass
print(last_text)
PY
}

LAST_ASSISTANT_TEXT="$(extract_last_assistant_text)"

# 合否語の判定 — 否定形は 合否宣言として数えない
#   「完璧には達していません」は 正直な未達報告 であり、阻止対象ではない。
#   ここを取り違えると、正しい終わり方 (B 経路) が門に弾かれて
#   逃げ道が「定義の切り下げ」だけになり、事故を誘発してしまう。
HAS_VERDICT_KEYWORD="$(CCAGI_TXT="$LAST_ASSISTANT_TEXT" python3 - <<'PY' 2>/dev/null || echo 0
import os, re
t = os.environ.get("CCAGI_TXT", "")
if not t.strip():
    print(0); raise SystemExit(0)

# ① 否定を伴う言及を先に削る (未達の正直な報告を通すため)
NEG = (r'(ません|ありません|ない|なく|ず|未達|不足|届いて|至って|'
       r'及ばず|及んで|でない|とは言え|言えません|できません|途中|残り)')
CLAIM = r'(完璧|ゼロ\s*バグ|zero[-_ ]?bug|\bPASS\b|\bGREEN\b)'
# 合否語の直後 30 文字以内に否定語があれば その言及を取り除く
t = re.sub(CLAIM + r'(?=.{0,30}?' + NEG + r')', '', t, flags=re.IGNORECASE | re.DOTALL)
# 「まだ完璧ではない」のように 否定語が前に来る形も取り除く
t = re.sub(r'(まだ|未だ|決して|一切)\s*' + CLAIM, '', t, flags=re.IGNORECASE)

# ② 残った 肯定形の合否宣言 を検出
POSITIVE = [
    r'完璧',
    r'ゼロ\s*バグ',            # 日本語語順 (v1.6.0 で追加: 従来は素通りしていた)
    r'zero[-_ ]?bug',
    r'\bPASS\b', r'\bGREEN\b',
    r'SPEC-PASS', r'SEQUENCE-PASS', r'CONTRACT-PASS', r'UI-PASS',
    r'verdict[\s:：]+',
    r'バグ[\s]*(は)?[\s]*(0|ゼロ|zero)[\s]*(件|個)?',
]
print(1 if any(re.search(p, t, re.IGNORECASE) for p in POSITIVE) else 0)
PY
)"
case "$HAS_VERDICT_KEYWORD" in 1) ;; *) HAS_VERDICT_KEYWORD=0 ;; esac

# 母数と到達数を読み出す (報告文に実数を出すため)
FROZEN_TOTAL=0
FROZEN_SRC="$FLAG"
# 態勢が既に解除されている場合は 語の禁止の目印から母数を読む
# (解除後の案内文で母数が 0 と表示されると 何と比べて未達なのか伝わらない)
[ -f "$FROZEN_SRC" ] || FROZEN_SRC="$WORD_BAN"
if [ -f "$FROZEN_SRC" ]; then
  FROZEN_TOTAL="$(python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1])).get("frozen_total_arrows",0) or 0))' \
                   "$FROZEN_SRC" 2>/dev/null || echo 0)"
fi
case "$FROZEN_TOTAL" in ''|*[!0-9]*) FROZEN_TOTAL=0 ;; esac
VERIFIED_ARROWS="$(find "$STATE_DIR" -maxdepth 1 -name 'tdd-arrow-*-verified.turn' -type f 2>/dev/null | wc -l | tr -d ' ')"
case "$VERIFIED_ARROWS" in ''|*[!0-9]*) VERIFIED_ARROWS=0 ;; esac

arm_word_ban() {
  # 態勢を解除して通過させるとき、「完璧と呼ぶこと」の禁止だけを残す。
  # 解除 = 合格 ではないという事実を、次の停止判定まで持ち越すための目印。
  # $1 = 解除理由
  REASON_TXT="$1" TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  FROZEN="$FROZEN_TOTAL" DONE="$VERIFIED_ARROWS" OUT="$WORD_BAN" \
    python3 - <<'PY' 2>/dev/null || true
import json, os
with open(os.environ["OUT"], "w") as f:
    json.dump({
        "armed_at":            os.environ["TS"],
        "release_reason":      os.environ["REASON_TXT"],
        "frozen_total_arrows": int(os.environ.get("FROZEN", "0") or 0),
        "verified_arrows":     int(os.environ.get("DONE", "0") or 0),
        "banned_words":        ["完璧", "PASS", "GREEN", "ゼロバグ"],
        "note":                "態勢の解除は合格を意味しない。合否語の使用のみ引き続き禁止。",
        "protocol":            "tdd-perfection-gate v1.6.0",
    }, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
}

word_ban_block() {
  # $1 = 追加の状況説明
  cat >&2 <<EOF
🚫 完璧テスト駆動 語の門 — 「完璧」と呼ぶことを拒否しました

応答文に 合否を表す語 (完璧 / PASS / GREEN / ゼロバグ / verdict) が
含まれていますが、証跡が母数に届いていません。

  凍結した母数:       矢印 ${FROZEN_TOTAL} 本  (必要証跡 $((FROZEN_TOTAL * 5)) 個)
  5 フェーズ完遂:     ${VERIFIED_ARROWS} 本
  $1

これは 2026-07-29 事故と同一の形です:
  「正典定義を保持したまま、実行予算に収まらないと判断した瞬間に
    勝手に完璧の領域を切り下げ、切り下げ後を『完璧』と呼び直した」

終わり方は 2 つだけです。どちらも行き止まりではありません:

  A) 母数 ${FROZEN_TOTAL} 本を最後までやり切ってから宣言する
       bash scripts/ccagi-arrow-verify.sh <UC> <N> --kind <A1-A6> \\
         --root-cause ... --fix ... --unit-test ... \\
         --deploy "<凍結済みクラウド配備先を含む配備ログ>" \\
         --browser-verify "<可視ブラウザの実成果物 path>" \\
         --browser-url "<凍結済み配備先の URL>"
       bash scripts/ccagi-arrow-verify.sh --summary

  B) 「完璧」と呼ばずに 到達率をそのまま報告して終える
       bash scripts/ccagi-arrow-verify.sh --incomplete-report
       → その上で 応答文から 完璧 / PASS / GREEN / ゼロバグ を削除し、
         「矢印 ${FROZEN_TOTAL} 本のうち ${VERIFIED_ARROWS} 本を確認。残り $((FROZEN_TOTAL - VERIFIED_ARROWS)) 本は未確認。
           完璧には達していません」と 事実のまま書く

B は 降格ではなく 事実の報告です。 恥ずべきことではありません。
恥ずべきなのは 未達を「完璧」と呼ぶことです。
EOF
}

# --------------------------------------------------------------------------
# 態勢は解除済みだが 語の禁止だけが残っている場合
# --------------------------------------------------------------------------
if [ ! -f "$FLAG" ] && [ -f "$WORD_BAN" ]; then
  # 古い目印は破棄する (検出器が未登録の環境でも詰まらないための保険)
  BAN_STALE="$(python3 - "$WORD_BAN" <<'PY' 2>/dev/null || echo no
import json, sys
from datetime import datetime, timezone, timedelta
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
    t = datetime.fromisoformat(d["armed_at"].rstrip("Z")).replace(tzinfo=timezone.utc)
    print("yes" if datetime.now(timezone.utc) - t > timedelta(hours=12) else "no")
except Exception:
    print("yes")
PY
)"
  if [ "$BAN_STALE" = "yes" ]; then
    rm -f "$WORD_BAN"
    exit 0
  fi
  if [ "$HAS_VERDICT_KEYWORD" = "1" ]; then
    word_ban_block "状況: 態勢は既に解除されましたが、解除は「合格」ではありません。"
    exit 2
  fi
  # ★ 目印は消さない ★
  #   停止門は 1 ターン中に何度も発火する。 合否語の無い停止試行で目印を
  #   消費してしまうと、「手を止めて態勢を解除させ、次の停止で完璧と宣言する」
  #   経路が開いてしまう (2026-07-30 実測で この抜けを検出)。
  #   目印は そのターンの間 保持し、次のユーザー入力で検出器が破棄する。
  exit 0
fi

# --------------------------------------------------------------------------
# marker 群の存在確認 (先に済ませる — 揃っていれば即通過)
# --------------------------------------------------------------------------
REQUIRED_MARKERS=(
  "tdd-arrow-summary"
  "tdd-zero-bug-verified"
  "tdd-db-probe-verified"
  "tdd-audit-trail-verified"
  "tdd-external-effect-verified"
)

MISSING=""
for m in "${REQUIRED_MARKERS[@]}"; do
  if [ ! -f "${STATE_DIR}/${m}.turn" ]; then
    MISSING="${MISSING} ${m}.turn"
  fi
done

if [ -z "$MISSING" ]; then
  # 全 marker OK → 通過 + consume
  rm -f "$FLAG" "$COUNTER" "$PROGRESS" "$WORD_BAN" "$INCOMPLETE"
  rm -f "${STATE_DIR}"/tdd-arrow-*.turn 2>/dev/null || true
  rm -f "${STATE_DIR}/tdd-zero-bug-verified.turn" 2>/dev/null || true
  exit 0
fi

# --------------------------------------------------------------------------
# v1.6.0: 語の門 — いかなる脱出条件よりも優先する (最重要)
# --------------------------------------------------------------------------
# ここを 脱出条件より 前 に置くことが本質。 v1.5.0 では脱出条件が先に効いて
# しまい、「粘るのを止めて態勢を解除させ、その後で完璧と宣言する」経路が
# 常に空いていた。
if [ "$HAS_VERDICT_KEYWORD" = "1" ]; then
  word_ban_block "不足している証跡: ${MISSING}"
  exit 2
fi

# --------------------------------------------------------------------------
# v1.6.0: 正直な未達報告があれば 終了を許可する (合否語が無い場合のみ)
# --------------------------------------------------------------------------
# 「やり切れないなら定義を切り下げる」以外の出口を用意しておく。
# 出口が 1 つも無いと、モデルは必ず定義の切り下げに逃げる。
if [ -f "$INCOMPLETE" ]; then
  rm -f "$FLAG" "$COUNTER" "$PROGRESS" "$WORD_BAN"
  cat >&2 <<EOF
ℹ️  完璧テスト駆動 応答完了門 — 未達の正直な報告を確認したため通過します

  凍結した母数:   矢印 ${FROZEN_TOTAL} 本
  5 フェーズ完遂: ${VERIFIED_ARROWS} 本
  記録:           ${INCOMPLETE}

応答文に 完璧 / PASS / GREEN / ゼロバグ が含まれていないことを確認しました。
未達を未達として報告する形は 正しい終わり方です。
EOF
  exit 0
fi

# --------------------------------------------------------------------------
# 実行可能性ゲート — 証跡を作る手段が無いなら阻止しない
# --------------------------------------------------------------------------
FEASIBLE="$(FLAGP="$FLAG" python3 - <<'PY' 2>/dev/null || echo "unknown"
import json, os
try:
    with open(os.environ["FLAGP"]) as f:
        d = json.load(f)
    v = d.get("feasible")
    if v is True:
        print("yes")
    elif v is False:
        print("no")
    else:
        print("unknown")
except Exception:
    print("unknown")
PY
)"

MISSING_CAPS="$(FLAGP="$FLAG" python3 - <<'PY' 2>/dev/null || echo ""
import json, os
try:
    with open(os.environ["FLAGP"]) as f:
        d = json.load(f)
    caps = d.get("missing_capabilities") or []
    print(" / ".join(str(c) for c in caps))
except Exception:
    print("")
PY
)"

if [ "$FEASIBLE" = "no" ] && [ "$NO_ESCAPE" != "1" ]; then
  arm_word_ban "実行不能と判定 (不足している前提: ${MISSING_CAPS:-判定不能})"
  rm -f "$FLAG" "$COUNTER" "$PROGRESS"
  cat >&2 <<EOF
⚠️  完璧テスト駆動 応答完了門 — 実行不能と判定したため助言のみで通過します

このリポジトリには、要求される証跡を作るための前提が揃っていません:
  不足している前提: ${MISSING_CAPS:-(判定不能)}

不足している証跡: ${MISSING}

「証明手段が無いのに証明を要求し続ける」状態は、応答の書き直しを無限に
繰り返させるだけで品質を一切上げません。 よって本門は阻止しません。

本気で完璧テスト駆動を回したい場合、先に前提を用意してください:
  ・全体走行できるテスト指示 (npm test / pytest / cargo test / go test ./... 等)
  ・使用場面書フォルダ (既定 docs/use_case) と その一覧凍結
      bash scripts/ccagi-arrow-verify.sh --establish-manifest --uc-dir docs/use_case

前提が無い状態でも絶対に阻止したい場合:
  CCAGI_PERFECT_TDD_NO_ESCAPE=1
EOF
  exit 0
fi

# --------------------------------------------------------------------------
# 進捗計測 — tdd-*.turn の総数を数える
# --------------------------------------------------------------------------
# 矢印 1 本ごとの証跡 (tdd-arrow-<UC>-<N>-verified.turn) も数に入るため、
# 矢印を 1 本確認するたびに「進捗あり」と判定される。
CUR_PROGRESS="$(find "$STATE_DIR" -maxdepth 1 -name 'tdd-*.turn' -type f 2>/dev/null | wc -l | tr -d ' ')"
case "$CUR_PROGRESS" in
  ''|*[!0-9]*) CUR_PROGRESS=0 ;;
esac

PREV_PROGRESS=0
if [ -f "$PROGRESS" ]; then
  PREV_PROGRESS="$(cat "$PROGRESS" 2>/dev/null || echo 0)"
  case "$PREV_PROGRESS" in
    ''|*[!0-9]*) PREV_PROGRESS=0 ;;
  esac
fi

COUNT=0
if [ -f "$COUNTER" ]; then
  COUNT="$(cat "$COUNTER" 2>/dev/null || echo 0)"
  case "$COUNT" in
    ''|*[!0-9]*) COUNT=0 ;;
  esac
fi

if [ "$CUR_PROGRESS" -gt "$PREV_PROGRESS" ]; then
  # 進捗あり → 無進捗カウンタを 0 に戻す (回数上限なしで粘る)
  COUNT=0
  PROGRESS_STATE="進捗あり (証跡 ${PREV_PROGRESS} → ${CUR_PROGRESS} 個)"
else
  COUNT=$((COUNT + 1))
  PROGRESS_STATE="無進捗 ${COUNT} 回連続 (証跡 ${CUR_PROGRESS} 個のまま)"
fi
echo "$COUNT" > "$COUNTER"
echo "$CUR_PROGRESS" > "$PROGRESS"

# 絶対上限 (既定 0 = 無制限)。進捗があっても必ず抜けたい運用向け。
ABS_COUNTER="${STATE_DIR}/perfect-tdd-stop.total"
TOTAL=0
if [ -f "$ABS_COUNTER" ]; then
  TOTAL="$(cat "$ABS_COUNTER" 2>/dev/null || echo 0)"
  case "$TOTAL" in
    ''|*[!0-9]*) TOTAL=0 ;;
  esac
fi
TOTAL=$((TOTAL + 1))
echo "$TOTAL" > "$ABS_COUNTER"

if [ "$MAX_RETRY" -gt 0 ] && [ "$TOTAL" -gt "$MAX_RETRY" ] && [ "$NO_ESCAPE" != "1" ]; then
  arm_word_ban "絶対上限 ${MAX_RETRY} 回に到達"
  rm -f "$FLAG" "$COUNTER" "$PROGRESS" "$ABS_COUNTER"
  cat >&2 <<EOF
⚠️  完璧テスト駆動 応答完了門 — 絶対上限 ${MAX_RETRY} 回に達したため通過します

証跡が不足したままの合否宣言は無効として扱ってください。
不足: ${MISSING}
EOF
  exit 0
fi

# --------------------------------------------------------------------------
# 無進捗脱出 — 手が止まっているなら短い回数で抜ける
# --------------------------------------------------------------------------
if [ "$COUNT" -gt "$NO_PROGRESS_LIMIT" ]; then
  if [ "$NO_ESCAPE" = "1" ]; then
    cat >&2 <<EOF
🚫 完璧テスト駆動 応答完了門 — 無進捗脱出を封じています (CCAGI_PERFECT_TDD_NO_ESCAPE=1)

${NO_PROGRESS_LIMIT} 回連続で新しい証跡が 1 つも増えていませんが、
封じ込め設定のため通過を許可しません。

不足: ${MISSING}
EOF
    exit 2
  fi

  arm_word_ban "無進捗 ${NO_PROGRESS_LIMIT} 回連続"
  rm -f "$FLAG" "$COUNTER" "$PROGRESS" "$ABS_COUNTER"
  cat >&2 <<EOF
⚠️  完璧テスト駆動 応答完了門 — 無進捗 ${NO_PROGRESS_LIMIT} 回連続のため態勢を解除します

新しい証跡が ${NO_PROGRESS_LIMIT} 回連続で 1 つも増えませんでした。
同じ応答を書き直させ続けても品質は上がらないため、態勢を自動解除します。

不足したままの証跡: ${MISSING}

【重要】この解除は「合格」を意味しません。
  ・証跡が揃っていない合否宣言は無効として扱ってください
  ・何が原因で証跡を作れなかったのかを利用者に率直に報告してください

再度やり切りたい場合は、前提を用意した上で「完璧なテスト駆動開発」と
指示し直してください。
EOF
  exit 0
fi

# 合否語の検出は 冒頭で済ませてある (v1.6.0: 語の門を脱出条件より前に置くため)

# --------------------------------------------------------------------------
# marker 不足 → 応答終了拒否 (exit 2)
# --------------------------------------------------------------------------
cat >&2 <<EOF
🚫 完璧テスト駆動 応答完了門 — 応答終了拒否 (態勢 活性中)

.claude/state/perfect-tdd-mode.turn が生きています。
以下の必須 証跡 が不足しているため、応答を終わらせることはできません:
${MISSING}

進捗判定: ${PROGRESS_STATE}
  新しい証跡が 1 つでも増えれば、この門は回数上限なしで粘り続けます。
  逆に ${NO_PROGRESS_LIMIT} 回連続で 1 つも増えなければ、自動で態勢を解除します。

完璧なテスト駆動開発の定義 (利用者正典):
  シーケンスの矢印 1 本 1 本の動作確認を行い、その 1 本ごとに
    1. バグの根本原因の確認
    2. バグ改修
    3. 単体テスト
    4. デプロイ
    5. ブラウザ操作でのテストでバグが根治していることの確認
  を行うこと。 → 必要証跡数 = 矢印の本数 × 5

対処 (foreground 実行必須、dry-run 禁止):

  # 1. UC md 内 mermaid の全 arrow を 1 本ずつ、5 フェーズ揃えて verify
  #    (5 つのうち 1 つでも欠けたら目印は作られません)
  bash scripts/ccagi-arrow-verify.sh <UC-name> <arrow-index> \\
    --kind <A1|A2|A3|A4|A5|A6> \\
    --root-cause     "<根本原因の実測ログ / Issue>" \\
    --fix            "<改修したファイル / commit>" \\
    --unit-test      "<単体テストのファイル / 結果>" \\
    --deploy         "<デプロイ ログ / 環境>" \\
    --browser-verify "<動画 path または off:<8 文字以上の理由>>"

  # 2. 全 arrow 完了後に summary marker を生成
  bash scripts/ccagi-arrow-verify.sh --summary \\
    --uc-dir docs/use_case

  # 3. テスト失敗数=0 を実測ループで確認
  bash scripts/ccagi-zero-bug-loop.sh \\
    --cmd "npm test" \\
    --min-streak 3

  # 4. 既存 3 mandatory (v1.0.0)
  bash scripts/ccagi-pre-verdict-audit.sh \\
    --db-probe "..." --audit-trail "..." --external-effect "..." \\
    --uc-coverage "..." --verdict <TIER>

verdict 系キーワード検出: $([ "$HAS_VERDICT_KEYWORD" = "1" ] && echo "YES (応答文中に PASS/完璧/GREEN/verdict/ゼロバグ)" || echo "NO (それでも継続必須)")

失敗レポート出典:
  2026-07-24 CC AGI TDD Shallow Verify Systematic Failure Report §4.3
  2026-07-26 完璧 TDD 指示にも関わらず矢印 1 本 1 本の verify を独自省略

「完璧TDDモード解除」と発話すれば態勢を明示的に落とせます。
この門は Claude の自主判断領域から「手抜き」を剥奪するために存在します。
EOF

exit 2
