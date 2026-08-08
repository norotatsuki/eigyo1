#!/usr/bin/env bash
# ============================================================================
# ccagi-bootstrap.sh
# ----------------------------------------------------------------------------
# request.md (Step #1 - #6) を完全自動化するオーケストレータ。
#
#   #1     ccagi-sdk のインストール + setup-claude + onboard --auto + doctor --fix
#   #2     ccagi-sdk init (対話プロンプトは自動で Yes 応答)
#   #3-5   強制ルール注入 (CLAUDE.md に @import 行を bash native で追加、冪等)
#   #6     Claude Code (対話モード) を起動 (`exec` でハンドオフ)
#
# 【設計上の重要決定】
#   Step #3-5 は元々 `claude -p` (one-shot) で Claude に CLAUDE.md 編集を依頼していたが、
#   これは以下の理由で不採用とした:
#     - モデル/MCP 起動オーバーヘッドで数分単位の待ち時間が発生し UX が壊れる
#     - AI に投げる必然性がない (定型のテキスト追記のみ)
#     - hang 時にリカバリが難しい
#   → 決定論的な bash native 実装に置き換え、AI 呼び出しなしで数十ミリ秒で完了する。
#
# 進捗は 10% 刻みで stderr に出力。冪等 (再実行可能)。fail-fast。
# ----------------------------------------------------------------------------
# 使い方:
#   bash scripts/ccagi-bootstrap.sh                  # 全ステップ
#   bash scripts/ccagi-bootstrap.sh --skip-install   # ccagi-sdk が既に入っている場合
#   bash scripts/ccagi-bootstrap.sh --skip-imports   # Step #3-5 (@import 注入) をスキップ
#   bash scripts/ccagi-bootstrap.sh --dry-run        # 実行内容だけ表示
#   bash scripts/ccagi-bootstrap.sh --no-exec        # 最後の Claude Code 起動をスキップ
#
# 環境変数:
#   CCAGI_MODEL                  Claude Code モデル (default: claude-opus-4-7[1m])
#   CCAGI_INSTALL_URL            インストーラ URL (default: request.md 記載の S3)
#   CCAGI_INIT_TIMEOUT_SEC       Step #2 の全体タイムアウト秒 (default: 300)
#   NO_COLOR                     セットすると色出力を無効化
#
# 強制 @import 対象ルール (Step #3-5):
#   scripts/lib/rules/*.md が SSOT。ファイルを add/remove するだけで
#   bootstrap は自動追従する (ハードコード配列は撤廃済み)。
#   project 側に無ければ自動 copy → @import。任意プロジェクトで動作。
#   claude-message.txt は human-readable spec として保持。
# ----------------------------------------------------------------------------

set -Eeuo pipefail

# ---- 定数 ------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# workspace root = install_packages/scripts の 2 つ上 (旧: 1 つ上)
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

CCAGI_INSTALL_URL_DEFAULT="https://ccagi-sdk-releases-661103479219.s3.ap-northeast-1.amazonaws.com/install.sh"
CCAGI_INSTALL_URL="${CCAGI_INSTALL_URL:-$CCAGI_INSTALL_URL_DEFAULT}"
CCAGI_MODEL="${CCAGI_MODEL:-claude-opus-4-7[1m]}"

# Step #3-5: CLAUDE.md に @import を保証するルール一覧 (SSOT ベース動的発見)
#
# 動作:
#   - scripts/lib/rules/*.md を SSOT として実行時に走査 (ハードコード撤廃)
#   - project 側の $PROJECT_ROOT/.claude/rules/<basename> が既に存在すれば尊重 (上書きしない)
#   - 存在しなければ scripts/lib/rules/<basename> の embed template から copy
#   - どちらも無ければ warn して skip (fatal にしない) — 任意プロジェクト対応
#
# 追加/削除が必要になったら:
#   scripts/lib/rules/ にファイルを add / remove するだけで自動追従。
#   このスクリプトの編集は不要 (SSOT drift の温床を構造的に排除)。
BOOTSTRAP_RULE_TEMPLATE_DIR="${SCRIPT_DIR}/lib/rules"

