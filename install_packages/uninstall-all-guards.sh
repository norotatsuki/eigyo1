#!/usr/bin/env bash
# uninstall-all-guards.sh — 4 保護 一式 を 1 命令 で 一括 削除
#
# 対象 (逆順で削除、依存関係の逆方向で安全):
#   1. plain-japanese-guard  (禁止 カタカナ / ジャーゴン 検出 割込動作)
#   2. tdd-perfection-gate   (完璧 テスト駆動 6 ルール + 4 CLI + 3 割込動作)
#   3. ccagi-protocol-gate   (CLAUDE.md STEP 1-6 強制 割込動作)
#   4. info-public-guard     (情報 外部公開 の 禁止 ルール)
#
# 使い方:
#   bash uninstall-all-guards.sh [対象プロジェクトの絶対パス] [--yes] [--verbose]
#
# 対象を省略すると現在の 作業 場所 に対して削除。
# 各 uninstaller は idempotent。 CLAUDE.md / settings.json は自動 待避。
#
# --yes を付けない場合は削除前に確認プロンプトを出す。
# --verbose で削除内容を詳細表示。
#
# 終了 コード:
#   0 = 全 4 パッケージ 削除成功
#   1 = 1 個以上失敗 (詳細は stdout 参照)
set -Eeuo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET=""
ASSUME_YES=0
VERBOSE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y)     ASSUME_YES=1; shift ;;
    --verbose|-v) VERBOSE=1; shift ;;
    -h|--help)
      grep -E '^# ' "$0" | sed 's/^# //'
      exit 0
      ;;
    -*)
      echo "❌ 未知の 引数: $1" >&2
      exit 1
      ;;
    *)
      if [ -z "$TARGET" ]; then
        TARGET="$1"
      else
        echo "❌ 対象を複数指定できません" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

TARGET="${TARGET:-$(pwd)}"

if [ ! -d "$TARGET" ]; then
  echo "❌ 対象が見つかりません: $TARGET" >&2
  exit 1
fi

# 逆順 (install-all-guards.sh の 逆) で 削除
# 形式: "名前::uninstaller ファイル名"
PKGS=(
  "plain-japanese-guard::uninstall.sh"
  "tdd-perfection-gate::uninstall.sh"
  "ccagi-protocol-gate::uninstall.sh"
  "info-public-guard::uninstall.sh"
)

echo "============================================================"
echo "  🗑  CC AGI 保護一式 — 一括 削除"
echo "     取込先: $TARGET"
echo "     順序:   plain-japanese → tdd → protocol → info-public"
echo "============================================================"

# 事前確認 (--yes なら省略)
if [ "$ASSUME_YES" != "1" ]; then
  echo ""
  echo "⚠️  以下の 4 保護 一式 を $TARGET から削除します:"
  for spec in "${PKGS[@]}"; do
    name="${spec%%::*}"
    echo "   - $name"
  done
  echo ""
  echo "   削除される 主な 物:"
  echo "   - .claude/rules/ 内の 該当 ルール ファイル"
  echo "   - .claude/hooks/ 内の 該当 割込動作 (jargon-*, perfect-tdd-*, protocol-*)"
  echo "   - .claude/lib/jargon-list.txt / jargon-completion-patterns.txt"
  echo "   - scripts/ 内の 該当 補助 CLI"
  echo "   - .claude/settings.json 内の 該当 割込動作 定義 (待避 後 除去)"
  echo "   - CLAUDE.md 内の 該当 @import 行 (待避 後 除去)"
  echo ""
  echo "   保持される 物:"
  echo "   - .claude/state/ 直下の 動作目印 (別途 手動 削除)"
  echo "   - .gitignore に追加した 行 (別途 手動 削除)"
  echo ""
  read -rp "続行しますか? [y/N]: " reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "🛑 削除を中止しました。"; exit 0 ;;
  esac
fi

FAILED=0
SUCCEEDED=()

for spec in "${PKGS[@]}"; do
  name="${spec%%::*}"
  script="${spec##*::}"
  path="$SRC/$name/$script"

  echo ""
  echo "------------------------------------------------------------"
  echo "  🗑  $name"
  echo "------------------------------------------------------------"

  if [ ! -f "$path" ]; then
    echo "  ⚠ $path が見つかりません (skip)"
    continue
  fi

  if [ "$VERBOSE" = "1" ]; then
    bash "$path" "$TARGET"
    rc=$?
  else
    output="$(bash "$path" "$TARGET" 2>&1)"
    rc=$?
    echo "$output" | grep -E "^  ✓|^  ✗|^❌|^✅" | head -20
  fi

  if [ "$rc" = "0" ]; then
    SUCCEEDED+=("$name")
  else
    echo "  ❌ $name 削除で 異常 終了 (rc=$rc)"
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "============================================================"
if [ "$FAILED" = "0" ]; then
  echo "  ✅ 全 ${#SUCCEEDED[@]} 保護 一式 の 削除 に 成功しました"
  echo ""
  echo "  残っているかもしれない 物 (必要なら 手動 で 削除):"
  echo "    - $TARGET/.claude/state/  (動作目印 全般)"
  echo "    - $TARGET/tools/browser-test-plus/  (tdd 検証 補助)"
  echo "    - $TARGET/.gitignore  の 追記 行"
  echo "    - $TARGET/CLAUDE.md.bak.*  (削除時 待避 ファイル)"
  echo "    - $TARGET/.claude/settings.json.bak.*  (削除時 待避 ファイル)"
  echo "============================================================"
  exit 0
else
  echo "  ⚠️  ${FAILED} 個 の 保護 一式 で 削除 が 完全に 成功しませんでした"
  echo "     成功: ${SUCCEEDED[*]:-なし}"
  echo "============================================================"
  exit 1
fi
