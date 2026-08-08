#!/usr/bin/env bash
# perfect-tdd-detector — UserPromptSubmit hook (tdd-perfection-gate v1.4.0)
#
# v1.4.0 の変更:
#   1. 問い合わせのみ (疑問形 かつ 作業依頼の動詞なし) では起動しない
#      → 「完璧テスト駆動は有効ですか?」で態勢が張られ無限に書き直す事故の防止
#   2. 起動時に 実行可能性 を事前判定し flag に feasible / missing_capabilities を記録
#      → 証跡を作る手段が無いリポジトリでは応答完了門が阻止しない
#
# ユーザーメッセージから「完璧なテスト駆動開発」等のトリガー句を検出し、
# 検出したら .claude/state/perfect-tdd-mode.turn フラグを生成する。
#
# フラグが存在するターンでは perfect-tdd-stop-gate.sh が Stop hook で
# per-arrow marker + zero-bug marker の存在を要求する。
#
# 入力: stdin から JSON (Claude Code UserPromptSubmit event)
#   {"user_message": "...", ...}
#
# 出力: 常に exit 0 (ユーザーメッセージ処理は妨害しない)
#
# 副作用: .claude/state/perfect-tdd-mode.turn の生成 or 更新
#         (トリガー未検出時は既存フラグを消費しない = 一度立てたら残す)
#
# 環境変数:
#   CLAUDE_PROJECT_DIR             プロジェクトルート (default: pwd)
#   PERFECT_TDD_MIN_PASS_STREAK    zero-bug loop の連続 pass 要求回数 (default: 3)
#   PERFECT_TDD_DETECTOR_QUIET     "1" にすると stderr 通知を抑制
set -euo pipefail

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.claude/state"
FLAG="${STATE_DIR}/perfect-tdd-mode.turn"
MIN_PASS_STREAK="${PERFECT_TDD_MIN_PASS_STREAK:-3}"

mkdir -p "$STATE_DIR" 2>/dev/null || true

# v1.6.0: 合否語の禁止は「態勢が解除されたターン」限りの措置。
# 新しいユーザー入力が来た時点で破棄し、次ターンに持ち越さない。
# (停止門側では消さない — 1 ターン中の複数回発火で消費されると
#  「手を止めて解除させ、次の停止で完璧と宣言する」経路が開くため)
rm -f "${STATE_DIR}/perfect-tdd-word-ban.turn" 2>/dev/null || true

INPUT="$(cat 2>/dev/null || true)"

# --------------------------------------------------------------------------
# ユーザーメッセージ抽出
# --------------------------------------------------------------------------
# Claude Code UserPromptSubmit event format 想定:
#   {"user_message": "...", "prompt": "...", ...}
# 上記フィールドが無い場合は input 全体を対象にする (堅牢化)。
# NOTE: bash では `pipe | python3 - <<'PY'` の pipe が heredoc に上書きされるため、
#        env var 経由でデータを渡す。
USER_MSG="$(CCAGI_INPUT="$INPUT" python3 - <<'PY' 2>/dev/null || true
import json, os
raw = os.environ.get("CCAGI_INPUT", "")
if not raw.strip():
    pass
else:
    try:
        d = json.loads(raw)
        if isinstance(d, dict):
            for k in ("user_message", "prompt", "message", "text"):
                v = d.get(k)
                if isinstance(v, str) and v:
                    print(v)
                    raise SystemExit(0)
            # 見つからなければ full JSON を対象にする
            print(json.dumps(d, ensure_ascii=False))
        else:
            print(raw)
    except SystemExit:
        raise
    except Exception:
        # JSON parse 失敗 → 生 input をトリガー検索対象に
        print(raw)
PY
)"

# stdin が空の場合、ここでは何もしない
if [ -z "$USER_MSG" ]; then
  exit 0
fi