# ---- 引数 ------------------------------------------------------------------
SKIP_INSTALL=0
SKIP_IMPORTS=0
DRY_RUN=0
NO_EXEC=0
for arg in "$@"; do
    case "$arg" in
        --skip-install)                   SKIP_INSTALL=1 ;;
        --skip-imports|--skip-message)    SKIP_IMPORTS=1 ;;  # 旧 --skip-message も互換で受ける
        --dry-run)                        DRY_RUN=1 ;;
        --no-exec)                        NO_EXEC=1 ;;
        -h|--help)
            sed -n '2,35p' "$0"
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            exit 2
            ;;
    esac
done

# ---- 色 --------------------------------------------------------------------
if [[ -z "${NO_COLOR:-}" ]] && [[ -t 2 ]]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
    C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_BLUE=$'\033[34m'; C_DIM=$'\033[2m'
else
    C_RESET=""; C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""; C_DIM=""
fi

log()   { printf '%s[ccagi-bootstrap]%s %s\n' "$C_BLUE" "$C_RESET" "$*" >&2; }
ok()    { printf '%s[  OK  ]%s %s\n' "$C_GREEN" "$C_RESET" "$*" >&2; }
warn()  { printf '%s[ WARN ]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()   { printf '%s[ FAIL ]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
step()  { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET" >&2; }

progress() {
    # $1=percent  $2=label
    local pct="$1" label="$2"
    local filled=$(( pct / 5 ))     # 20 blocks total
    local bar=""
    local i
    for ((i=0; i<filled; i++));   do bar+="#"; done
    for ((i=filled; i<20; i++));  do bar+="."; done
    printf '%s[%3d%%]%s [%s] %s\n' "$C_BOLD" "$pct" "$C_RESET" "$bar" "$label" >&2
}

run() {
    # dry-run 対応の実行ラッパ
    if (( DRY_RUN )); then
        printf '%s$%s %s\n' "$C_DIM" "$C_RESET" "$*" >&2
        return 0
    fi
    "$@"
}

# グローバル ERR trap — SIGPIPE(141) / SIGINT(130) はスクリプトのバグではなく
# 「pipe consumer が先に終わって yes(1) が SIGPIPE で死んだ」等の正常動作なので除外する。
# この除外が無いと `yes | timeout cmd` パターンで疑陽性 "[FAIL]" を出す (2026-07-10 事故)。
trap '_rc=$?; { [[ $_rc == 141 ]] || [[ $_rc == 130 ]]; } || err "line $LINENO: command failed (exit $_rc): $BASH_COMMAND"' ERR

# ---- Non-interactive execution helper (3層防御 canonical pattern) ---------
# 全 CCAGI 系 sub-command を hang させずに実行する統一ヘルパ。
#   L1: 呼び出し側で --yes / --auto / --force などの skip-flag を渡す (best effort)
#   L2: yes(1) pipe で stdin を pipe 化し、CLI に非対話モードを検出させ、
#       残った Y/N prompt にも "y" を無限供給する。**stdin=pipe は child
#       process にも継承される**ので、内側で spawn される他 CLI (doctor が
#       内部で呼ぶ onboard/setup-claude 等) も同じく非対話モードで動く。
#   L3: timeout(1) で hang を有限時間 (default 300s) で強制終了 → fail-fast
#
# rc 判定:
#   0    → success
#   124  → timeout (未処理プロンプトが残っている疑い) — 呼び出し側で fatal 判定
#   141  → SIGPIPE (pipe consumer 側先終了、正常) — success 扱い
#   *    → 「既に処理済み」等の non-fatal ケース — warn して続行
#
# 過去実装 (expect(1)) は Tcl の UTF-8 handling で `›` inquirer prompt を
# 捕捉失敗して hang → 廃止。詳細: .claude/rules/script-non-interactive.md
_run_noninteractive() {
    local label="$1" timeout_sec="$2"
    shift 2
    if (( DRY_RUN )); then
        printf '%s$%s yes y | timeout %d %s\n' "$C_DIM" "$C_RESET" "$timeout_sec" "$*" >&2
        return 0
    fi
    # PIPESTATUS[1] で cmd 側の rc のみ抽出 (yes の SIGPIPE 141 は PIPESTATUS[0])
    # $TIMEOUT_CMD は preflight で timeout / gtimeout のうち利用可能な方に確定
    set +e
    yes y | "$TIMEOUT_CMD" "$timeout_sec" "$@"
    local rc=${PIPESTATUS[1]}
    set -e
    case "$rc" in
        0)   ok  "$label 完了 (rc=0)" ;;
        141) ok  "$label 完了 (rc=141, SIGPIPE 正常)" ;;
        124) err "$label が ${timeout_sec}s でタイムアウト — 未処理の対話プロンプトが残存している疑い"
             err "→ '$1 --help' で新規フラグを確認して呼出に追記してください"
             return 124 ;;
        *)   warn "$label が rc=$rc で終了 (既に処理済み等の可能性)。続行します" ;;
    esac
    return 0
}

