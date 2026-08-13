#!/usr/bin/env bash
#
# PostgreSQL を Cloudflare R2 へ毎日置く。
#
#   pg_dump -Fc  →  zstd  →  R2
#
# 「上げ終わった」で終わりにしない。上げた後に R2 から読み直し、
# 大きさが合っているかを確かめる。合わなければ失敗として扱う。
#
# 世代は R2 の無料枠 (10GB/月) に収まる数だけ残す。実測の圧縮後サイズから
# 何世代置けるかを自分で決め、それより古いものを消す。
#
#   使い方: bash scripts/cloud/backup-postgres.sh
#   設定  : .env に DATABASE_URL と R2_* を書く (git には載せない)
set -uo pipefail
cd "$(dirname "$0")/../.."

[ -f .env ] && { set -a; . ./.env; set +a; }

DB_URL=${DATABASE_URL:-}
BUCKET=${R2_BUCKET:-eigyo1-backup}
ACCOUNT=${R2_ACCOUNT_ID:-}
KEY=${R2_ACCESS_KEY_ID:-}
SECRET=${R2_SECRET_ACCESS_KEY:-}
# R2 の無料枠 10GB を超えない範囲で置ける世代数 (実測サイズから下で決め直す)
FREE_GB=${R2_FREE_GB:-10}
MAX_KEEP=${MAX_KEEP:-7}
OUT_DIR=${OUT_DIR:-/var/backups/eigyo1}
LOG=${BACKUP_LOG:-/var/log/eigyo1-backup.log}

say() { printf '[控え] %s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" | tee -a "$LOG"; }
die() { say "★失敗: $1"; exit 1; }

mkdir -p "$OUT_DIR" "$(dirname "$LOG")" 2>/dev/null || true
[ -n "$DB_URL" ] || die "DATABASE_URL がありません"

stamp=$(date +%Y%m%d-%H%M)
name="eigyo-${stamp}.dump.zst"
path="$OUT_DIR/$name"

say "取り出します (pg_dump -Fc)"
t0=$(date +%s)
# -Fc は独自形式。pg_restore で表ごとの復元や並列復元ができる
pg_dump -Fc --no-owner --no-privileges "$DB_URL" 2>>"$LOG" \
  | zstd -T0 -9 -q -o "$path" 2>>"$LOG" \
  || die "pg_dump に失敗しました"
size=$(stat -f%z "$path" 2>/dev/null || stat -c%s "$path")
say "できました: $name / $(numfmt --to=iec "$size" 2>/dev/null || echo "$size バイト") / $(( $(date +%s) - t0 )) 秒"

# 中身が読めるかを確かめてから上げる。壊れた控えは無いのと同じ
zstd -t "$path" 2>>"$LOG" || die "圧縮ファイルが壊れています"

# pg_restore --list は目次だけ読んで先に閉じる。すると zstd 側が
# 「書けない (Broken pipe)」で落ち、pipefail がそれを拾って
# 「壊れている」と誤判定する (実際に誤判定した)。
# ここで見たいのは pg_restore が目次を読めたかどうかだけなので、
# この 1 行の間だけ pipefail を外し、pg_restore の結果で判断する。
set +o pipefail
zstd -dc "$path" 2>/dev/null | pg_restore --list >/dev/null 2>>"$LOG"
toc_rc=$?
set -o pipefail
[ "$toc_rc" -eq 0 ] || die "dump の中身を読めません"
say "中身を確認しました"

# 無料枠から置ける世代数を決める
keep=$MAX_KEEP
if [ "$size" -gt 0 ]; then
  fits=$(( FREE_GB * 1024 * 1024 * 1024 / size ))
  [ "$fits" -lt 1 ] && fits=1
  [ "$fits" -lt "$keep" ] && keep=$fits
fi
say "残す世代: ${keep} (無料枠 ${FREE_GB}GB / 1 世代 $(numfmt --to=iec "$size" 2>/dev/null || echo "$size"))"

if [ -z "$ACCOUNT" ] || [ -z "$KEY" ] || [ -z "$SECRET" ]; then
  say "R2 の鍵がないので、手元に置くところまでで止めます ($path)"
  exit 0
fi

command -v rclone >/dev/null 2>&1 || { say "rclone を入れます"; sudo apt-get install -y -qq rclone >/dev/null 2>&1 || curl -fsSL https://rclone.org/install.sh | sudo bash >/dev/null; }

export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$KEY"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$SECRET"
export RCLONE_CONFIG_R2_ENDPOINT="https://${ACCOUNT}.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

say "R2 へ上げます"
rclone copy "$path" "R2:${BUCKET}/" --s3-no-head 2>>"$LOG" || die "R2 へ上げられませんでした"

# 上げっぱなしにしない。向こう側の大きさを見て突き合わせる
remote=$(rclone size "R2:${BUCKET}/$name" --json 2>>"$LOG" | jq -r '.bytes' 2>/dev/null || echo 0)
[ "$remote" = "$size" ] || die "R2 側の大きさが合いません (手元 $size / 向こう $remote)"
say "R2 で確認しました ($remote バイト)"

say "古い世代を片付けます"
rclone lsf "R2:${BUCKET}/" 2>>"$LOG" | grep -E '^eigyo-.*\.dump\.zst$' | sort -r | tail -n +$((keep + 1)) \
  | while read -r old; do rclone deletefile "R2:${BUCKET}/$old" 2>>"$LOG" && say "消しました: $old"; done

# 手元も同じ数だけ残す
ls -1t "$OUT_DIR"/eigyo-*.dump.zst 2>/dev/null | tail -n +$((keep + 1)) \
  | while read -r f; do rm -f "$f" && say "手元から消しました: $(basename "$f")"; done

say "終わりました"
