#!/usr/bin/env bash
# ============================================================================
#  mac_installer - MacBook (zsh) 環境セットアップスクリプト
#
#  要件: request/v1
#  対象: macOS + zsh
#
#  Usage:
#    ./install.sh <LICENSE_KEY> <EMAIL>
#    ./install.sh CCAGI-XXXX-XXXX user@example.com
#
#  Environment variables (optional):
#    CCAGI_SKIP_GH_AUTH=1   # gh auth login をスキップ
#    CCAGI_ASSUME_YES=1     # 全ての上書きプロンプトを Yes とみなす (default: 1)
# ============================================================================

set -Eeuo pipefail

# ----------------------------------------------------------------------------
# 引数チェック
# ----------------------------------------------------------------------------
usage() {
  cat <<'EOF'
Usage:
  install.sh <LICENSE_KEY> <EMAIL>

Arguments:
  LICENSE_KEY   CCAGI SDK ライセンスキー (ccagi-sdk activate に渡す)
  EMAIL         登録メールアドレス (ccagi-sdk activate 内で聞かれる)

Examples:
  ./install.sh CCAGI-ABCDE-12345 alice@example.com

Environment variables:
  CCAGI_SKIP_GH_AUTH=1   gh auth login をスキップ
  CCAGI_ASSUME_YES=1     上書きプロンプトを Yes とみなす (default: 1)
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

LICENSE_KEY="${1:-}"
EMAIL="${2:-}"

if [[ -z "$LICENSE_KEY" || -z "$EMAIL" ]]; then
  echo "❌ 引数が不足しています。" >&2
  echo "" >&2
  usage >&2
  exit 1
fi

if [[ ! "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
  echo "❌ EMAIL の形式が正しくありません: $EMAIL" >&2
  exit 1
fi

ASSUME_YES="${CCAGI_ASSUME_YES:-1}"

# ----------------------------------------------------------------------------
# ユーティリティ
# ----------------------------------------------------------------------------
STEP_TOTAL=11
STEP_NUM=0

# インストーラの source ディレクトリ (guard package の同梱位置)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log_step() {
  STEP_NUM=$((STEP_NUM + 1))
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "▶ [${STEP_NUM}/${STEP_TOTAL}] $1"
  echo "════════════════════════════════════════════════════════════"
}

log_info()  { echo "  ℹ $*"; }
log_ok()    { echo "  ✓ $*"; }
log_warn()  { echo "  ⚠ $*"; }
log_error() { echo "  ✗ $*" >&2; }

has_cmd() { command -v "$1" >/dev/null 2>&1; }

on_error() {
  local exit_code=$?
  local line_no=$1
  log_error "セットアップが失敗しました (line: ${line_no}, exit: ${exit_code})"
  log_error "エラー箇所を確認し、問題を修正して再実行してください。"
  exit "$exit_code"
}
trap 'on_error $LINENO' ERR

# ~/.zshrc への追記 (マーカーによる冪等化)
ZSHRC="$HOME/.zshrc"
touch "$ZSHRC"

append_zshrc_once() {
  local marker="$1"
  local block="$2"
  local begin="# >>> mac_installer: ${marker} >>>"
  local end="# <<< mac_installer: ${marker} <<<"

  if grep -Fq "$begin" "$ZSHRC" 2>/dev/null; then
    log_ok "~/.zshrc に登録済み: ${marker}"
    return 0
  fi

  {
    printf '\n%s\n' "$begin"
    printf '%s\n' "$block"
    printf '%s\n' "$end"
  } >> "$ZSHRC"
  log_ok "~/.zshrc に追記: ${marker}"
}

# ----------------------------------------------------------------------------
# macOS 検証
# ----------------------------------------------------------------------------
if [[ "$(uname -s)" != "Darwin" ]]; then
  log_error "このスクリプトは macOS 専用です (現在: $(uname -s))"
  exit 1
fi

echo "============================================================"
echo "  🍎 mac_installer - MacBook セットアップ"
echo "============================================================"
echo "  LICENSE_KEY : ${LICENSE_KEY:0:8}****"
echo "  EMAIL       : ${EMAIL}"
echo "  ~/.zshrc    : ${ZSHRC}"
echo "  ASSUME_YES  : ${ASSUME_YES}"
echo "============================================================"

# ============================================================================
# 1. Homebrew
# ============================================================================
log_step "Homebrew"
if has_cmd brew; then
  log_ok "brew は既にインストール済み ($(brew --version | head -1))"
else
  log_info "Homebrew をインストール中..."
  NONINTERACTIVE=1 /bin/bash -c \
    "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# brew を現セッションで有効化 + ~/.zshrc に登録
if [[ -x "/opt/homebrew/bin/brew" ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
  append_zshrc_once "brew-shellenv-arm64" \
    'eval "$(/opt/homebrew/bin/brew shellenv)"'
elif [[ -x "/usr/local/bin/brew" ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
  append_zshrc_once "brew-shellenv-x86_64" \
    'eval "$(/usr/local/bin/brew shellenv)"'
else
  log_error "brew の実行ファイルが見つかりません"
  exit 1
fi

# ============================================================================
# 2. jj (Jujutsu VCS)
# ============================================================================
log_step "jj (Jujutsu VCS)"
if has_cmd jj; then
  log_ok "jj は既にインストール済み ($(jj --version 2>/dev/null | head -1))"
else
  log_info "jj をインストール中..."
  brew install jj
fi

# ============================================================================
# 3. gh (GitHub CLI)
# ============================================================================
log_step "gh (GitHub CLI)"
if has_cmd gh; then
  log_ok "gh は既にインストール済み ($(gh --version | head -1))"
else
  log_info "gh をインストール中..."
  brew install gh
fi

# ============================================================================
# 4. gh 認証 (ブラウザ)
# ============================================================================
log_step "gh auth login (ブラウザ認証)"
if [[ "${CCAGI_SKIP_GH_AUTH:-0}" == "1" ]]; then
  log_warn "CCAGI_SKIP_GH_AUTH=1 のためスキップ"
elif gh auth status >/dev/null 2>&1; then
  log_ok "gh は既に GitHub 認証済み"
else
  log_info "ブラウザで GitHub 認証を行ってください..."
  log_info "画面の指示に従ってワンタイムコードを入力し、ブラウザで承認してください。"
  gh auth login --hostname github.com --git-protocol https --web
fi

# ============================================================================
# 5. nvm + Node.js 22
# ============================================================================
log_step "nvm + Node.js 22"

export NVM_DIR="$HOME/.nvm"

if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  log_ok "nvm は既にインストール済み"
else
  log_info "nvm v0.40.1 をインストール中..."
  curl -fsSL -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi

# nvm を現セッションで有効化
# shellcheck disable=SC1091
[[ -s "$NVM_DIR/nvm.sh" ]]            && . "$NVM_DIR/nvm.sh"
# shellcheck disable=SC1091
[[ -s "$NVM_DIR/bash_completion" ]]   && . "$NVM_DIR/bash_completion"

if ! has_cmd nvm; then
  log_error "nvm の読み込みに失敗しました"
  exit 1
fi

log_info "Node.js 22 をインストール中..."
nvm install 22
nvm use 22
nvm alias default 22
log_ok "node $(node --version) / npm $(npm --version)"

# nvm 初期化を ~/.zshrc に登録 (nvm のインストーラーが登録済みかもしれないが冪等に補完)
append_zshrc_once "nvm-init" 'export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"'

# ============================================================================
# 6. Playwright
# ============================================================================
log_step "Playwright"
if has_cmd playwright || npm ls -g --depth=0 playwright >/dev/null 2>&1; then
  log_ok "playwright は既にインストール済み"
else
  log_info "playwright を npm でグローバルインストール中..."
  npm install -g playwright
  log_info "playwright ブラウザバイナリを取得中..."
  npx --yes playwright install
fi

# ============================================================================
# 7. Claude Code
# ============================================================================
log_step "Claude Code"
if has_cmd claude; then
  log_ok "claude は既にインストール済み"
else
  log_info "Claude Code をインストール中..."
  curl -fSL https://claude.ai/install.sh | bash
fi

# Claude Code の代表的なインストール先を PATH に登録
CLAUDE_CANDIDATES=(
  "$HOME/.local/bin"
  "$HOME/.claude/local/bin"
  "$HOME/.claude/bin"
)
for p in "${CLAUDE_CANDIDATES[@]}"; do
  if [[ -d "$p" ]]; then
    case ":$PATH:" in
      *":$p:"*) ;;
      *) export PATH="$p:$PATH" ;;
    esac
    append_zshrc_once "path-claude-$(echo "$p" | tr '/' '_')" \
      "export PATH=\"$p:\$PATH\""
  fi
done

if ! has_cmd claude; then
  log_warn "claude コマンドが PATH 上に見つかりません。~/.zshrc を確認してください。"
fi

# ============================================================================
# 8. CC-AGI SDK
# ============================================================================
log_step "CC-AGI SDK"
if has_cmd ccagi-sdk; then
  log_ok "ccagi-sdk は既にインストール済み"
else
  log_info "ccagi-sdk をインストール中..."
  curl -fsSL https://ccagi-sdk-releases-661103479219.s3.ap-northeast-1.amazonaws.com/install.sh | bash
fi

# CC-AGI SDK の代表的なインストール先を PATH に登録
CCAGI_CANDIDATES=(
  "$HOME/.ccagi/bin"
  "$HOME/.ccagi-sdk/bin"
  "$HOME/.local/bin"
)
for p in "${CCAGI_CANDIDATES[@]}"; do
  if [[ -d "$p" ]]; then
    case ":$PATH:" in
      *":$p:"*) ;;
      *) export PATH="$p:$PATH" ;;
    esac
    append_zshrc_once "path-ccagi-$(echo "$p" | tr '/' '_')" \
      "export PATH=\"$p:\$PATH\""
  fi
done

if ! has_cmd ccagi-sdk; then
  log_error "ccagi-sdk コマンドが PATH 上に見つかりません。"
  log_error "手動で ~/.zshrc を確認するか、新しいターミナルを開いてから再実行してください。"
  exit 1
fi

# ============================================================================
# 9. CC-AGI SDK activate / setup-claude / onboard / doctor
# ============================================================================
log_step "CC-AGI SDK activate / setup-claude / onboard / doctor"

# ---- 9-1. activate: email をプロンプトへ流し込む -----------------------------
# ccagi-sdk activate は /dev/tty 直読みの TUI プロンプトのため、
# stdin へのパイプでは応答不可。expect 経由の pty 応答が必須。
# 日本語ロケール環境下では "メールアドレスを入力してください" が表示されるので
# 日英両対応のパターンで待ち受ける。
log_info "ccagi-sdk activate ${LICENSE_KEY:0:8}**** を実行中..."
if ! has_cmd expect; then
  log_error "expect が見つかりません (macOS 標準の /usr/bin/expect も無いようです)"
  log_error "brew install expect を実行してから再実行してください"
  exit 1
fi
/usr/bin/env expect <<EOF
set timeout 180
log_user 1
# CCAGI_LANG=english を掛けて英語プロンプトを優先させる (Japanese 環境の保険)
spawn env CCAGI_LANG=english ccagi-sdk activate "$LICENSE_KEY"
expect {
  -re {(?i)e-?mail|address|メール|アドレス} { send -- "$EMAIL\r"; exp_continue }
  timeout { puts stderr "\n\[activate\] email プロンプト待機タイムアウト"; exit 124 }
  eof
}
catch wait result
exit [lindex \$result 3]
EOF
log_ok "activate 完了"

# ---- 9-2. setup-claude: 上書きプロンプト全て Yes -----------------------------
log_info "ccagi-sdk setup-claude を実行中 (上書き=Yes)..."
if [[ "$ASSUME_YES" == "1" ]]; then
  yes | ccagi-sdk setup-claude || true
else
  ccagi-sdk setup-claude
fi
log_ok "setup-claude 完了"

# ---- 9-3. onboard --auto: 上書きプロンプト全て Yes ---------------------------
log_info "ccagi-sdk onboard --auto を実行中 (上書き=Yes)..."
if [[ "$ASSUME_YES" == "1" ]]; then
  yes | ccagi-sdk onboard --auto || true
else
  ccagi-sdk onboard --auto
fi
log_ok "onboard --auto 完了"

# ---- 9-4. doctor --fix: 修復プロンプト全て Yes -------------------------------
# script-non-interactive.md 3層防御:
#   L1 flag:    --fix --yes  (SDK ネイティブ非対話フラグ)
#   L2 yes:     yes | ...    (flag で拾えない Y/N を y 応答)
#   L3 timeout: timeout 180  (hang を有限化)
# PIPESTATUS[1] で timeout の rc のみ取得 (yes(1) SIGPIPE 141 を無視)
log_info "ccagi-sdk doctor --fix を実行中 (修復=Yes)..."
if [[ "$ASSUME_YES" == "1" ]]; then
  set +e
  yes | timeout 180 ccagi-sdk doctor --fix --yes
  DOCTOR_RC=${PIPESTATUS[1]}
  set -e
  case "$DOCTOR_RC" in
    0)   log_ok "doctor --fix 完了" ;;
    124) log_warn "doctor --fix タイムアウト (180s) — 続行" ;;
    *)   log_warn "doctor --fix が rc=$DOCTOR_RC で終了 — 続行" ;;
  esac