# ---- Preflight (self-healing) ----------------------------------------------
# TIMEOUT_CMD: `timeout` / `gtimeout` のうち利用可能な方を格納するグローバル。
# _run_noninteractive はこれを経由するため、preflight で必ず確定させる。
TIMEOUT_CMD=""

# macOS で timeout(1) を自動導入する self-healing 関数。
# 目的: 顧客 Mac に coreutils が入っていないとき、preflight で
#       「brew install coreutils を実行してから再度お試しください」で中断せず、
#       その場で自動インストールして続行できるようにする (2026-07-15 再発防止)。
#
# 探索順:
#   1. timeout           (Linux / 一部の macOS 環境)
#   2. gtimeout          (Homebrew coreutils 標準)
#   3. brew install coreutils を試行 → 再検出
#   4. brew も無ければ Homebrew の install 手順を提示して exit
_ensure_timeout_cmd() {
    if command -v timeout >/dev/null 2>&1; then
        TIMEOUT_CMD="timeout"; return 0
    fi
    if command -v gtimeout >/dev/null 2>&1; then
        TIMEOUT_CMD="gtimeout"; return 0
    fi

    warn "timeout(1) / gtimeout(1) が見つかりません。coreutils を自動インストールします..."
    if ! command -v brew >/dev/null 2>&1; then
        err "Homebrew (brew) が導入されていません。以下の手順で先に Homebrew を入れてください:"
        err ""
        err "  /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        err ""
        err "その後、このスクリプトを再実行してください。"
        return 1
    fi

    log "brew install coreutils を実行 (数十秒〜数分かかります)"
    set +e
    brew install coreutils 2>&1 | tail -5
    local brew_rc=${PIPESTATUS[0]}
    set -e
    if (( brew_rc != 0 )); then
        warn "brew install coreutils が rc=$brew_rc で終了。既導入の可能性があります (続行)"
    fi

    # 再検出 (Homebrew の PATH が現行 shell に無いケースを想定して直接 PATH 補正も試行)
    for candidate_dir in "/opt/homebrew/bin" "/usr/local/bin" "/opt/homebrew/opt/coreutils/libexec/gnubin"; do
        [[ -d "$candidate_dir" ]] && export PATH="$candidate_dir:$PATH"
    done
    if command -v gtimeout >/dev/null 2>&1; then
        TIMEOUT_CMD="gtimeout"
        ok "gtimeout を検出 (coreutils 経由)。以降 gtimeout を使用します"
        return 0
    fi
    if command -v timeout >/dev/null 2>&1; then
        TIMEOUT_CMD="timeout"; return 0
    fi
    err "brew install coreutils 完了後も timeout/gtimeout が見つかりません。PATH を確認してください"
    err "  期待: /opt/homebrew/bin/gtimeout または /usr/local/bin/gtimeout"
    return 1
}

preflight() {
    step "Preflight"
    local missing=0
    # timeout は _ensure_timeout_cmd で self-heal 対応するため個別処理 (このループから除外)
    for cmd in curl bash awk grep yes; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            err "required command not found: $cmd"
            missing=1
        fi
    done
    (( missing == 0 )) || exit 3

    # timeout(1) は self-healing (無ければ brew install coreutils を自動試行)
    _ensure_timeout_cmd || exit 3

    ok "curl / bash / awk / grep / yes / $TIMEOUT_CMD available"
    ok "project root: $PROJECT_ROOT"
}

