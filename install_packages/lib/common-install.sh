#!/usr/bin/env bash
# common-install.sh — 4 ゲート同梱物の共通導入手順ライブラリ
#
# 各 install.sh から source して以下の関数を利用する:
#   cci_setup_target        — 引数から TARGET を確定、存在確認、見出し表示
#   cci_place_file          — ファイル 1 個を配置 (mkdir + install -m)
#   cci_place_files         — ファイル複数一括 (相対パス列挙)
#   cci_add_claudemd_import — CLAUDE.md に @import 行を idempotent 追記
#   cci_ensure_settings_json — settings.json 未作成なら skeleton 生成
#   cci_backup_settings_json — settings.json のタイムスタンプ付き待避
#   cci_add_settings_hook   — settings.json に hook 定義を idempotent 合流
#   cci_add_gitignore_pattern — .gitignore に無ければ追記
#   cci_done_message        — 導入完了メッセージ + アンインストール手順
#
# 呼び出し例:
#   SRC="$(cd "$(dirname "$0")" && pwd)"
#   source "$SRC/../lib/common-install.sh"
#   cci_setup_target "$@" "plain-japanese-guard" "$(cat "$SRC/VERSION")"
#   cci_place_file 0644 "$SRC/rules/plain-japanese.md" "$TARGET/.claude/rules/plain-japanese.md"
#   cci_add_settings_hook Stop '${CLAUDE_PROJECT_DIR}/.claude/hooks/jargon-detect.sh' 10
#   cci_done_message "$SRC/uninstall.sh"