else
  ccagi-sdk doctor --fix || log_warn "doctor --fix が非0で終了 — 続行"
fi

# ============================================================================
# 10. プロジェクトディレクトリ作成 & 保護ゲート一式インストール
# ============================================================================
log_step "プロジェクトディレクトリ作成 & 保護ゲート一式インストール"

PROJECT_DATE="$(date +%Y%m%d)"
PROJECT_DIR="$HOME/dev/project-${PROJECT_DATE}"

log_info "プロジェクトディレクトリを作成: ${PROJECT_DIR}"
mkdir -p "$PROJECT_DIR"

# 保護ゲート一式 (4 パッケージ) を新規プロジェクトに自動インストール
# インストール順序 / CLAUDE.md 事前配置 / エラー継続方針は
# install-all-guards.sh に一元化 (DRY)。ここは委譲するだけ。
GUARDS_INSTALLER="$SCRIPT_DIR/install-all-guards.sh"
if [ -f "$GUARDS_INSTALLER" ]; then
  log_info "保護ゲート一式インストーラを実行: $GUARDS_INSTALLER → $PROJECT_DIR"
  if bash "$GUARDS_INSTALLER" "$PROJECT_DIR"; then
    log_ok "保護ゲート一式のインストール完了"
  else
    log_warn "保護ゲート一式インストーラが非 0 で終了。個別 installer を手動で再実行してください"
  fi