ensure_on_path() {
    # ccagi-sdk が PATH に無く、標準的な場所にある場合は PATH を補正
    if command -v ccagi-sdk >/dev/null 2>&1; then return 0; fi
    for candidate in "$HOME/.ccagi/bin" "$HOME/.local/bin" "/usr/local/bin" "/opt/homebrew/bin"; do
        if [[ -x "$candidate/ccagi-sdk" ]]; then
            export PATH="$candidate:$PATH"
            warn "PATH に $candidate を追加しました"
            return 0
        fi
    done
    return 1
}

# ---- Step 1: Install & Setup -----------------------------------------------
step1_install_and_setup() {
    step "Step #1: ccagi-sdk のインストール & セットアップ"
    progress 10 "install ccagi-sdk"

    if (( SKIP_INSTALL )); then
        warn "--skip-install が指定されたためインストールをスキップ"
    else
        # 既存インストールがあっても installer を必ず実行 (idempotent + 最新化のため)。
        # 旧実装は `command -v` で存在判定して skip していたが、それだと古いバージョンが
        # 残っている場合に更新されず「v4.22.25 のはずが v4.22.22 のまま」となる事故を招く。
        if command -v ccagi-sdk >/dev/null 2>&1; then
            log "既存 ccagi-sdk 検出 ($(command -v ccagi-sdk) $(ccagi-sdk --version 2>/dev/null | head -1)) — installer で最新化を試行"
        fi
        log "curl -fsSL '$CCAGI_INSTALL_URL' | bash を実行"
        # silent-fail 対策: curl 失敗 (URL 404 等) を bash の rc=0 に隠されないよう
        # PIPESTATUS[0] で curl 側の rc を直接確認する (fact-first-execution rule)。
        set +e
        run bash -c "set -o pipefail; curl -fsSL '$CCAGI_INSTALL_URL' | bash; exit \${PIPESTATUS[0]}"
        local install_rc=$?
        set -e
        if (( install_rc != 0 )); then
            err "installer 取得または実行に失敗 (curl rc=$install_rc)。URL / ネットワーク / 認可を確認してください: $CCAGI_INSTALL_URL"
            exit 5
        fi
        ensure_on_path || { err "インストール後も ccagi-sdk が PATH で見つかりません"; exit 5; }
        ok "ccagi-sdk インストール完了: $(command -v ccagi-sdk) ($(ccagi-sdk --version 2>/dev/null | head -1))"
    fi

    # 以下 3 コマンドは _run_noninteractive で 3 層防御:
    #   setup-claude: TTY 環境で "設定を上書きしますか? (y/n) ›" prompt が hang 元
    #                 (2026-07-10 Issue #2) → 必ず pipe stdin 化
    #   onboard --auto: 内部で setup-claude 相当を呼ぶ。stdin 継承させるため helper 経由
    #   doctor --fix --yes: --yes flag は「修復を実行しますか?」を skip するが、
    #                 HC-RAG-CCM fix が内部で ccagi-sdk onboard を spawn し、その中で
    #                 setup-claude の prompt が出て hang する (2026-07-10 実測)。
    #                 stdin=pipe を child にも継承させるため helper 経由
    progress 20 "ccagi-sdk setup-claude"
    _run_noninteractive "ccagi-sdk setup-claude" 60 ccagi-sdk setup-claude \
        || { err "Step #1 setup-claude で hang 検出 — abort"; exit 7; }

    progress 30 "ccagi-sdk onboard --auto"
    _run_noninteractive "ccagi-sdk onboard --auto" 300 ccagi-sdk onboard --auto \
        || { err "Step #1 onboard で hang 検出 — abort"; exit 7; }

    progress 40 "ccagi-sdk doctor --fix --yes"
    # doctor は "問題が残っていても続行" させる: rc != 0 でも warn 扱い、致命的でない
    _run_noninteractive "ccagi-sdk doctor --fix --yes" 180 ccagi-sdk doctor --fix --yes \
        || { err "Step #1 doctor で hang 検出 — abort"; exit 7; }

    # ---- brew 依存パッケージのインストール (idempotent) ----
    # 目的:
    #   coreutils: timeout(1) (gtimeout) を提供 — preflight で self-heal 済みだが
    #              初回未導入マシンでも Step #1 到達時に念のため再実行 (冪等)
    #   jj:        jujutsu 版管ツール — CCAGI SDK 想定の VCS
    # 既にインストール済みなら "Warning: <pkg> is already installed" で rc=0 (idempotent)。
    # brew 未導入マシンでは warn して skip (preflight で timeout が確保できていれば fatal にしない)。
    progress 45 "brew install coreutils / jj"
    if command -v brew >/dev/null 2>&1; then
        local pkg brew_rc
        for pkg in coreutils jj; do
            set +e
            brew install "$pkg" 2>&1 | tail -3
            brew_rc=${PIPESTATUS[0]}
            set -e
            case "$brew_rc" in
                0) ok "brew install $pkg 完了" ;;
                *) warn "brew install $pkg が rc=$brew_rc で終了。続行します" ;;
            esac
        done
    else
        warn "brew コマンドが見つかりません。coreutils/jj のインストールをスキップ (別途手動でご対応ください)"
    fi

    ok "Step #1 完了"
}

