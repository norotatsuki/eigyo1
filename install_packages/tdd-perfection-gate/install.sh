#!/usr/bin/env bash
# tdd-perfection-gate — installer (v1.3.0)
#
# 使い方:
#   bash install.sh [対象プロジェクトの絶対パス]
set -Eeuo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
source "$SRC/../lib/common-install.sh"

VERSION="$(cat "$SRC/VERSION" 2>/dev/null || echo unknown)"
cci_setup_target "${1:-}" "完璧テスト駆動門 (tdd-perfection-gate)" "$VERSION"

# ---- ルール群 (6 個) --------------------------------------------------------
RULES=(
  sequence-complete-verify
  no-invented-symbols
  audit-trail-mandatory
  verdict-vocabulary
  pre-verdict-self-audit
  perfect-tdd-trigger
)
for r in "${RULES[@]}"; do
  cci_place_file 0644 "$SRC/rules/${r}.md" "$TARGET/.claude/rules/${r}.md"
done

# ---- 補助 CLI (4 個) --------------------------------------------------------
SCRIPTS=(
  ccagi-pre-verdict-audit.sh
  ccagi-verify-uc-coverage.sh
  ccagi-arrow-verify.sh
  ccagi-zero-bug-loop.sh
)
for s in "${SCRIPTS[@]}"; do
  cci_place_file 0755 "$SRC/scripts/${s}" "$TARGET/scripts/${s}"
done

# ---- 割込動作 (3 個) --------------------------------------------------------
HOOKS=(
  perfect-tdd-detector.sh
  perfect-tdd-stop-gate.sh
  perfect-tdd-defer-detector.sh
)
for h in "${HOOKS[@]}"; do
  cci_place_file 0755 "$SRC/hooks/${h}" "$TARGET/.claude/hooks/${h}"
done

# ---- 検証補助 (browser-test-plus) ------------------------------------------
HELPER_DEST="$TARGET/tools/browser-test-plus"
mkdir -p "$HELPER_DEST"
cp -R "$SRC/helpers/browser-test-plus/." "$HELPER_DEST/"
echo "  ✓ tools/browser-test-plus/ (npm install --save-dev で有効化)"

# ---- .gitignore 追記 -------------------------------------------------------
cci_add_gitignore_pattern ".claude/state/tdd-*.turn" "$PACKAGE_NAME 動作目印"
cci_add_gitignore_pattern ".claude/state/perfect-tdd-*.turn" "$PACKAGE_NAME 動作目印"
cci_add_gitignore_pattern ".claude/state/perfect-tdd-*.count" "$PACKAGE_NAME 計数器"
cci_add_gitignore_pattern ".claude/state/zero-bug-logs/" "$PACKAGE_NAME バグ零繰返し記録"

# ---- CLAUDE.md 取込 (6 rule) ------------------------------------------------
for r in "${RULES[@]}"; do
  cci_add_claudemd_import ".claude/rules/${r}.md" "$PACKAGE_NAME v$VERSION"
done

# ---- settings.json に 3 個の割込動作を合流 ----------------------------------
cci_backup_settings_json
cci_add_settings_hook UserPromptSubmit 'bash "${CLAUDE_PROJECT_DIR}/.claude/hooks/perfect-tdd-detector.sh"' 5
cci_add_settings_hook Stop             'bash "${CLAUDE_PROJECT_DIR}/.claude/hooks/perfect-tdd-stop-gate.sh"' 10
cci_add_settings_hook Stop             'bash "${CLAUDE_PROJECT_DIR}/.claude/hooks/perfect-tdd-defer-detector.sh"' 5

cat <<EOF

配備物:
  📄 .claude/rules/ に 6 ルール (v1.0.0 5 + v1.1.0 1)
  🛠  scripts/ に 4 補助 CLI (v1.0.0 2 + v1.1.0 2)
  🎯 .claude/hooks/ に 3 割込動作 (v1.1.0 2 + v1.2.0 1)
  ⚙  .claude/settings.json (割込動作 3 個登録済み)
  📦 tools/browser-test-plus/ (npm install --save-dev で有効化)

構造的に強制されること:
  🎯 「合格」宣言前に 4 階層の動作確認 (入力 / 情報保管 差分 / 外部 / 監査) を要求
  🎯 使用場面書 ↔ 試験 の 1 対 1 対応確認
  🎯 Claude が発明した記号 (F1-F13 等) を警告検出
  🎯 「完璧なテスト駆動開発」等の号令をユーザー入力送信時に自動検出
  🎯 号令発火時、応答終了門が矢印別目印 全数 + バグ零目印 を強制
  🎯 応答終了時「defer / 別セッション / 48時間残」等の途中打切り言葉を阻止

推奨: 併せて ccagi-protocol-gate v0.5.0+ を導入してください。
  bash install_packages/ccagi-protocol-gate/gate_install.sh

EOF

cci_done_message "$SRC/uninstall.sh"