# guard: 二重 source 抑止
if [ -n "${CCI_COMMON_INSTALL_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCI_COMMON_INSTALL_LOADED=1

# ---- 共通変数 (呼び出し側で TARGET を上書きされる) -----------------------
TARGET=""
PACKAGE_NAME=""
PACKAGE_VERSION=""

# ---- 対象プロジェクトを確定して見出し表示 ---------------------------------
# 使い方: cci_setup_target "$1" "<package name>" "<version>"
cci_setup_target() {
  local target="${1:-$(pwd)}"
  local name="${2:-unknown-package}"
  local ver="${3:-unknown}"
  if [ ! -d "$target" ]; then
    echo "❌ 対象プロジェクトが見つかりません: $target" >&2
    exit 1
  fi
  TARGET="$target"
  PACKAGE_NAME="$name"
  PACKAGE_VERSION="$ver"
  echo "📦 $PACKAGE_NAME — 導入手順 (v$PACKAGE_VERSION)"
  echo "   取込先: $TARGET"
  echo ""
}

# ---- ファイル 1 個を配置 (idempotent) -----------------------------------
# 使い方: cci_place_file <mode> <src> <dst>
cci_place_file() {
  local mode="$1"
  local src="$2"
  local dst="$3"
  if [ ! -f "$src" ]; then
    echo "  ❌ 取込元不明: $src" >&2
    return 1
  fi
  mkdir -p "$(dirname "$dst")"
  install -m "$mode" "$src" "$dst"
  # TARGET からの相対 path で表示 (見やすさ)
  local rel="${dst#$TARGET/}"
  echo "  ✓ $rel"
}

# ---- ファイル複数一括 (共通 src dir + dst dir) ---------------------------
# 使い方: cci_place_files <mode> <src_dir> <dst_dir> <file1> [<file2> ...]
cci_place_files() {
  local mode="$1"; shift
  local src_dir="$1"; shift
  local dst_dir="$1"; shift
  for f in "$@"; do
    cci_place_file "$mode" "$src_dir/$f" "$dst_dir/$f"
  done
}

# ---- CLAUDE.md に @import 行を idempotent 追記 --------------------------
# 使い方: cci_add_claudemd_import <rule_path> [comment]
#   rule_path: .claude/rules/foo.md のような 相対 path
#   comment:   コメント見出し (省略時: パッケージ名を利用)
cci_add_claudemd_import() {
  local rule_path="$1"
  local comment="${2:-$PACKAGE_NAME v$PACKAGE_VERSION (auto-added on install)}"
  local claude_md="$TARGET/CLAUDE.md"
  local import_line="@import $rule_path"

  if [ ! -f "$claude_md" ]; then
    echo "  ⚠ CLAUDE.md が見つかりません。手動で追記してください: $import_line"
    return 0
  fi

  if grep -qxF "$import_line" "$claude_md"; then
    echo "  = CLAUDE.md に $rule_path は既に取込済み"
    return 0
  fi

  {
    printf '\n<!-- %s -->\n' "$comment"
    printf '%s\n' "$import_line"
  } >> "$claude_md"
  echo "  ✓ CLAUDE.md に $rule_path を取込追記"
}

# ---- settings.json 未作成時に skeleton 生成 ------------------------------
# 使い方: cci_ensure_settings_json
cci_ensure_settings_json() {
  local settings="$TARGET/.claude/settings.json"
  mkdir -p "$TARGET/.claude"
  if [ ! -f "$settings" ]; then
    cat > "$settings" <<'JSON'
{
  "hooks": {}
}
JSON
    echo "  ✓ .claude/settings.json を新規作成"
  fi
}

# ---- settings.json のタイムスタンプ付き待避 -----------------------------
# 使い方: cci_backup_settings_json
cci_backup_settings_json() {
  local settings="$TARGET/.claude/settings.json"
  local backup="$settings.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  if [ -f "$settings" ]; then
    cp "$settings" "$backup"
    echo "  ✓ settings.json 待避: ${backup##*/}"
  fi
}

# ---- settings.json に 割込動作 定義を合流 -------------------------------
# 使い方: cci_add_settings_hook <event> <command> [timeout] [matcher]
#   event:   Stop / UserPromptSubmit / SessionStart / PreToolUse / PostToolUse など
#   command: 実 コマンド (絶対パス or ${CLAUDE_PROJECT_DIR} 相対)
#   timeout: 秒 (既定 10)
#   matcher: 対象 ツール 名の 論理和 (例: "Read|Edit|Write|Bash"、既定 "" = 全対象)
cci_add_settings_hook() {
  local event="$1"
  local command="$2"
  local timeout="${3:-10}"
  local matcher="${4:-}"
  local settings="$TARGET/.claude/settings.json"

  cci_ensure_settings_json

  SETTINGS_PATH="$settings" EVENT="$event" COMMAND="$command" TIMEOUT="$timeout" MATCHER="$matcher" python3 - <<'PY'
import json, os, sys
path = os.environ["SETTINGS_PATH"]
event = os.environ["EVENT"]
command = os.environ["COMMAND"]
timeout = int(os.environ["TIMEOUT"])
matcher = os.environ.get("MATCHER", "")

with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

hooks = data.setdefault("hooks", {})
entries = hooks.setdefault(event, [])

# matcher 一致の入口を探す (無ければ作成)
entry = None
for e in entries:
    if matcher:
        if e.get("matcher", "") == matcher:
            entry = e
            break
    else:
        if "matcher" not in e or e.get("matcher", "") == "":
            entry = e
            break

if entry is None:
    entry = {"hooks": []}
    if matcher:
        entry["matcher"] = matcher
    entries.append(entry)

hook_list = entry.setdefault("hooks", [])
for h in hook_list:
    if h.get("command") == command:
        label = f"{event}" + (f" (matcher={matcher})" if matcher else "")
        print(f"  = settings.json: {label} 割込動作 既に登録済み")
        sys.exit(0)

hook_list.append({"type": "command", "command": command, "timeout": timeout})

with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")

label = f"{event}" + (f" (matcher={matcher})" if matcher else "")
print(f"  ✓ settings.json: {label} 割込動作 追加 (timeout={timeout}s)")
PY
}

# ---- settings.json から 割込動作 を削除 (旧版 移行 用) -------------------
# 使い方: cci_remove_settings_hook <event> <command>
cci_remove_settings_hook() {
  local event="$1"
  local command="$2"
  local settings="$TARGET/.claude/settings.json"
  [ ! -f "$settings" ] && return 0

  SETTINGS_PATH="$settings" EVENT="$event" COMMAND="$command" python3 - <<'PY'
import json, os
path = os.environ["SETTINGS_PATH"]
event = os.environ["EVENT"]
command = os.environ["COMMAND"]

with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

hooks = data.get("hooks", {})
entries = hooks.get(event)
if not entries:
    exit(0)

removed = 0
for e in entries:
    before = len(e.get("hooks", []))
    e["hooks"] = [h for h in e.get("hooks", []) if h.get("command") != command]
    removed += before - len(e["hooks"])

# 空になった入口を掃除
hooks[event] = [e for e in entries if e.get("hooks")]
if not hooks[event]:
    del hooks[event]

with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")

if removed:
    print(f"  ✓ settings.json: {event} 割込動作 {removed} 件削除 (移行)")
PY
}

# ---- .gitignore に無ければ追記 -------------------------------------------
# 使い方: cci_add_gitignore_pattern <pattern> [comment]
cci_add_gitignore_pattern() {
  local pattern="$1"
  local comment="${2:-$PACKAGE_NAME v$PACKAGE_VERSION}"
  local gi="$TARGET/.gitignore"
  [ ! -f "$gi" ] && return 0
  if ! grep -qxF "$pattern" "$gi"; then
    printf '\n# %s\n%s\n' "$comment" "$pattern" >> "$gi"
    echo "  ✓ .gitignore に $pattern 追記"
  fi
}

# ---- 導入完了メッセージ ---------------------------------------------------
# 使い方: cci_done_message <uninstaller_path>
cci_done_message() {
  local uninstaller="$1"
  cat <<EOF

✅ 導入完了 ($PACKAGE_NAME v$PACKAGE_VERSION)

削除手順:
  bash $uninstaller $TARGET
EOF
}
