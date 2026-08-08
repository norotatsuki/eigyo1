#!/usr/bin/env bash
# plain-japanese-guard — installer (v1.4.0)
#
# 使い方:
#   bash install.sh [対象プロジェクトの絶対パス]
#
# v1.4.0: 日本語入力時の最強化 (完了保護 OFF / 上限 999 / bypass 監査記録)
# v1.1.0: completion-safe mode (作業完了直前の BLOCK loop 抑止)
set -Eeuo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
source "$SRC/../lib/common-install.sh"

cci_setup_target "${1:-}" "平易日本語 検出係 (plain-japanese-guard)" "$(cat "$SRC/VERSION" 2>/dev/null || echo unknown)"

# rule
cci_place_file 0644 "$SRC/rules/plain-japanese.md" "$TARGET/.claude/rules/plain-japanese.md"

# lib (禁止語辞書 + 完了 pattern)
cci_place_file 0644 "$SRC/lib/jargon-list.txt" "$TARGET/.claude/lib/jargon-list.txt"
if [ ! -f "$TARGET/.claude/lib/jargon-completion-patterns.txt" ]; then
  cci_place_file 0644 "$SRC/lib/jargon-completion-patterns.txt" "$TARGET/.claude/lib/jargon-completion-patterns.txt"
else
  echo "  = .claude/lib/jargon-completion-patterns.txt は既存のため保護"
fi

# hooks
cci_place_file 0755 "$SRC/hooks/jargon-detect.sh" "$TARGET/.claude/hooks/jargon-detect.sh"
cci_place_file 0755 "$SRC/hooks/jargon-reset.sh"  "$TARGET/.claude/hooks/jargon-reset.sh"

# scripts
cci_place_file 0755 "$SRC/scripts/jargon-scan.sh" "$TARGET/scripts/jargon-scan.sh"

# .gitignore 追加
cci_add_gitignore_pattern ".claude/state/jargon-*.count" "$PACKAGE_NAME 内部カウンタ"
cci_add_gitignore_pattern ".claude/state/jargon-bypass-audit.log" "$PACKAGE_NAME 監査 log"

# CLAUDE.md 取込
cci_add_claudemd_import ".claude/rules/plain-japanese.md"

# settings.json 待避 + hook 3 件合流
cci_backup_settings_json
cci_add_settings_hook Stop             '${CLAUDE_PROJECT_DIR}/.claude/hooks/jargon-detect.sh' 10
cci_add_settings_hook UserPromptSubmit '${CLAUDE_PROJECT_DIR}/.claude/hooks/jargon-reset.sh'   5
cci_add_settings_hook SessionStart     '${CLAUDE_PROJECT_DIR}/.claude/hooks/jargon-reset.sh'   5

cat <<EOF

配備物:
  📄 .claude/rules/plain-japanese.md
  📚 .claude/lib/jargon-list.txt (250 語 + 推奨言換)
  🚧 .claude/hooks/jargon-detect.sh   (Stop hook)
  🔄 .claude/hooks/jargon-reset.sh    (UserPromptSubmit / SessionStart hook)
  🛠  scripts/jargon-scan.sh          (手動走査 CLI)

これで下記が強制されます:
  🎯 Claude 応答終了時に禁止カタカナ / ジャーゴンを走査
  🎯 検出時は exit 2 で応答終了拒否 + 言換候補提示
  🎯 「アサイン」「オンボーディング」「オルタナティブ」等 250 語を対象
  🎯 v1.4.0: 日本語入力時は 最強化モード (完了保護 OFF / 上限 999 / bypass 監査記録)
  🎯 v1.1.0: 完了場面検出時は自動 warn 降格 (日本語入力中は無効)
  🎯 v1.2.0: 同一やりとり内 阻止上限 5 回 (日本語入力中は 999 回 = 実質無制限)

例外指定:
  export CCAGI_JARGON_ACK=1                    # 日本語以外なら会話単位で bypass
                                                # 日本語入力中は 監査 log 記録 + 警告降格のみ
  export CCAGI_JARGON_MODE=warn                # 阻止ではなく警告のみ
  export CCAGI_JARGON_SKIP_ON_COMPLETION=0     # 完了保護 無効化
  export CCAGI_JARGON_MAX_STOP_BLOCKS=3        # 阻止上限を戻す
  export CCAGI_JARGON_FORCE_LANG=en            # 言語検出を強制上書き (テスト用)

手動走査:
  bash scripts/jargon-scan.sh docs/example.md
  echo "アサインしました" | bash scripts/jargon-scan.sh -

完了 pattern の追加 (プロジェクト固有):
  echo 'デプロイ完了' >> .claude/lib/jargon-completion-patterns.txt

EOF

cci_done_message "$SRC/uninstall.sh"
