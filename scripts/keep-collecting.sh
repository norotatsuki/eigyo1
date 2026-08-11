#!/usr/bin/env bash
#
# 集め切るまで見張る。
#
# 通し実行 (complete) は 8〜9 時間かかる。その間に落ちることがある
# (実際に、索引が応答を返さなくなって発見処理が 28 分間止まっていた)。
# 落ちたことに誰も気づかないのが一番まずいので、終了したら状態を見て、
# まだ残っていれば自動で再開する。
#
# complete は中断しても続きから始まるため、何度呼んでも二重に訪ねない。
#
#   使い方:  nohup bash scripts/keep-collecting.sh > .keep.log 2>&1 &
#   止める:  touch .stop-collecting
#
set -uo pipefail
cd "$(dirname "$0")/.."

DB=${DB:-data/eigyo.db}
# 同時に当たる相手の数。相手はすべて別のサイトなので、1 社への負荷は増えない。
# 上げられるのは 1 ページの上限を 700 KB に下げてメモリが収まったため
CONCURRENCY=${CONCURRENCY:-96}
# ヒープの上限。4 GB に当たって 3 回落ちていた
# (FATAL ERROR: Reached heap limit)。この機体は 32 GB あるので広げる。
#
# 既に入っている NODE_OPTIONS を尊重してはいけない。環境側で 4096 が
# 設定されており、それを引き継ぐと上限を上げたつもりで上がらない
# (実際に一度これで素通りした)。ここは意図して上書きする
export NODE_OPTIONS="--max-old-space-size=${HEAP_MB:-12288}"
LOG=${LOG:-.complete.log}
STOP=.stop-collecting
# 再開の上限。1 区切り 2 万件なので、40 回では足りずに諦めていた。
# 進んでいる限り止める理由はないので、十分に大きく取る
MAX_ROUNDS=${MAX_ROUNDS:-400}
# 項目が欠けている先を掘り直すか。粒度を上げたいときに 1 を渡す
DEEPEN=${DEEPEN:-}

pending() {
  sqlite3 "file:${DB}?mode=ro" \
    "SELECT COUNT(*) FROM web_hosts WHERE crawl_status = 'pending';" 2>/dev/null || echo "?"
}

say() { printf '[見張り] %s  %s\n' "$(date '+%m-%d %H:%M')" "$1"; }

rm -f "$STOP"
say "開始します (止めるときは touch $STOP)"

for round in $(seq 1 "$MAX_ROUNDS"); do
  if [ -f "$STOP" ]; then
    say "停止の指示を見つけました"
    exit 0
  fi

  left=$(pending)
  if [ "$left" = "0" ]; then
    say "未訪問がありません。仕上げ (業種・再照合・点検) を回します"
    node --experimental-strip-types src/cli.ts complete --concurrency ${CONCURRENCY:-96} ${DEEPEN:+--deepen} >> "$LOG" 2>&1
    say "完了しました"
    exit 0
  fi

  say "${round} 回目 — 未訪問 ${left} 件"
  node --experimental-strip-types src/cli.ts complete --concurrency ${CONCURRENCY:-96} ${DEEPEN:+--deepen} >> "$LOG" 2>&1
  code=$?

  if [ $code -eq 0 ]; then
    say "通し実行が正常に終わりました"
    [ "$(pending)" = "0" ] && { say "完了しました"; exit 0; }
    # 未訪問が残ったまま正常終了することがある (1 区切りで進まなかった等)
    say "未訪問が残っているので続けます"
  else
    say "通し実行が異常終了しました (終了コード ${code})。30 秒待って再開します"
    sleep 30
  fi
done

say "上限 (${MAX_ROUNDS} 回) に達しました。残り $(pending) 件"
say "まだ残っているなら bash scripts/keep-collecting.sh を叩き直してください"