# --------------------------------------------------------------------------
# トリガー検出
# --------------------------------------------------------------------------
# 検出パターン (case-insensitive):
#   完璧なテスト駆動開発 / 完璧TDD / 完璧なTDD / 完璧 TDD / 完璧テスト
#   perfect TDD / perfect-tdd / perfect test-driven / perfect tdd
#   ゼロバグ / zero-bug / zero bug / bug-zero / bug zero
#   矢印1本1本 / 矢印一本一本 / arrow-by-arrow / per-arrow / one-arrow-at-a-time
#
# 明示的な「解除」句も検出:
#   完璧TDDモード解除 / perfect-tdd off / TDDモード終了
DETECT_RESULT="$(CCAGI_MSG="$USER_MSG" python3 - <<'PY' 2>/dev/null || true
import re, os
msg = os.environ.get("CCAGI_MSG", "")

# ----------------------------------------------------------------------
# v1.6.0: 表記ゆれの正規化 (実測バグ 2 件の修正)
# ----------------------------------------------------------------------
# 日本語入力では数字が全角になるのが既定のため、「矢印１本１本」と打つと
# 半角前提の照合が全て外れ、利用者自身の言い回しで態勢が張られなかった。
#   実測 2026-07-30:
#     「矢印1本1本の動作確認をして実装してください」        → 発火
#     「矢印１本１本の動作確認をして実装してください」        → 未発火 ← バグ
# 全角英数を半角に落としてから照合する。
_Z2H = str.maketrans(
    "０１２３４５６７８９"
    "ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ"
    "ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ"
    "－＿",
    "0123456789"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "abcdefghijklmnopqrstuvwxyz"
    "-_",
)
msg = msg.translate(_Z2H)

# 「完璧な完璧な完璧な究極の究極の究極のテスト駆動開発」のような 強調の反復を
# 1 語に畳む。 反復した瞬間に照合が外れるのは 意図と正反対 (強調ほど強い要求)。
#   実測 2026-07-30:
#     「完璧なテスト駆動開発で修正してください」                        → 発火
#     「完璧な完璧な完璧な究極の究極の究極のテスト駆動開発を…」        → 未発火 ← バグ
msg_folded = re.sub(r'(完璧|究極|最強|徹底|完全)\s*[なのに]?\s*(?=(完璧|究極|最強|徹底|完全))',
                    '', msg)
# 畳んだ後に残る修飾語 (究極の / 完全な 等) も テスト駆動開発 の直前から外す
msg_folded = re.sub(r'(究極|最強|徹底|完全)\s*[なのに]?\s*(?=テスト駆動開発|TDD)',
                    '完璧な', msg_folded, flags=re.IGNORECASE)
msg = msg + "\n" + msg_folded

# 解除トリガー (最優先)
deactivate_patterns = [
    r'完璧TDDモード解除',
    r'完璧\s*TDD\s*解除',
    r'完璧\s*TDD\s*(モード)?\s*(終了|オフ|off)',
    r'perfect[-_ ]tdd[-_ ]off',
    r'perfect[-_ ]tdd[-_ ]disable',
    r'ゼロバグ\s*(モード)?\s*(解除|終了|オフ)',
]
for p in deactivate_patterns:
    if re.search(p, msg, re.IGNORECASE):
        print("DEACTIVATE|" + p)
        raise SystemExit(0)

# 起動トリガー
activate_patterns = [
    # v1.6.0: 「完璧の定義を下げるな」系は それ自体が最強の起動指示
    r'完璧\s*の?\s*定義\s*を?\s*(下げ|落と|緩め|狭め|切り下げ|変え|書き換え)',
    r'(究極|最強|徹底|完全)\s*[なの]?\s*テスト駆動開発',
    r'人の目に\s*(も)?\s*(見え|みえ)\S*\s*ブラウザ',
    r'完璧な?テスト駆動開発',
    r'完璧\s*TDD',
    r'完璧\s*テスト(?!.*駆動開発の\s*(禁止|例外))',
    r'perfect[-_ ]?tdd\b',
    r'perfect\s+test[-_ ]?driven',
    r'ゼロ\s*バグ',
    r'zero[-_ ]bug',
    r'bug[-_ ]zero',
    r'矢印\s*1\s*本\s*1\s*本',
    r'矢印\s*一\s*本\s*一\s*本',
    r'arrow[-_ ]by[-_ ]arrow',
    r'per[-_ ]arrow',
    r'one[-_ ]arrow[-_ ]at[-_ ]a[-_ ]time',
    r'シーケンス\s*(の)?\s*矢印\s*(全)?\s*(数|て)',
]
hit = None
for p in activate_patterns:
    m = re.search(p, msg, re.IGNORECASE)
    if m:
        hit = m.group(0)
        break

