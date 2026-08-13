#!/usr/bin/env bash
#
# Ubuntu の素の VM を、この営業リストの本番サーバーにする。
#
# 想定: Oracle Cloud Always Free の Ampere A1 (Ubuntu 24.04)。
#       他社の VM でも Ubuntu 22.04/24.04 ならそのまま通る。
#
#   使い方 (VM に ssh して):
#     curl -fsSL https://raw.githubusercontent.com/norotatsuki/eigyo1/main/scripts/cloud/provision.sh | bash
#   または リポジトリを clone して bash scripts/cloud/provision.sh
#
# ここでやること:
#   PostgreSQL の導入と初期設定 / DB とユーザー作成 / 自動起動 /
#   ファイアウォール / タイムゾーン / スワップ / アプリの取得
#
# ここでやらないこと (人がやる):
#   Oracle Cloud のアカウント作成、VM 作成、SSH 鍵の登録、
#   Security List / NSG の設定 (22/80/443 のみ開ける)
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/eigyo1}
DB_NAME=${DB_NAME:-eigyo}
DB_USER=${DB_USER:-eigyo}
REPO=${REPO:-https://github.com/norotatsuki/eigyo1.git}

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$1"; }

say "時刻を日本時間に合わせます"
sudo timedatectl set-timezone Asia/Tokyo

say "必要なものを入れます"
sudo apt-get update -qq
sudo apt-get install -y -qq postgresql postgresql-contrib zstd git curl ufw jq unzip

say "Node.js 22 を入れます"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs
fi
node -v

say "スワップを用意します (12GB の機体でも収集中に振り切れることがある)"
if [ ! -f /swapfile ]; then
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi
free -h | head -2

say "PostgreSQL を設定します"
PGVER=$(ls /etc/postgresql | sort -n | tail -1)
PGCONF=/etc/postgresql/$PGVER/main
# 外に向けて開かない。アプリは同じ VM の中から UNIX ソケット/localhost で繋ぐ
sudo sed -i "s/^#\?listen_addresses.*/listen_addresses = 'localhost'/" "$PGCONF/postgresql.conf"

# 12GB / 2 OCPU の機体に合わせる。既定のままだと 581 万行の検索で
# 共有バッファが足りず、毎回ディスクから読み直すことになる
sudo tee -a "$PGCONF/conf.d/eigyo.conf" >/dev/null <<'CONF'
# 営業リスト向けの調整 (12GB RAM / 2 vCPU を想定)
shared_buffers = 3GB
effective_cache_size = 8GB
work_mem = 32MB
maintenance_work_mem = 512MB
random_page_cost = 1.1          # SSD なので順読みとの差は小さい
effective_io_concurrency = 200
max_parallel_workers_per_gather = 2
jit = off                        # 単純な絞り込みでは JIT の準備時間が損になる
timezone = 'Asia/Tokyo'
log_min_duration_statement = 3000   # 3 秒を超えた問い合わせだけ記録する
CONF
sudo mkdir -p "$PGCONF/conf.d"
grep -q "conf.d" "$PGCONF/postgresql.conf" || \
  echo "include_dir = 'conf.d'" | sudo tee -a "$PGCONF/postgresql.conf" >/dev/null

say "DB と利用者を作ります"
DB_PASS=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS';"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
  || sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
sudo -u postgres psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" >/dev/null

say "自動起動を有効にします"
sudo systemctl enable --now postgresql
sudo systemctl restart postgresql
sudo -u postgres psql -tAc "SELECT version();" | head -1

say "アプリを置きます"
if [ ! -d "$APP_DIR/.git" ]; then
  sudo mkdir -p "$APP_DIR" && sudo chown "$USER":"$USER" "$APP_DIR"
  git clone --depth 1 "$REPO" "$APP_DIR"
fi
cd "$APP_DIR" && npm ci --omit=dev 2>/dev/null || npm install --omit=dev

say "接続情報を .env に書きます (git には載りません)"
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<ENV
DATABASE_URL=postgres://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME
ENV
  chmod 600 "$APP_DIR/.env"
  echo "  DB のパスワードは $APP_DIR/.env にだけ書きました (画面には出しません)"
else
  echo "  既に .env があるので触りません"
fi

say "ファイアウォール"
sudo ufw allow 22/tcp   >/dev/null
sudo ufw allow 80/tcp   >/dev/null
sudo ufw allow 443/tcp  >/dev/null
sudo ufw --force enable >/dev/null
sudo ufw status numbered | head -8
echo "  5432 は開けていません。PostgreSQL は localhost だけで待ち受けます"

say "終わりました"
cat <<'NEXT'
次にやること:
  1. スキーマと索引を入れる
       cd /opt/eigyo1 && set -a && . .env && set +a
       psql "$DATABASE_URL" -f src/db/schema.pg.sql
  2. データを入れる (Mac から吸い出した dump を使う場合)
       scripts/cloud/restore.sh <dump ファイル>
  3. バックアップを仕込む
       sudo bash scripts/cloud/install-backup-timer.sh
NEXT