# ---- Step 2: ccagi-sdk init (fully non-interactive) ------------------------
# 「対話プロンプトは自動 Yes」仕様を 3 層防御で満たす:
#   L1: CLI フラグで skip 可能なプロンプトは flag で skip (--name, --no-issue)
#   L2: 残ったプロンプトには yes(1) で "y" を無限供給
#   L3: 万一 hang しても timeout(1) で 300 秒後に強制終了 (fail-fast)
# 過去 expect(1) 実装は Tcl 側の UTF-8 handling で "›" プロンプトを捉えられず
# hang → 廃止済み。詳細: .claude/rules/script-non-interactive.md
step2_init() {
    step "Step #2: ccagi-sdk init (非対話 — flags + yes + timeout 3層防御)"
    progress 50 "ccagi-sdk init"

    local project_name
    project_name="$(basename "$PROJECT_ROOT")"
    local init_args=(--name "$project_name" --no-issue)
    local init_timeout="${CCAGI_INIT_TIMEOUT_SEC:-300}"

    # helper 経由で L1(flags)+L2(yes pipe)+L3(timeout) を一括適用
    # rc=124 は fatal (未処理プロンプト残存)、rc=非0非124 は「既に init 済み」等で続行
    _run_noninteractive "ccagi-sdk init" "$init_timeout" ccagi-sdk init "${init_args[@]}" \
        || exit 7

    ok "Step #2 完了"
}

# ---- Step 3+4+5: CLAUDE.md への @import 注入 (bash native, deterministic) ---

# CLAUDE.md に "@import <rule>" 行を **pure append** で冪等に追加する。
#
# 【設計原則: ccagi-sdk init 生成物 不可侵】
#   ccagi-sdk init が生成した CLAUDE.md の内容 (ヘッダ、L0 セクション、既存
#   @import ブロック、フッタ) を **1 バイトも書き換えない**。
#
#   過去の awk rewrite 実装 (2026-07-10 aa44b5b 以前):
#     - CLAUDE.md 全体を tmp に書き出し → `mv $tmp $claude_md` で置換
#     - 「行順は保持されるが inode / mtime が変わる」
#     - ccagi-sdk が生成した本文を Claude が「削除・全書換」と誤認する事故
#       (Issue #4: 「ccagi-sdk init が生成したファイルに追記ではなく、
#        削除か、まるまるリライトしている」)
#
#   新実装:
#     - `>>` (append) のみで動作。既存行に触れる操作なし。
#     - Idempotent: 既に完全一致で入っていれば何もしない。
#     - 末尾改行欠落時のみ 1 行改行を append (これは 1 行の追記であり
#       全書換ではない)。ccagi-sdk 生成物の既存行内容は保存される。
#
#   Claude Code CLI は CLAUDE.md 内の @import を **行位置に依存せず** 検出する
#   ので、末尾追加で機能上の問題は一切ない。
_ensure_import_line() {
    local claude_md="$1" rule="$2"
    local newline="@import $rule"

    # 既に完全一致で入っていれば何もしない (idempotency)
    if grep -qxF "$newline" "$claude_md" 2>/dev/null; then
        return 0
    fi

    # 末尾改行の欠落を防ぐ小さな保護 (append 1 行なので rewrite ではない)
    if [[ -s "$claude_md" ]] && [[ "$(tail -c 1 "$claude_md")" != $'\n' ]]; then
        echo "" >> "$claude_md"
    fi

    # 常に末尾に append のみ (ccagi-sdk 生成物には手を触れない、rewrite 禁止)
    echo "$newline" >> "$claude_md"
}

