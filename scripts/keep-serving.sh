#!/usr/bin/env bash
#
# 画面と外部リンクを落とさずに保つ。
#
# 「しばらく経つと、あるいは Wi-Fi を変えると、そのページがエラーになる」の原因は 3 つある:
#   ① cloudflared が落ちる / 回線が変わって繋ぎ直せない  → 見張って上げ直す
#   ② 画面 (node serve) が落ちる                          → 見張って上げ直す
#   ③ 上げ直すと trycloudflare の URL が変わる            → 変わったことを記録して知らせる
#
# ③ は仮の URL を使っている限り消せない。次の 2 つが揃うと固定の名前に変わる:
#   ・cloudflared にログイン済み  (~/.cloudflared/cert.pem がある)
#   ・使う名前が決まっている      (.public-hostname に書く / NAMED_HOSTNAME で渡す)
# どちらも後から用意されうるので、見張りの輪の中で毎回見に行き、揃っていれば
# 仮の URL のまま動いていても張り替える。手順は docs/ops/fixed-url.md。
#
#   使い方:  nohup bash scripts/keep-serving.sh > .keep-serving.log 2>&1 &
#   止める:  touch .stop-serving
#
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-5180}
PW_FILE=${PW_FILE:-.serve-password}
URL_FILE=${URL_FILE:-.public-url}
STOP=.stop-serving
SERVE_LOG=.serve.log
TUNNEL_LOG=.tunnel.log
# 固定の名前を持つトンネル。cloudflared にログイン済みのときだけ使う
NAMED=${NAMED_TUNNEL:-eigyo1}
# 使う名前 (例: eigyo.example.com) の置き場。launchd から起こすときは環境変数を
# 渡しにくいので、ファイルに置けば拾えるようにする (plist を書き換えなくてよい)
HOST_FILE=${HOST_FILE:-.public-hostname}
# 外から叩いて確かめる間隔と、何回続けて駄目なら上げ直すか
CHECK_EVERY=${CHECK_EVERY:-30}
FAILS_BEFORE_RESTART=${FAILS_BEFORE_RESTART:-3}

say() { printf '[番人] %s  %s\n' "$(date '+%m-%d %H:%M:%S')" "$1"; }

# 番人が二人いると、片方が張った外部リンクをもう片方が張り直して URL が入れ替わる。
# 先客がいるなら黙って引き下がる
LOCK=${LOCK:-.keep-serving.pid}
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  say "既に番人がいます (pid=$(cat "$LOCK"))。二重起動しません"
  exit 0
fi
printf '%s\n' "$$" > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

[ -s "$PW_FILE" ] || { say "合言葉のファイル ($PW_FILE) がありません。作ってから起動してください"; exit 1; }

serve_alive()  { pgrep -f "cli.ts serve --host 0.0.0.0 --port ${PORT}" >/dev/null 2>&1; }
tunnel_alive() { pgrep -f "cloudflared tunnel" >/dev/null 2>&1; }

# 固定の名前で開ける状態なら、その名前を返す。
# ログインも名前も後から用意されうるので、覚え込まずに毎回見に行く。
named_host() {
  [ -s "$HOME/.cloudflared/cert.pem" ] || return 1
  host=${NAMED_HOSTNAME:-$(cat "$HOST_FILE" 2>/dev/null)}
  [ -n "$host" ] || return 1
  printf '%s\n' "$host"
}

start_serve() {
  say "画面を起こします (0.0.0.0:${PORT}、合言葉あり)"
  EIGYO_PASSWORD="$(cat "$PW_FILE")" \
    nohup node --experimental-strip-types src/cli.ts serve --host 0.0.0.0 --port "$PORT" \
    >> "$SERVE_LOG" 2>&1 &
  # 集計の作り直しに 1〜2 分かかる。応答するまで待つ
  for _ in $(seq 1 40); do
    curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${PORT}/" && return 0
    sleep 5
  done
  say "画面が応答しません ($SERVE_LOG を見てください)"
}

