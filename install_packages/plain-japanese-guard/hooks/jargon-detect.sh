#!/usr/bin/env bash
# jargon-detect — Stop hook (plain-japanese-guard v1.4.0)
#
# Claude 応答終了時に応答文中のカタカナ・英字ジャーゴン禁止語を検出し、
# 検出時は exit 2 で応答終了を拒否して言換候補を提示する。
#
# 禁止語リスト: .claude/lib/jargon-list.txt (TSV 形式: <禁止語>\t<推奨言換>\t<理由>)
#
# 動作:
#   1. Stop hook input JSON から transcript_path を取得
#   2. 最後の user メッセージからユーザー入力言語を判定 (ひらがな検出)
#   3. transcript.jsonl の最後の assistant message からテキストを抽出
#   4. jargon-list.txt の各禁止語を検出
#   5. 検出があれば阻止 (block) または警告 (warn) を出す
#
# v1.4.0 追加: 日本語入力時の最強化 (2026-07-26 ユーザー明示要求)
#   - 最終 user 発言にひらがなが含まれる → 日本語モード (ja)
#     → SKIP_ON_COMPLETION 強制 0 / MAX_STOP_BLOCKS 強制 999 / bypass 環境変数を監査記録
#   - 日本語以外 → 従来の緩和動作 (完了時 skip、上限 5 回)
#
# v1.1.0 追加: completion-safe mode (日本語モードでは無効化される)
#
# 環境変数:
#   CCAGI_JARGON_ACK=1                 Stop 検出を bypass (日本語モード時は監査記録され警告に降格)
#   CCAGI_JARGON_MODE=warn             exit 0 で通過するが warn を stderr に出力
#   CCAGI_JARGON_LIST=<path>           jargon list ファイルの override
#   CCAGI_JARGON_SKIP_ON_COMPLETION=1  完了 phase 検出時 warn へ auto downgrade (default: 1)
#                                       (日本語モード時は 0 に強制)
#   CCAGI_JARGON_COMPLETION_PATTERNS=<path>  完了 pattern ファイルの override
#   CCAGI_JARGON_MAX_STOP_BLOCKS=<N>   同一ターン内 BLOCK 上限 (default: 5、日本語モード時は 999)
#   CCAGI_JARGON_STRICT_ON_TDD=1       完璧テスト駆動 活性中は completion-safe を無効化 (default: 1)
#   CCAGI_JARGON_FORCE_LANG=ja|en      言語検出を強制上書き (テスト用)
set -euo pipefail

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.claude/state"
JARGON_LIST="${CCAGI_JARGON_LIST:-${PROJECT_ROOT}/.claude/lib/jargon-list.txt}"
COMPLETION_PATTERNS_FILE="${CCAGI_JARGON_COMPLETION_PATTERNS:-${PROJECT_ROOT}/.claude/lib/jargon-completion-patterns.txt}"
COUNTER_FILE="${STATE_DIR}/jargon-detect.count"
BYPASS_AUDIT_LOG="${STATE_DIR}/jargon-bypass-audit.log"
MODE="${CCAGI_JARGON_MODE:-block}"
SKIP_ON_COMPLETION="${CCAGI_JARGON_SKIP_ON_COMPLETION:-1}"
# v1.2.0: 2→5 に硬化 (Claude の 2 回発火脱出パターン抑止)
MAX_STOP_BLOCKS="${CCAGI_JARGON_MAX_STOP_BLOCKS:-5}"
# v1.2.0: perfect-tdd-mode 活性中は completion-safe skip を無効化
STRICT_ON_TDD="${CCAGI_JARGON_STRICT_ON_TDD:-1}"

# perfect-tdd-mode 活性検出 (STRICT_ON_TDD=1 なら SKIP_ON_COMPLETION を無効化)
PERFECT_TDD_FLAG="${STATE_DIR}/perfect-tdd-mode.turn"
if [ "$STRICT_ON_TDD" = "1" ] && [ -f "$PERFECT_TDD_FLAG" ]; then
  SKIP_ON_COMPLETION=0
fi

mkdir -p "$STATE_DIR" 2>/dev/null || true

# --------------------------------------------------------------------------
# v1.4.0: 入力言語検出 → 日本語モード時は 最強化
#   1. transcript から最後の user message を抽出
#   2. ひらがな (぀-ゟ) が 1 文字でもあれば日本語 (ja) 判定
#   3. ja 判定なら:
#      - SKIP_ON_COMPLETION=0 (完了時 skip を無効化)
#      - MAX_STOP_BLOCKS=999 (連投脱出を封じる)
#      - bypass 環境変数を監査記録 (無音 bypass 禁止)
# --------------------------------------------------------------------------
USER_LANG="${CCAGI_JARGON_FORCE_LANG:-}"
# 一旦 stdin を取得 (以降で transcript_path 取得に利用)
INPUT="$(cat 2>/dev/null || true)"
TRANSCRIPT="$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); print(d.get("transcript_path",""))
except Exception:
  pass' 2>/dev/null || true)"

