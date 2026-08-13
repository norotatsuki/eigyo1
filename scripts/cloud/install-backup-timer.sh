#!/usr/bin/env bash
#
# 毎日の控えを systemd timer で仕込む。
#
# cron ではなく timer にする理由:
#   ・失敗したかどうかを systemctl status / journalctl でそのまま追える
#   ・機体が眠っていて時刻を跨いだときも Persistent=true で取り返せる
#   ・前回の実行結果が残る (cron は自分でログを作らないと消える)
#
#   使い方: sudo bash scripts/cloud/install-backup-timer.sh
set -euo pipefail
APP_DIR=${APP_DIR:-/opt/eigyo1}

cat > /etc/systemd/system/eigyo1-backup.service <<UNIT
[Unit]
Description=営業リスト DB の控えを取り、Cloudflare R2 へ置く
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/env bash $APP_DIR/scripts/cloud/backup-postgres.sh
# 失敗しても機体は落とさない。次の日にまた走る
TimeoutStartSec=3h
Nice=10
IOSchedulingClass=idle
UNIT

cat > /etc/systemd/system/eigyo1-backup.timer <<'UNIT'
[Unit]
Description=営業リスト DB の控えを毎日取る

[Timer]
OnCalendar=*-*-* 04:00:00
# 眠っていて時刻を跨いだら、起きた直後に取り返す
Persistent=true
# 同じ時刻に集中しないよう少しずらす
RandomizedDelaySec=15m

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now eigyo1-backup.timer
echo "仕込みました。次の実行予定:"
systemctl list-timers eigyo1-backup.timer --no-pager | head -3
echo
echo "今すぐ試す: sudo systemctl start eigyo1-backup.service && journalctl -u eigyo1-backup -n 30 --no-pager"
