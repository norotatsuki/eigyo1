#!/bin/bash
# CC AGI First Project アーカイブ生成スクリプト
#
# CC_AGI_Installer.command / scripts / install.sh / installer を zip 圧縮し、
# プロジェクトルートに ccagi-first-project-v<YYYYMMDD>.zip として出力する。
#
# 使い方:
#   ./scripts/pack-first-project.sh
#
# 環境変数:
#   PACK_OUT_DIR     出力ディレクトリ (デフォルト: プロジェクトルート)
#   PACK_DATE_STAMP  日付スタンプを固定 (デフォルト: date +%Y%m%d)

set -Eeuo pipefail

# ---- パス解決 (このスクリプトが install_packages/scripts/ 配下にある前提で PROJECT_ROOT を取得) ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ---- アーカイブ対象 (プロジェクトルート相対) ----
ITEMS=(
  "CC_AGI_Installer.command"
  "install_packages/install.sh"
  "install_packages/install-all-guards.sh"
  "install_packages/installer"
  "install_packages/scripts"
  "install_packages/ccagi-protocol-gate"
  "install_packages/info-public-guard"
  "install_packages/tdd-perfection-gate"
  "install_packages/plain-japanese-guard"
  "install_packages/README_開き方.txt"
)

# ---- 除外パターン (zip --exclude 用 glob) ----
EXCLUDES=(
  '*/__pycache__/*'
  '*.pyc'
  '*.pyo'
  '*/.DS_Store'
  '.DS_Store'
  'install_packages/installer/runs/*'
  'install_packages/installer/runs'
  '*/node_modules/*'
  '*/dist/*'
  '*/tools/browser-test-plus/node_modules/*'
  '*/tools/browser-test-plus/dist/*'
)

# ---- 出力先とファイル名 ----
OUT_DIR="${PACK_OUT_DIR:-$PROJECT_ROOT}"
DATE_STAMP="${PACK_DATE_STAMP:-$(date +%Y%m%d)}"
ZIP_NAME="ccagi-first-project-v${DATE_STAMP}.zip"
ZIP_PATH="$OUT_DIR/$ZIP_NAME"

# ---- 前提チェック: zip コマンド ----
if ! command -v zip >/dev/null 2>&1; then
  echo "❌ zip コマンドが見つかりません。macOS では標準搭載ですが、環境を確認してください。" >&2
  exit 1
fi

cd "$PROJECT_ROOT"

# ---- 対象存在チェック ----
missing=()
for item in "${ITEMS[@]}"; do
  [ -e "$item" ] || missing+=("$item")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "❌ 以下の対象が見つかりません (cwd=$PROJECT_ROOT):" >&2
  printf '   - %s\n' "${missing[@]}" >&2
  exit 2
fi

# ---- 既存 zip の扱い (同名を上書き) ----
if [ -e "$ZIP_PATH" ]; then
  echo "⚠️  既存アーカイブを削除します: $ZIP_PATH"
  rm -f "$ZIP_PATH"
fi

echo "==================================================================="
echo "  CC AGI First Project アーカイブ生成"
echo "  cwd    : $PROJECT_ROOT"
echo "  出力   : $ZIP_PATH"
echo "  対象   : ${ITEMS[*]}"
echo "  除外   : ${EXCLUDES[*]}"
echo "==================================================================="

# ---- zip 実行 ----
# -r  : recursive
# -y  : symlink を追跡せず保存 (macOS の .command 用)
# -X  : extra file attributes (macOS resource fork 等) を除去し、環境依存を最小化
zip -r -y -X "$ZIP_PATH" "${ITEMS[@]}" -x "${EXCLUDES[@]}"

# ---- 整合性検証 ----
echo ""
echo "-------------------------------------------------------------------"
echo "整合性検証 (zip -T)"
zip -T "$ZIP_PATH"

# ---- サマリ ----
echo ""
if command -v unzip >/dev/null 2>&1; then
  entry_count=$(unzip -Z1 "$ZIP_PATH" | wc -l | tr -d ' ')
  echo "エントリ数 : $entry_count"
fi
zip_size=$(du -h "$ZIP_PATH" | awk '{print $1}')
echo "サイズ     : $zip_size"

echo ""
echo "✅ 生成完了: $ZIP_PATH"
echo ""
echo "-------------------------------------------------------------------"
echo "📌 配布時の案内 (受信者の macOS で Gatekeeper に阻まれた場合):"
echo "   1) zip を展開したフォルダで Terminal を開き、次を実行:"
echo "        xattr -cr <展開したフォルダのパス>"
echo "   2) その後 CC_AGI_Installer.command をダブルクリック"
echo "   詳細手順は同梱の install_packages/README_開き方.txt を参照。"
echo "-------------------------------------------------------------------"
