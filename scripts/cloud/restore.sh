#!/usr/bin/env bash
#
# R2 の控えから DB を建て直す。
#
# VM が消えても、素の Ubuntu から次の順で戻せる:
#   provision.sh  →  restore.sh  →  アプリ起動
#
#   使い方:
#     bash scripts/cloud/restore.sh                 # R2 の最新を別 DB へ戻して確かめる
#     bash scripts/cloud/restore.sh --into eigyo    # 本番 DB へ戻す (中身を置き換える)
#     bash scripts/cloud/restore.sh --file x.zst    # 手元のファイルから戻す
#
# 既定では **別の DB** へ戻す。復元の練習で本番を壊さないため。
set -uo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] && { set -a; . ./.env; set +a; }

BUCKET=${R2_BUCKET:-eigyo1-backup}
ACCOUNT=${R2_ACCOUNT_ID:-}
KEY=${R2_ACCESS_KEY_ID:-}
SECRET=${R2_SECRET_ACCESS_KEY:-}
TARGET=eigyo_restore_test
FILE=""
WORK=${WORK:-/tmp/eigyo-restore}

while [ $# -gt 0 ]; do
  case "$1" in
    --into) TARGET="$2"; shift 2 ;;
    --file) FILE="$2"; shift 2 ;;
    *) echo "知らない指定: $1"; exit 1 ;;
  esac
done

say() { printf '[復元] %s  %s\n' "$(date '+%H:%M:%S')" "$1"; }
die() { say "★失敗: $1"; exit 1; }
mkdir -p "$WORK"

if [ -z "$FILE" ]; then
  [ -n "$ACCOUNT" ] || die "R2 の鍵がありません (--file で手元のファイルを指定してください)"
  export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$KEY" RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$SECRET"
  export RCLONE_CONFIG_R2_ENDPOINT="https://${ACCOUNT}.r2.cloudflarestorage.com"
  latest=$(rclone lsf "R2:${BUCKET}/" | grep -E '^eigyo-.*\.dump\.zst$' | sort -r | head -1)
  [ -n "$latest" ] || die "R2 に控えがありません"
  say "R2 から取ります: $latest"
  rclone copy "R2:${BUCKET}/$latest" "$WORK/" || die "取れませんでした"
  FILE="$WORK/$latest"
fi

say "中身を確かめます"
zstd -t "$FILE" || die "圧縮ファイルが壊れています"

say "$TARGET へ戻します"
dump="$WORK/$(basename "${FILE%.zst}")"
zstd -dc "$FILE" > "$dump" || die "展開できませんでした"

# 戻す先を作り直す (本番を指定したときだけ中身が置き換わる)
#
# 繋がるかの確認は必ず接続先を指定する。指定しないと利用者名と同じ名前の
# DB を探しに行き、それが無い環境では「繋がりません」と誤って言う
# (実際に誤判定した)。postgres は必ずある DB なのでそこを見る。
psql -d postgres -tAc "SELECT 1" >/dev/null 2>&1 || die "PostgreSQL に繋がりません"
dropdb --if-exists "$TARGET" 2>/dev/null
createdb "$TARGET" || die "$TARGET を作れませんでした"

t0=$(date +%s)
# 並列で戻す。索引作りが一番重いので効く
pg_restore --no-owner --no-privileges -j 2 -d "$TARGET" "$dump" 2>&1 | grep -v "^pg_restore: 処理中" | tail -5
say "戻しました ($(( $(date +%s) - t0 )) 秒)"

say "中身を数えます"
psql -d "$TARGET" -c "
  SELECT '法人' AS 対象, COUNT(*) AS 件数 FROM corporations
  UNION ALL SELECT 'メール',    COUNT(*) FROM company_profiles WHERE contact_email IS NOT NULL
  UNION ALL SELECT 'フォーム',  COUNT(*) FROM company_profiles WHERE contact_form_url IS NOT NULL
  UNION ALL SELECT '代表者',    COUNT(*) FROM company_profiles WHERE representative IS NOT NULL
  UNION ALL SELECT 'SNS',       COUNT(*) FROM company_profiles WHERE social_links IS NOT NULL
  UNION ALL SELECT 'サイト',    COUNT(*) FROM company_profiles WHERE website_url IS NOT NULL;"

rm -f "$dump"
say "終わりました。数が想定どおりなら、この控えは使えます"