start_tunnel() {
  : > "$TUNNEL_LOG"
  if host=$(named_host); then
    # ログイン済みで名前も決まっている。固定の名前で開く → URL が変わらない
    cloudflared tunnel list 2>/dev/null | grep -qw "$NAMED" || cloudflared tunnel create "$NAMED" >> "$TUNNEL_LOG" 2>&1
    cloudflared tunnel route dns "$NAMED" "$host" >> "$TUNNEL_LOG" 2>&1
    nohup cloudflared tunnel run --url "http://127.0.0.1:${PORT}" "$NAMED" >> "$TUNNEL_LOG" 2>&1 &
    printf 'https://%s\n' "$host" > "$URL_FILE"
    say "固定の外部リンク: https://${host}"
    return 0
  fi
  # 未ログイン、または名前が未決。仮の URL で開く (上げ直すたびに変わる)
  nohup cloudflared tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate >> "$TUNNEL_LOG" 2>&1 &
  for _ in $(seq 1 20); do
    url=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$TUNNEL_LOG" 2>/dev/null | head -1)
    if [ -n "$url" ]; then
      [ "$(cat "$URL_FILE" 2>/dev/null)" = "$url" ] || say "外部リンクが変わりました → $url"
      printf '%s\n' "$url" > "$URL_FILE"
      # 名前が行き渡るまで 30〜60 秒かかる。ここを待たずに見張りへ入ると、
      # 「届かない」と誤判定して張り直し、URL が変わり続ける
      for _ in $(seq 1 30); do
        reachable && { say "外部リンクが開通しました"; return 0; }
        sleep 5
      done
      say "外部リンクの名前がまだ行き渡っていません (見張りを続けます)"
      return 0
    fi
    sleep 3
  done
  say "外部リンクを取れませんでした ($TUNNEL_LOG を見てください)"
}

reachable() {
  url=$(cat "$URL_FILE" 2>/dev/null) || return 1
  [ -n "$url" ] || return 1
  # 名前解決を端末のリゾルバに任せると、出来たての名前を「無い」と覚えたまま
  # 数分返し続けることがある。それを落ちたと誤判定しないよう自前で引く
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
           --doh-url https://1.1.1.1/dns-query "$url/" 2>/dev/null)
  # 302 = 入室画面へ誘導。合言葉が効いている正常な状態
  [ "$code" = "302" ] || [ "$code" = "200" ]
}

# 回線が切れているだけなら張り直しても無駄なので、外に出られるかを先に見る
online() { curl -s -o /dev/null --max-time 8 https://1.1.1.1/ 2>/dev/null; }

rm -f "$STOP"
say "見張りを始めます (止めるときは touch $STOP)"
serve_alive  || start_serve
tunnel_alive || start_tunnel

fails=0
while :; do
  [ -f "$STOP" ] && { say "停止の指示を見つけました"; exit 0; }

  if ! serve_alive; then say "画面が落ちていました"; start_serve; fi

  # 固定の名前が使えるようになったのに、まだ仮の URL で動いている → 張り替える。
  # ここが無いと、後からログインしても仮の URL が生きている限り切り替わらない
  if host=$(named_host) && [ "$(cat "$URL_FILE" 2>/dev/null)" != "https://$host" ]; then
    say "固定の名前が使えるようになりました。張り替えます → https://${host}"
    pkill -f "cloudflared tunnel" 2>/dev/null
    sleep 3
    start_tunnel; fails=0
    sleep "$CHECK_EVERY"; continue
  fi

  if ! tunnel_alive; then
    say "外部リンクが落ちていました"
    start_tunnel; fails=0
  elif reachable; then
    [ "$fails" -gt 0 ] && say "外部リンクが戻りました"
    fails=0
  else
    if ! online; then
      # 回線が落ちている。張り直しても取れないので、戻るまで数えない
      say "この端末が回線に出られていません (待ちます)"
      sleep "$CHECK_EVERY"; continue
    fi
    fails=$((fails + 1))
    say "外部リンクに届きません (${fails}/${FAILS_BEFORE_RESTART})"
    if [ "$fails" -ge "$FAILS_BEFORE_RESTART" ]; then
      # 回線が変わったときはここに来る。繋ぎ直しでは戻らないので上げ直す
      say "繋ぎ直します"
      pkill -f "cloudflared tunnel" 2>/dev/null
      sleep 3
      start_tunnel; fails=0
    fi
  fi

  sleep "$CHECK_EVERY"
done
