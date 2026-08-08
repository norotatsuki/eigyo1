#!/usr/bin/env bash
# perfect-tdd-defer-detector — Stop hook (tdd-perfection-gate v1.2.0)
#
# .claude/state/perfect-tdd-mode.turn が存在するターンで、
# Claude の最終応答テキスト中に「defer / 別session / 48h残 / 別の会話 /
# 後回し / 先送り / 続きは / 残りは」等の「途中で切り上げる」逃げ言語を
# 検出したら exit 2 で応答終了を拒否する。
#
# なぜ:
#   perfect-tdd-stop-gate は marker の存在チェックだけで、Claude が
#   「marker は無いけど defer するので終わります」と発話して応答終了する
#   ケースを止められなかった。 2026-07-26 事故 (P0 完了時点で「48h 残」
#   「別 session」と defer 宣言) を構造的に防止する。
#
# 入力: stdin から JSON (Claude Code Stop event)
#
# Exit code:
#   0 = 通過 (mode 未活性 or defer 言語未検出)
#   2 = 拒否 (defer 言語検出)
#
# 環境変数:
#   CLAUDE_PROJECT_DIR                Project root (default: pwd)
#   CCAGI_PERFECT_TDD_DEFER_ACK=1     ユーザー明示 override (稀有な例外用)
#   CCAGI_PERFECT_TDD_DEFER_QUIET=1   stderr 通知を抑制 (test 用)
set -euo pipefail

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.claude/state"
FLAG="${STATE_DIR}/perfect-tdd-mode.turn"

INPUT="$(cat 2>/dev/null || true)"

# perfect-tdd-mode 未活性 → 通過
if [ ! -f "$FLAG" ]; then
  exit 0
fi

# 明示 override
if [ "${CCAGI_PERFECT_TDD_DEFER_ACK:-0}" = "1" ]; then
  [ "${CCAGI_PERFECT_TDD_DEFER_QUIET:-0}" = "1" ] || \
    echo "⚠️  perfect-tdd-defer-detector: CCAGI_PERFECT_TDD_DEFER_ACK=1 で bypass しました" >&2
  exit 0
fi

TRANSCRIPT="$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); print(d.get("transcript_path",""))
except Exception:
  pass' 2>/dev/null || true)"

if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  # transcript 取得失敗時は fail-safe で通過 (BLOCK の連鎖を避ける)
  exit 0
fi

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
        typ = e.get("type", "")
        role = e.get("role", "")
        if typ == "assistant" or role == "assistant":
            msg = e.get("message", {})
            content = msg.get("content", "") if isinstance(msg, dict) else ""
            if isinstance(content, list):
                parts = []
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "text":
                        parts.append(c.get("text", ""))
                last_text = "\n".join(parts)
            elif isinstance(content, str):
                last_text = content
            if last_text:
                break
except Exception:
    pass
print(last_text)
PY
)"

if [ -z "$LAST_ASSISTANT_TEXT" ]; then
  exit 0
fi

# 「途中で切り上げる」逃げ言語 pattern (日本語 + 英語 + 混合)
DETECT_RESULT="$(TEXT="$LAST_ASSISTANT_TEXT" python3 <<'PY' 2>/dev/null || echo "NONE|"
import re, os
text = os.environ.get("TEXT", "")

# ----------------------------------------------------------------------
# v1.4.0: 検査対象から「言及にすぎない部分」を除去する
# ----------------------------------------------------------------------
# 除去しないと、以下が全て誤検出になる:
#   ・スクリプト名やファイル名の一部 (perfect-tdd-defer-detector.sh)
#   ・利用者へ引用して見せた門の出力 (> 🚫 ... defer ...)
#   ・コード例や設定例の中の識別子
#   ・「この語は禁止されています」という説明そのもの
# 逃げ口上は「地の文」で書かれるため、地の文だけを検査すれば十分。
def strip_noise(s):
    # 囲み記号つきコード塊
    s = re.sub(r'```.*?```', ' ', s, flags=re.DOTALL)
    # 行内のコード引用
    s = re.sub(r'`[^`\n]*`', ' ', s)
    # 引用行 (行頭 > )
    s = re.sub(r'(?m)^\s*>.*$', ' ', s)
    # ファイル名らしき語 (拡張子つき)
    s = re.sub(r'[\w./-]+\.(sh|ts|tsx|js|mjs|cjs|py|md|json|ya?ml|toml|lock|txt)\b', ' ', s)
    # 表の区切りだけの行 (|---|---| 等) は判定に不要
    s = re.sub(r'(?m)^\s*\|[\s|:-]+\|\s*$', ' ', s)
    return s

text = strip_noise(text)