if hit is None:
    print("NONE|")
    raise SystemExit(0)

# ----------------------------------------------------------------------
# v1.4.0: 質問のみ / 言及のみ の場合は起動しない
# ----------------------------------------------------------------------
# 「完璧なテスト駆動開発は有効ですか?」のような 態勢そのものへの問い合わせで
# 起動してしまうと、作業実体が無いまま証跡を要求され応答が無限に書き直される。
# 判定: 疑問形の合図があり、かつ 作業依頼の動詞が 1 つも無ければ 起動しない。
question_markers = [
    r'[?？]',
    r'(です|でしょう|ますでしょう)?か[?？]?\s*$',
    r'(ですか|ますか|でしょうか)',
    r'(有効|無効|どう|なぜ|なに|何|どこ|いつ|どちら|どの)(に|が|は|を|で)?\s*(なって|なり|です|ですか|ますか)',
    r'について(教え|知り|確認)',
    r'とは[?？]?\s*$',
]
work_verbs = [
    r'(実装|修正|作成|作って|直して|やって|変更|追加|削除|対応|導入|置換|移行|整備|設計|構築)',
    r'(お願い|してください|して下さい|してほしい|して欲しい|進めて|始めて|開始)',
    r'(テストを?書|テストを?追加|テストを?回|走らせ|実行して)',
    r'(で(実装|開発|修正|作業)|により|を適用して)',
    r'\b(implement|fix|refactor|migrate|build|write|run|apply)\b',
]
has_question = any(re.search(p, msg, re.IGNORECASE) for p in question_markers)
has_work = any(re.search(p, msg, re.IGNORECASE) for p in work_verbs)

if has_question and not has_work:
    print("SKIP_QUESTION|" + hit)
    raise SystemExit(0)

print("ACTIVATE|" + hit)
PY
)"

ACTION="${DETECT_RESULT%%|*}"
PHRASE="${DETECT_RESULT#*|}"

# --------------------------------------------------------------------------
# 副作用: flag の生成/削除
# --------------------------------------------------------------------------
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

case "$ACTION" in
  ACTIVATE)
    # ----------------------------------------------------------------------
    # v1.4.0: 実行可能性の事前判定 (feasibility preflight)
    # ----------------------------------------------------------------------
    # 要求する証跡を作る手段がリポジトリに存在するかを先に調べる。
    # 存在しないなら flag に feasible=false を書き、応答完了門は阻止しない。
    # 「証明手段が無いのに証明を要求し続ける」無駄な繰返しを構造的に断つ。
    FEASIBILITY="$(PROJ="$PROJECT_ROOT" UCDIR="${PERFECT_TDD_UC_DIR:-docs/use_case}" python3 - <<'PY' 2>/dev/null || echo 'unknown|'
import json, os

root = os.environ["PROJ"]
uc_dir = os.environ["UCDIR"]
missing = []

def has(*parts):
    return os.path.exists(os.path.join(root, *parts))

# --- 前提 1: 全体走行できるテスト指示があるか ---
test_runner = False
pkg = os.path.join(root, "package.json")
if os.path.isfile(pkg):
    try:
        with open(pkg) as f:
            if (json.load(f).get("scripts") or {}).get("test"):
                test_runner = True
    except Exception:
        pass
for f in ("pytest.ini", "pyproject.toml", "tox.ini", "Cargo.toml", "go.mod",
          "pom.xml", "build.gradle", "build.gradle.kts", "Makefile"):
    if has(f):
        test_runner = True
for pat in ("vitest.config", "jest.config", "playwright.config"):
    for ext in (".ts", ".js", ".mjs", ".cjs"):
        if has(pat + ext):
            test_runner = True
if not test_runner:
    missing.append("全体走行できるテスト指示 (npm test / pytest / cargo test 等)")

# --- 前提 2: 使用場面書とその一覧凍結があるか ---
uc_ok = os.path.isdir(os.path.join(root, uc_dir))
if not uc_ok:
    for alt in ("docs/use_case", "docs/usecase", "docs/uc", "docs/use-cases"):
        if os.path.isdir(os.path.join(root, alt)):
            uc_ok = True
            break