if [ -z "$USER_LANG" ] && [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  USER_LANG="$(python3 - "$TRANSCRIPT" <<'PY' 2>/dev/null || echo ""
import json, re, sys
path = sys.argv[1]
try:
    with open(path, encoding='utf-8') as f:
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
        if typ == "user" or role == "user":
            msg = e.get("message", {})
            content = msg.get("content", "") if isinstance(msg, dict) else ""
            if isinstance(content, list):
                text = "\n".join([c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"])
            elif isinstance(content, str):
                text = content
            else:
                text = ""
            # ひらがな (぀-ゟ) が 1 文字でもあれば日本語判定
            if re.search(r'[぀-ゟ]', text):
                print("ja")
            else:
                print("en")
            sys.exit(0)
    print("unknown")
except Exception:
    print("unknown")
PY
  )"
fi
USER_LANG="${USER_LANG:-unknown}"

# 日本語モード: 全ての緩和を無効化
if [ "$USER_LANG" = "ja" ]; then
  SKIP_ON_COMPLETION=0
  MAX_STOP_BLOCKS=999
fi

# bypass 環境変数チェック (日本語モードでは監査 log に記録して警告に降格、他モードでは従来通り exit 0)
if [ "${CCAGI_JARGON_ACK:-0}" = "1" ]; then
  if [ "$USER_LANG" = "ja" ]; then
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "${ts}	lang=ja	CCAGI_JARGON_ACK=1	bypass_downgraded_to_warn" >> "$BYPASS_AUDIT_LOG" 2>/dev/null || true
    if [ "${CCAGI_JARGON_QUIET:-}" != "1" ]; then
      echo "⚠️  平易日本語 検出係: 日本語入力中の CCAGI_JARGON_ACK=1 検出。監査 log に記録し、bypass を警告に降格します。" >&2
      echo "    監査 log: $BYPASS_AUDIT_LOG" >&2
    fi
    MODE="warn"
  else
    exit 0
  fi
fi

# 無限ループ防止: 同一ターン内 MAX_STOP_BLOCKS 回発火で自動 pass
# (v1.0.0 default 3 → v1.1.0 default 2)
# MAX_STOP_BLOCKS の数値 validation
case "$MAX_STOP_BLOCKS" in
  ''|*[!0-9]*) MAX_STOP_BLOCKS=5 ;;
esac

if [ -f "$COUNTER_FILE" ]; then
  COUNT="$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)"
  case "$COUNT" in
    ''|*[!0-9]*) COUNT=0 ;;
  esac
  if [ "$COUNT" -ge "$MAX_STOP_BLOCKS" ]; then
    rm -f "$COUNTER_FILE"
    if [ "${CCAGI_JARGON_QUIET:-}" != "1" ]; then
      echo "⚠️  平易日本語 検出係: 同じやりとり内 ${MAX_STOP_BLOCKS} 回阻止に達したため自動通過 (無限繰返し防止)" >&2
    fi
    exit 0
  fi
  echo $((COUNT + 1)) > "$COUNTER_FILE"
else
  echo 1 > "$COUNTER_FILE"
fi

# jargon-list.txt 不存在時は skip (fail-safe)
if [ ! -f "$JARGON_LIST" ]; then
  exit 0
fi

# INPUT / TRANSCRIPT は言語検出セクションで既に取得済み
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  # transcript 取得失敗時は skip (fail-safe)
  exit 0
fi

# 最後の assistant message からテキストを抽出
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

if [ -z "$LAST_ASSISTANT_TEXT" ]; then
  exit 0
fi

# --------------------------------------------------------------------------
# v1.1.0: completion-safe detection
# 応答文中に完了系キーワードを検出した場合、mode を warn に強制切替。
# BLOCK loop により作業完了直前の報告が延々と再送される事故 (2026-07-26) 対応。
# --------------------------------------------------------------------------
IN_COMPLETION_PHASE=0
COMPLETION_MATCHED=""
if [ "$SKIP_ON_COMPLETION" = "1" ]; then
  # デフォルト完了 pattern (custom file が無い場合の fallback)
  COMPLETION_RESULT="$(TEXT="$LAST_ASSISTANT_TEXT" PATTERNS_FILE="$COMPLETION_PATTERNS_FILE" python3 <<'PY' 2>/dev/null || echo "NO|"