else
  log_warn "$GUARDS_INSTALLER が見つかりません。保護ゲートは未インストールです"
fi

# ============================================================================
# 11. Claude Code 起動
# ============================================================================
log_step "Claude Code 起動"

# ============================================================================
# 完了メッセージ
# ============================================================================
echo ""
echo "============================================================"
echo "  ✅ 全てのセットアップが完了しました 🎉"
echo "============================================================"
echo ""
echo "📌 動作確認 (別ターミナルで):"
echo "       brew --version"
echo "       jj --version"
echo "       gh --version"
echo "       node --version   # v22.x"
echo "       npx playwright --version"
echo "       claude --version"
echo "       ccagi-sdk --version"
echo ""
echo "📁 作業ディレクトリ: ${PROJECT_DIR}"
echo "🚀 Claude Code を起動します..."
echo ""

# ERR trap を解除 (claude 側の終了コードで install.sh が失敗扱いにならないように)
trap - ERR

cd "$PROJECT_DIR"
log_ok "cd ${PROJECT_DIR}"

if [ -t 1 ]; then
  # 対話 TTY: 現プロセスを claude に置き換え
  exec claude --dangerously-skip-permissions --model='claude-opus-4-7[1m]'
fi

# 非対話 (GUI インストーラー等): 追加の Terminal.app は起動しない。
# GUI 側でログを確認して次操作 (プロジェクト作成 or Claude 手動起動) へ遷移する想定。
log_ok "作業ディレクトリ準備完了: $PROJECT_DIR"
log_info "GUI に戻り、「CC AGI プロジェクトを作成」または任意のターミナルで 'claude' を実行してください。"
exit 0