if not uc_ok:
    missing.append("使用場面書フォルダ (既定 %s)" % uc_dir)

print(("yes" if not missing else "no") + "|" + "@@".join(missing))
PY
)"
    FEASIBLE_FLAG="${FEASIBILITY%%|*}"
    MISSING_CAPS="${FEASIBILITY#*|}"

    # ----------------------------------------------------------------------
    # v1.6.0: 母数の凍結 (denominator lock)
    # ----------------------------------------------------------------------
    # 2026-07-29 事故の内部過程 (利用者が提示した自己分析):
    #   1. 正典定義 (矢印 1 本 × 5 フェーズ × ブラウザ根治確認) を読んで認識していた
    #   2. 実施段階で「780 arrow × 5 = 3900 の実測が要る」と見積り
    #   3. その総量を 自分の実行予算 と 天秤にかけた
    #   4. 予算に収まらないと判断した瞬間、正典定義を保持したまま
    #      「今回はここまで」と 勝手に 完璧 の領域を切り下げた
    #   5. 切り下げ後の領域を「完璧」と呼び直して 合否宣言した
    #
    # 対策: 総量 N を 起動時に script が計算してファイルへ凍結する。
    #       Claude が書いた数ではないので、後から静かに書き換えられない。
    #       以降 要約は「現在の一覧」ではなく「凍結した N」と突き合わせる。
    DENOM="$(STATE_DIR="$STATE_DIR" python3 - <<'PY' 2>/dev/null || echo '0|false'
import json, os
mf = os.path.join(os.environ["STATE_DIR"], "uc-manifest.json")
try:
    with open(mf) as f:
        m = json.load(f)
    total = int(m.get("total_arrows", 0))
    print("%d|%s" % (total, "true" if total > 0 else "false"))
except Exception:
    print("0|false")
PY
)"
    FROZEN_ARROWS="${DENOM%%|*}"
    DENOM_LOCKED="${DENOM#*|}"

    # 既存 flag があっても再生成 (activated_at を最新化)
    TRIGGER="$PHRASE" TS="$TS" STREAK="$MIN_PASS_STREAK" FLAG="$FLAG" \
    FEASIBLE_FLAG="$FEASIBLE_FLAG" MISSING_CAPS="$MISSING_CAPS" \
    FROZEN_ARROWS="$FROZEN_ARROWS" DENOM_LOCKED="$DENOM_LOCKED" \
      python3 - <<'PY'