import os, re, sys

text = os.environ.get("TEXT", "")
patterns_file = os.environ.get("PATTERNS_FILE", "")

default_patterns = [
    r'##\s*完了報告',
    r'完了報告',
    r'完了しました',
    r'完成しました',
    r'完遂しました',
    r'実装完了',
    r'修正完了',
    r'作業完了',
    r'タスク完了',
    r'\[100%\]',
    r'100%\s*完了',
    r'以上で(完了|終了|以上)',
    r'^以上\.?$',       # 単独 「以上」で終わる行
    r'^以上です\.?$',
    r'^以上、',
    r'完成いたしました',
    r'✅\s*(完了|全て|全 test)',
    r'all\s+tests?\s+(pass|passed|passing)',
    r'\bAll\s+done\b',
    r'\bcomplete[ds]?\b(?!\s*(fail|error|the\s+following))',
    # 「N/N tests PASS」パターン
    r'\b\d+\s*/\s*\d+\s+(tests?\s+)?PASS',
    # `## 完了報告`, `# 完了`, `### 完成` 等の見出し
    r'^#{1,4}\s*(完了|完成|完遂|作業完了)',
    # progress 100%
    r'\[\s*100\s*%\s*\]',
]

# custom patterns (存在すれば default に追加)
patterns = list(default_patterns)
if patterns_file and os.path.exists(patterns_file):
    try:
        with open(patterns_file, encoding='utf-8') as f:
            for line in f:
                line = line.rstrip('\n')
                if not line or line.startswith('#'):
                    continue
                patterns.append(line)
    except Exception:
        pass

# 応答の末尾 3000 chars だけ対象 (中間で単発マッチしても最終報告じゃない可能性)
# ただし全文検索も行い、ヘッダー/明確な完了 marker はどこでもマッチ
tail = text[-3000:] if len(text) > 3000 else text

matched = None
for p in patterns:
    try:
        m = re.search(p, tail, re.IGNORECASE | re.MULTILINE)
        if m:
            matched = (p, m.group(0))
            break
        # 明確な完了 marker (見出し / [100%]) は全文でも検索
        if p.startswith(r'##') or '100%' in p or '完了報告' in p:
            m2 = re.search(p, text, re.IGNORECASE | re.MULTILINE)
            if m2:
                matched = (p, m2.group(0))
                break
    except re.error:
        continue

if matched:
    print("YES|" + matched[1])
else:
    print("NO|")
PY
)"
  DETECT="${COMPLETION_RESULT%%|*}"
  COMPLETION_MATCHED="${COMPLETION_RESULT#*|}"
  if [ "$DETECT" = "YES" ]; then
    IN_COMPLETION_PHASE=1
    MODE="warn"  # completion phase 中は強制 warn
  fi
fi

# 禁止語検出: python で TSV パース + string search
DETECTED="$(TEXT="$LAST_ASSISTANT_TEXT" LIST="$JARGON_LIST" python3 <<'PY' 2>/dev/null || echo ""
import os, re, sys
text = os.environ.get("TEXT", "")
list_path = os.environ.get("LIST", "")

# ----------------------------------------------------------------------
# v1.5.0: 検査対象から「言換えてはいけない部分」を除去する
# ----------------------------------------------------------------------
# plain-japanese.md の判定原則 1 が「固有名詞・ファイル名・パス・コマンド・
# コード上の識別子はそのまま可」と定めているのに、検出側が素の文字列一致で
# あったため、コード塊やファイル名の中の識別子まで禁止語として拾っていた。
# 判定原則どおり、地の文だけを検査する。
def strip_noise(s):
    s = re.sub(r'```.*?```', ' ', s, flags=re.DOTALL)   # 囲み記号つきコード塊
    s = re.sub(r'`[^`\n]*`', ' ', s)                    # 行内のコード引用
    s = re.sub(r'(?m)^\s*>.*$', ' ', s)                 # 引用行
    s = re.sub(r'[\w./-]+\.(sh|ts|tsx|js|mjs|cjs|py|md|json|ya?ml|toml|lock|txt)\b',
               ' ', s)                                   # ファイル名 / パス
    s = re.sub(r'(?m)^\s*(bash|sh|npx|npm|pnpm|yarn|python3?|cargo|go)\s+\S.*$',
               ' ', s)                                   # 素で書かれたコマンド行
    return s

