#!/usr/bin/env bash
# info-public-guard — installer (v0.2.0)
#
# 「ユーザーの明確な許可なく情報を公開・共有することは絶対禁止」ルールを
# 対象プロジェクトの CLAUDE.md に取込ませる。
#
# 使い方:
#   bash install.sh [対象プロジェクトの絶対パス]
set -Eeuo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
source "$SRC/../lib/common-install.sh"

cci_setup_target "${1:-}" "情報外部公開の禁止 (info-public-guard)" "$(cat "$SRC/VERSION" 2>/dev/null || echo unknown)"

# ルール配備
cci_place_file 0644 "$SRC/rules/info-public-guard.md" "$TARGET/.claude/rules/info-public-guard.md"

# CLAUDE.md 取込
cci_add_claudemd_import ".claude/rules/info-public-guard.md"

cat <<EOF

ルール要旨:
  「ユーザーの明確な許可なく情報を外部に公開・共有することは 絶対に絶対に絶対に禁止」
  (Artifact 自動生成 / Anthropic 社への情報共有 / 外部公開 URL 発行を含む)

次の手順:
  1. 新しい Claude Code セッションで CLAUDE.md が再読込されること
  2. Artifact 系 tool 呼び出し前に、必ずユーザー明示許可を確認する挙動になること
  3. 詳細ルール: $TARGET/.claude/rules/info-public-guard.md

EOF

cci_done_message "$SRC/uninstall.sh"
