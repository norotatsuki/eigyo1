#!/usr/bin/env bash
#
# DB を安全に複製し、この端末の外へ出す。
#
# 守る対象は data/eigyo.db だけでよい。data/raw は国税庁と Common Crawl の
# 公開ファイルで、いつでも取り直せる。
#
# cp は使わない。収集が動いている間は WAL に書き込みが続いており、
# 中途半端な複製になる。VACUUM INTO は読み取りの断面を 1 つ取るので、
# **収集を止めずに** 一貫した複製が作れる (ついでに詰めて小さくなる)。
#
# 外へ出す先:
#   ① GitHub のリリース資産 (private リポジトリ = 非公開)。
#      1 ファイル 2 GB まで。実測で 5.34 GiB → 1.26 GiB に収まる。
#      追加の登録が要らないので、既定はこちら
#   ② Cloudflare R2。.r2-credentials を置けばそちらにも送る
#
#   使い方:  bash scripts/backup-db.sh
set -uo pipefail
cd "$(dirname "$0")/.."

DB=${DB:-data/eigyo.db}
OUT_DIR=${OUT_DIR:-data/backup}
KEEP=${KEEP:-2}                      # 手元に残す本数
REPO=${REPO:-norotatsuki/eigyo1}
CREDS=${CREDS:-.r2-credentials}

say() { printf '[控え] %s  %s\n' "$(date '+%m-%d %H:%M:%S')" "$1"; }

mkdir -p "$OUT_DIR"
stamp=$(date +%Y%m%d-%H%M)
snap="$OUT_DIR/eigyo-$stamp.db"

say "断面を取ります (収集は止めません)"
if ! sqlite3 "$DB" "VACUUM INTO '$snap'"; then
  say "断面を取れませんでした"; exit 1
fi

# 取った複製がちゃんと開けるかを確かめる。壊れた控えは無いのと同じ
if [ "$(sqlite3 "file:${snap}?mode=ro" 'PRAGMA quick_check;' 2>&1)" != "ok" ]; then
  say "複製が壊れています。捨てます"; rm -f "$snap"; exit 1
fi
rows=$(sqlite3 "file:${snap}?mode=ro" 'SELECT COUNT(*) FROM corporations;')
say "$(du -h "$snap" | cut -f1) / 法人 $(printf "%'d" "$rows" 2>/dev/null || echo "$rows") 件"

say "詰めます"
zstd -T0 -3 --long=27 -q -f "$snap" -o "$snap.zst" || { say "詰められませんでした"; exit 1; }
size=$(du -h "$snap.zst" | cut -f1)

# ① GitHub のリリース資産へ (private のまま)
if gh release create "backup-$stamp" --repo "$REPO" \
     --title "DB バックアップ ${stamp}" \
     --notes "VACUUM INTO で取った一貫した断面。戻し方: zstd -d <file> -o data/eigyo.db" \
     "$snap.zst" >/dev/null 2>&1; then
  say "GitHub へ送りました ($size, 非公開)"
  # 古いリリースを片付ける (最新 KEEP 本だけ残す)
  gh release list --repo "$REPO" --limit 50 --json tagName \
    --jq '.[].tagName | select(startswith("backup-"))' 2>/dev/null \
    | sort -r | tail -n +$((KEEP + 1)) \
    | while read -r old; do gh release delete "$old" --repo "$REPO" --yes --cleanup-tag >/dev/null 2>&1 && say "古い控えを消しました ($old)"; done
else
  say "GitHub へ送れませんでした"
fi

# ② R2 へ (鍵が置いてあるときだけ)
if [ -s "$CREDS" ]; then
  # shellcheck disable=SC1090
  . "$CREDS"
  if ! command -v rclone >/dev/null 2>&1; then
    say "rclone を入れます"; brew install rclone >/dev/null 2>&1 || say "rclone を入れられませんでした"
  fi
  if command -v rclone >/dev/null 2>&1; then
    RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
    RCLONE_CONFIG_R2_ACCESS_KEY_ID="$access_key_id" \
    RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$secret_access_key" \
    RCLONE_CONFIG_R2_ENDPOINT="https://${account_id}.r2.cloudflarestorage.com" \
      rclone copy "$snap.zst" "R2:${bucket}/" >/dev/null 2>&1 \
      && say "R2 へ送りました" || say "R2 へ送れませんでした"
  fi
fi

# 手元の古い分を片付ける
ls -1t "$OUT_DIR"/eigyo-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do rm -f "$f"; say "手元の古い断面を消しました ($(basename "$f"))"; done
ls -1t "$OUT_DIR"/eigyo-*.db.zst 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do rm -f "$f"; done
say "終わりました"