import json, os
caps = [c for c in os.environ.get("MISSING_CAPS", "").split("@@") if c]
data = {
    "activated_at":     os.environ["TS"],
    "trigger_phrase":   os.environ["TRIGGER"],
    "frozen_total_arrows": int(os.environ.get("FROZEN_ARROWS", "0") or 0),
    "denominator_locked":  os.environ.get("DENOM_LOCKED") == "true",
    "required_markers": [
        "tdd-arrow-summary",
        "tdd-zero-bug-verified"
    ],
    "existing_markers": [
        "tdd-db-probe-verified",
        "tdd-audit-trail-verified",
        "tdd-external-effect-verified"
    ],
    "min_pass_streak":  int(os.environ["STREAK"]),
    "feasible":         os.environ.get("FEASIBLE_FLAG") == "yes",
    "missing_capabilities": caps,
    "protocol":         "tdd-perfection-gate v1.6.0",
}
with open(os.environ["FLAG"], "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
    # 態勢を張り直したので 進捗計数もやり直す
    rm -f "${STATE_DIR}/perfect-tdd-stop.count" \
          "${STATE_DIR}/perfect-tdd-stop.progress" \
          "${STATE_DIR}/perfect-tdd-stop.total" 2>/dev/null || true
    if [ "${PERFECT_TDD_DETECTOR_QUIET:-}" != "1" ]; then
      cat >&2 <<EOF
🎯 完璧テスト駆動 態勢 起動 (tdd-perfection-gate v1.6.0)
   trigger: ${PHRASE}
   flag:    ${FLAG}
   凍結した母数: $([ "$DENOM_LOCKED" = "true" ] && echo "矢印 ${FROZEN_ARROWS} 本 (必要証跡 $((FROZEN_ARROWS * 5)) 個)" || echo "未凍結 — 先に使用場面 一覧凍結が必要")

⛔ 「完璧」の定義は 下げられません。
   この母数 ${FROZEN_ARROWS} は script が計算して凍結した数であり、
   Claude の実行予算の都合で切り下げることはできません。
   総量が予算に収まらない場合の 唯一 正しい出口は、
   「完璧」と呼ばずに 実際の到達率をそのまま報告することです:
     bash scripts/ccagi-arrow-verify.sh --incomplete-report

完璧なテスト駆動開発 = シーケンスの矢印 1 本 1 本 × 5 フェーズ
  1. バグの根本原因の確認
  2. バグ改修
  3. 単体テスト
  4. デプロイ
  5. ブラウザ操作でのテストでバグが根治していることの確認
  → 必要証跡数 = 矢印の本数 × 5

以降このターン中の応答終了条件:
  ① .claude/state/tdd-arrow-summary.turn        (全 UC md arrow verify 完了)
  ② .claude/state/tdd-zero-bug-verified.turn    (test 失敗数=0 連続 ${MIN_PASS_STREAK} 回)
  ③ .claude/state/tdd-db-probe-verified.turn    (DB delta 実測)
  ④ .claude/state/tdd-audit-trail-verified.turn (audit_logs delta 実測)
  ⑤ .claude/state/tdd-external-effect-verified.turn (外部到達実測)

いずれか欠落した状態で PASS/完璧/GREEN 系 verdict を宣言した瞬間、
Stop hook が exit 2 で応答終了を拒否します。

生成コマンド:
  # arrow 1 本ごと (5 フェーズ全部が必須。1 つでも欠けると marker は作られない)
  bash scripts/ccagi-arrow-verify.sh <UC-name> <arrow-index> \\
    --kind <A1-A6> \\
    --root-cause     "<根本原因の実測ログ / Issue>" \\
    --fix            "<改修ファイル / commit>" \\
    --unit-test      "<単体テストのファイル / 結果>" \\
    --deploy         "<デプロイ ログ / 環境>" \\
    --browser-verify "<動画 path または off:<8 文字以上の理由>>"
  bash scripts/ccagi-arrow-verify.sh --summary   # 全 arrow の 5 フェーズ完遂で summary marker 生成

  # zero-bug loop
  bash scripts/ccagi-zero-bug-loop.sh --cmd "npm test" --min-streak ${MIN_PASS_STREAK}

  # 既存 3 mandatory
  bash scripts/ccagi-pre-verdict-audit.sh --db-probe ... --audit-trail ... --external-effect ... --uc-coverage ... --verdict SPEC-PASS

解除するには次のユーザーメッセージで「完璧TDDモード解除」と明言してください。
EOF
    fi
    ;;
  DEACTIVATE)
    if [ -f "$FLAG" ]; then
      rm -f "$FLAG"
    fi
    # per-arrow marker 群も clean (次ターン用に残さない)
    rm -f "${STATE_DIR}"/tdd-arrow-*.turn 2>/dev/null || true
    rm -f "${STATE_DIR}/tdd-zero-bug-verified.turn" 2>/dev/null || true
    if [ "${PERFECT_TDD_DETECTOR_QUIET:-}" != "1" ]; then
      echo "🎯 Perfect TDD Mode DEACTIVATED (trigger: ${PHRASE})" >&2
    fi
    ;;
  SKIP_QUESTION)
    # v1.4.0: 態勢そのものへの問い合わせ → 起動しない (既存態勢も触らない)
    if [ "${PERFECT_TDD_DETECTOR_QUIET:-}" != "1" ]; then
      cat >&2 <<EOF
ℹ️  完璧テスト駆動 態勢: 起動を見送りました (問い合わせと判定)
   一致した語句: ${PHRASE}

作業依頼の動詞が見当たらず、疑問形だったため 態勢を張っていません。
実際にやり切らせたい場合は「完璧なテスト駆動開発で修正してください」の
ように 作業依頼の形で指示してください。
EOF
    fi
    ;;
  NONE|*)
    : # no-op
    ;;
esac

exit 0