# ----------------------------------------------------------------------
# v1.5.0: 例外宣言の実装 (これまで案内文にはあったが未実装だった)
#   書式: ※本応答で「<語>」を使用しています。<理由>
#   1 つの宣言に「<語>」を複数並べてもよい。
# ----------------------------------------------------------------------
exempt = set()
for m in re.finditer(r'※\s*本応答で(.+?)を使用しています', text):
    for w in re.findall(r'[「『"\']([^」』"\']+)[」』"\']', m.group(1)):
        w = w.strip()
        if w:
            exempt.add(w)

text = strip_noise(text)

try:
    with open(list_path, encoding='utf-8') as f:
        detected = []
        for line in f:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            word = parts[0].strip()
            replacement = parts[1].strip()
            reason = parts[2].strip() if len(parts) > 2 else ""
            if not word:
                continue
            if word in exempt:
                continue
            if word in text:
                detected.append(f"  ❌ {word:20s} → {replacement}" + (f"  ({reason})" if reason else ""))
        # 検出上位 20 個だけ表示 (ノイズ抑制)
        for line in detected[:20]:
            print(line)
        if len(detected) > 20:
            print(f"  ... 他 {len(detected)-20} 個の禁止語")
except Exception:
    pass
PY
)"

if [ -z "$DETECTED" ]; then
  # 検出なし → 通過 (成功時はカウンタも消して次ターンでリセット)
  rm -f "$COUNTER_FILE" 2>/dev/null || true
  exit 0
fi

# 検出あり
if [ "$MODE" = "warn" ]; then
  # warn モード: stderr に警告出力するが exit 0 で通す
  # (v1.1.0: completion-safe detection で BLOCK loop 抑止のためこの経路が増える)
  if [ "$IN_COMPLETION_PHASE" = "1" ]; then
    cat >&2 <<EOF
ℹ️  平易日本語 検出係 — 完了場面検出により阻止省略 (警告のみ)

作業完了直前の報告で禁止語による阻止繰返しを避けるため、警告に自動格下げしました。
検出した完了目印: ${COMPLETION_MATCHED}

以下の禁止語が完了報告内に含まれます (次回応答から言換推奨):
${DETECTED}

この保護を無効化するには: CCAGI_JARGON_SKIP_ON_COMPLETION=0
参照: .claude/rules/plain-japanese.md
言換辞書: ${JARGON_LIST}
EOF
  else
    cat >&2 <<EOF
⚠️  平易日本語 検出係 — 検出 (警告モード: 阻止しません)

応答文中に禁止語を検出しました。次回応答から言換してください:

${DETECTED}

参照: .claude/rules/plain-japanese.md
言換辞書: ${JARGON_LIST}
EOF
  fi
  rm -f "$COUNTER_FILE" 2>/dev/null || true
  exit 0
fi

# 阻止 (既定): 応答終了を拒否 (終了コード 2)
LANG_LABEL="言語検出=${USER_LANG}"
if [ "$USER_LANG" = "ja" ]; then
  LANG_LABEL="言語検出=ja (日本語入力 → 最強化モード適用中: 完了保護 OFF / 上限 999 / bypass は監査記録)"
fi

cat >&2 <<EOF
🚫 平易日本語 検出係 — 応答終了を拒否 (禁止カタカナ・英字混在を検出)

${LANG_LABEL}

応答文中に、一般的な日本人が理解しにくい禁止語を検出しました。
以下を和語・漢語に言換してから応答を再送信してください:

${DETECTED}

------------------------------------------------------------------------
判定原則 (.claude/rules/plain-japanese.md 参照):
  1. 固有名詞 (TypeScript / Playwright 等) はそのまま可
  2. 定着済み外来語 (テスト / バグ / メール 等) はそのまま可
  3. 判定 3 で 和語・漢語代替可能なカタカナ・英字は必ず言換
------------------------------------------------------------------------

例外を宣言する場合:
  - 応答内に「※本応答で「<語>」を使用しています。<理由>」を明示
  - 日本語入力以外の場合: 環境変数 CCAGI_JARGON_ACK=1 (会話単位の通過)
    ※日本語入力中は監査 log に記録され警告に降格されます
  - または CCAGI_JARGON_MODE=warn (阻止ではなく警告のみに切替)
  - 応答内に「完了報告」「以上」「[100%]」等の完了目印が含まれる場合は
    自動的に警告に格下げされます (v1.1.0 完了保護、日本語入力中は無効)
  - 完璧テスト駆動 活性中も完了保護が無効化されます (v1.2.0)

無限繰返し防止:
  - 同じやりとり内で ${MAX_STOP_BLOCKS} 回阻止に達すると自動通過
    (日本語入力中は 999 回 = 実質無制限)
  - 完了保護を無効化するには CCAGI_JARGON_SKIP_ON_COMPLETION=0

言換辞書: ${JARGON_LIST}
EOF
exit 2