# scripts/lib/rules/*.md を SSOT として rule 一覧を動的取得。
# 出力: 1 行 1 要素で ".claude/rules/<basename>" 形式のパスを stdout に。
#
# 設計原則:
#   - scripts/lib/rules/ (embed template dir) の *.md がそのまま SSOT
#   - 追加は「ファイルを置くだけ」、削除は「ファイルを消すだけ」で bootstrap は追従
#   - ハードコード配列を持たないので rule 増減で drift が発生しない
#   - template dir が無い / 空 → 空出力 (呼び出し側で件数 0 を検知して skip)
_discover_bootstrap_import_rules() {
    local template_dir="$BOOTSTRAP_RULE_TEMPLATE_DIR"
    [[ -d "$template_dir" ]] || return 0
    # sort -z で決定論的順序 (basename alphabetical) を保証
    while IFS= read -r -d '' f; do
        printf '.claude/rules/%s\n' "$(basename "$f")"
    done < <(find "$template_dir" -maxdepth 1 -type f -name '*.md' -print0 | sort -z)
}

step3_4_5_ensure_imports() {
    step "Step #3-5: CLAUDE.md に強制ルールの @import を注入 (bash native)"
    progress 60 "prepare"

    if (( SKIP_IMPORTS )); then
        warn "--skip-imports が指定されたため Step #3-5 をスキップ"
        progress 80 "skipped"
        return 0
    fi

    # SSOT (scripts/lib/rules/*.md) から強制 import rule 一覧を late-bound で populate。
    # 設計原則は line 340-347 参照 (ハードコード撤廃、追加/削除で自動追従)。
    # 0 件は fatal にせず warn: rule template を持たない任意プロジェクトでも bootstrap 続行。
    local -a BOOTSTRAP_IMPORT_RULES=()
    while IFS= read -r _rule; do
        [[ -n "$_rule" ]] && BOOTSTRAP_IMPORT_RULES+=("$_rule")
    done < <(_discover_bootstrap_import_rules)

    if (( ${#BOOTSTRAP_IMPORT_RULES[@]} == 0 )); then
        warn "SSOT rule template が空 ($BOOTSTRAP_RULE_TEMPLATE_DIR/*.md 0件) — @import 注入スキップ"
        progress 80 "no rules"
        return 0
    fi

    local claude_md="$PROJECT_ROOT/CLAUDE.md"

    # 1. CLAUDE.md 自体が無ければ最小テンプレで生成
    if [[ ! -f "$claude_md" ]]; then
        warn "CLAUDE.md が存在しないので生成します"
        if (( DRY_RUN )); then
            printf '%s$%s create %s\n' "$C_DIM" "$C_RESET" "$claude_md" >&2
        else
            {
                echo "# $(basename "$PROJECT_ROOT")"
                echo ""
                echo "CCAGI SDK プロジェクト。"
            } > "$claude_md"
            ok "CLAUDE.md を作成: $claude_md"
        fi
    fi

    # 2. 各ルールファイルの存在を確認 + template から自動 copy + @import を idempotent に追加
    #    - project に既存の rule があれば上書きしない (既存を尊重)
    #    - 無ければ scripts/lib/rules/<basename> の embed template から copy
    #    - template も無ければ warn して skip (fatal にせず任意プロジェクト対応)
    progress 70 "ensure rule files + @import lines"
    local added=0 already=0 copied=0 skipped=0
    for rule in "${BOOTSTRAP_IMPORT_RULES[@]}"; do
        local rule_path="$PROJECT_ROOT/$rule"
        local rule_basename
        rule_basename="$(basename "$rule")"
        local template_path="$BOOTSTRAP_RULE_TEMPLATE_DIR/$rule_basename"

        # (a) project 側に rule が無ければ template から copy
        if [[ ! -f "$rule_path" ]]; then
            if [[ -f "$template_path" ]]; then
                if (( DRY_RUN )); then
                    printf '%s$%s cp %s %s\n' "$C_DIM" "$C_RESET" "$template_path" "$rule_path" >&2
                else
                    mkdir -p "$(dirname "$rule_path")"
                    cp "$template_path" "$rule_path"
                fi
                ok "copied template: $rule ← lib/rules/$rule_basename"
                copied=$((copied + 1))
            else
                warn "rule template not found: lib/rules/$rule_basename — skip (@import $rule not injected)"
                skipped=$((skipped + 1))
                continue
            fi
        fi

        # (b) @import を idempotent に追加
        if grep -qxF "@import $rule" "$claude_md" 2>/dev/null; then
            ok "already @imported: $rule"
            already=$((already + 1))
        else
            if (( DRY_RUN )); then
                printf '%s$%s append "@import %s" to %s\n' \
                    "$C_DIM" "$C_RESET" "$rule" "$claude_md" >&2
            else
                _ensure_import_line "$claude_md" "$rule"
            fi
            ok "added @import:   $rule"
            added=$((added + 1))
        fi
    done

    # 3. 検証 (dry-run 時はスキップ; skip 済み rule は verify 対象外)
    progress 80 "verify"
    if (( ! DRY_RUN )); then
        for rule in "${BOOTSTRAP_IMPORT_RULES[@]}"; do
            local rule_path="$PROJECT_ROOT/$rule"
            # rule 自体が無い (template も無く skip された) 場合は verify 対象外
            [[ -f "$rule_path" ]] || continue
            if ! grep -qxF "@import $rule" "$claude_md"; then
                err "verify 失敗: @import $rule が CLAUDE.md に反映されていません"
                exit 6
            fi
        done
    fi

    ok "Step #3-5 完了 (added=$added, already=$already, copied=$copied, skipped=$skipped, total_rules=${#BOOTSTRAP_IMPORT_RULES[@]})"
}

# ---- Step 6: Relaunch Claude Code (interactive) ----------------------------
step6_relaunch() {
    step "Step #6: Claude Code を対話モードで再起動"
    progress 90 "hand off to interactive Claude Code"

    if (( NO_EXEC )); then
        warn "--no-exec が指定されたため、Claude Code の起動をスキップします"
        log  "手動起動: claude --dangerously-skip-permissions --model='${CCAGI_MODEL}'"
        progress 100 "done"
        return 0
    fi

    if (( DRY_RUN )); then
        printf '%s$%s exec claude --dangerously-skip-permissions --model=%q\n' \
            "$C_DIM" "$C_RESET" "$CCAGI_MODEL" >&2
        progress 100 "done (dry-run)"
        return 0
    fi

    progress 100 "launching Claude Code"
    ok "対話 Claude Code に制御を移譲します..."
    # exec でハンドオフ (このプロセスが Claude Code に置き換わる)
    exec claude --dangerously-skip-permissions --model="$CCAGI_MODEL"
}

# ---- Main ------------------------------------------------------------------
main() {
    progress 0 "bootstrap start"
    log "PROJECT_ROOT = $PROJECT_ROOT"
    log "MODEL        = $CCAGI_MODEL"
    log "DRY_RUN=$DRY_RUN  SKIP_INSTALL=$SKIP_INSTALL  SKIP_IMPORTS=$SKIP_IMPORTS  NO_EXEC=$NO_EXEC"

    preflight
    step1_install_and_setup
    step2_init
    step3_4_5_ensure_imports
    step6_relaunch
}

main "$@"