# defer / 継続宣言 系の逃げ言語
# 完璧 TDD mode 活性中に応答終了時これらが出たら「途中で切り上げようとしている」
patterns = [
    # 別セッション / 別ターン系
    (r'別\s*[sS]ession',                    '別 session'),
    (r'別\s*セッション',                     '別セッション'),
    (r'別\s*の\s*会話',                      '別の会話'),
    (r'別\s*ターン',                         '別ターン'),
    (r'次\s*(の)?\s*[sS]ession',            '次の session'),
    (r'次\s*(の)?\s*会話',                   '次の会話'),
    (r'新\s*(しい)?\s*[sS]ession',          '新しい session'),
    (r'another\s+session',                   'another session'),
    (r'next\s+session',                      'next session'),
    (r'new\s+session',                       'new session'),
    (r'continue[ds]?\s+(in|next|later)',    'continue later'),
    (r'continu(?:ation|ing)\s+(in|next|later|session)', 'continuation later'),

    # defer / 先送り 系
    (r'\bdefer(?:red|ring|s)?\b',           'defer'),
    (r'先\s*送り',                           '先送り'),
    (r'後\s*回し',                           '後回し'),
    (r'後\s*で\s*(やり|実施|対応|進め|続け)', '後でやる'),
    (r'続\s*き\s*は',                        '続きは'),
    (r'残\s*り\s*は',                        '残りは'),

    # 時間残 / 途中終了 系
    (r'\d+\s*[hH]\s*(残|後|remain|left)',   'Nh 残',),
    (r'\d+\s*時間\s*残',                     'N時間 残'),
    (r'\d+\s*日\s*(残|後)',                  'N日 残'),
    (r'明\s*日\s*(continue|続け|やる|実施)',  '明日 continue'),
    (r'次\s*回\s*(に|で|は|やる|実施|続け)',  '次回に'),
    (r'context\s*(切れ|残り|不足|尽き)',     'context 切れ'),
    (r'コンテキスト\s*(切れ|残り|不足|尽き)', 'コンテキスト切れ'),

    # TBD / TBA / WIP 系
    (r'\bTBD\b',                             'TBD'),
    (r'\bTBA\b',                             'TBA'),
    (r'\bWIP\b',                             'WIP'),
    (r'to\s*be\s*(determined|announced|done|continued)', 'to be continued'),

    # 「別途」「一旦」等の切り上げ表現
    (r'別\s*途\s*(対応|実施|やる)',          '別途対応'),
    (r'一\s*旦\s*(終|切り上げ|保留|停止)',    '一旦終了'),

    # 「今回はここまで」系
    (r'今\s*回\s*は\s*ここ\s*まで',           '今回はここまで'),
    (r'今\s*回\s*(の)?\s*(scope|範囲|対象)\s*(は|を)?\s*(縮小|狭|限定)', '今回のscope縮小'),
]

for pat, label in patterns:
    m = re.search(pat, text, re.IGNORECASE)
    if m:
        # マッチ周辺 60 chars を context として抽出
        start = max(0, m.start() - 30)
        end = min(len(text), m.end() + 30)
        context = text[start:end].replace('\n', ' ')
        print(f"DETECT|{label}|{m.group(0)}|{context}")
        raise SystemExit(0)

print("NONE|")
PY
)"

STATUS="${DETECT_RESULT%%|*}"
if [ "$STATUS" != "DETECT" ]; then
  exit 0
fi

REST="${DETECT_RESULT#*|}"
LABEL="${REST%%|*}"
REST2="${REST#*|}"
MATCH="${REST2%%|*}"
CONTEXT="${REST2#*|}"

cat >&2 <<EOF
🚫 完璧テスト駆動 途中打切り検出係 — 応答終了を拒否

.claude/state/perfect-tdd-mode.turn が生きています。 それにも関わらず
応答文中に「途中で切り上げる」逃げ言葉を検出しました。

検出:
   種別:  ${LABEL}
   一致:  ${MATCH}
   文脈:  ...${CONTEXT}...

「完璧なテスト駆動開発」の号令が有効な間、応答は以下のいずれかで
終わらなくてはなりません:
  (A) 目印全部 (矢印要約 / バグ零確認 / 情報保管確認 / 監査記録確認 /
       外部到達確認) が揃った状態で 合格 宣言
  (B) ユーザー自身が「完璧TDDモード解除」と発話した後の応答

「defer / 別セッション / 続きは / 48時間残 / TBD」等での切り上げは、
本来やり切るはずの実測を Claude 側の一方的判断で先送りする、ズルの
典型的な手口として構造的に阻止されます。

対処:
  1. 先送りせず、文脈が続く限り実測を継続してください
  2. 本当に文脈が枯れた場合、ユーザーに以下を明示要求してください:
       「文脈が枯渇したため、続きは新しい会話で実施したい」
     ユーザーが承認したら、次のやりとりでユーザー自身に
     「完璧TDDモード解除」と発話してもらう

緊急の迂回 (ユーザー承認済みの場合のみ):
  CCAGI_PERFECT_TDD_DEFER_ACK=1 環境変数で通過可能

出典:
  2026-07-26 途中打切り事故 (最優先項目 完了時点で「48時間残」「別セッション」
  と先送り宣言、ユーザー激怒: 「止まるな 文脈残り無視 絶対絶対に完璧に
  やりきり止まるな 手を抜くな」への直接違反)
EOF

exit 2
