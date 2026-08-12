#!/usr/bin/env bash
#
# 変わらない入口を保つ。
#
# 仮の外部リンク (trycloudflare) は張り直すたびに名前が変わる。実際に
# 8/11-13 の 2 日で 5 回変わり、利用者は死んだ URL を開いて
# 「データが消えた」と判断した。データは無事で、URL だけが変わっていた。
#
# 固定の名前を持つには Cloudflare にログインが要る (アカウントの認証は
# 代行しない)。そこで「変わらない入口」を別に 1 つ置き、そこから
# 今生きている URL へ飛ばす。配るのは入口だけでよい。
#
#   入口:  https://norotatsuki.github.io/eigyo-link/
#   中身:  行き先だけを持つ 1 枚。会社の情報は 1 件も置かない
#
# 番人が URL の変化を見つけるたびに呼ぶ。同じ URL なら何もしない。
set -uo pipefail
cd "$(dirname "$0")/.."

LINK_DIR=${LINK_DIR:-/Users/norotatsuki/Dev/eigyo-link}
URL_FILE=${URL_FILE:-.public-url}

url=$(cat "$URL_FILE" 2>/dev/null) || exit 0
[ -n "$url" ] || exit 0
[ -d "$LINK_DIR/.git" ] || { echo "[入口] $LINK_DIR がありません"; exit 0; }

# 既に同じ行き先なら触らない (呼ばれるたびに push しない)
if grep -qF "$url" "$LINK_DIR/index.html" 2>/dev/null; then exit 0; fi

cat > "$LINK_DIR/index.html" <<HTML
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>営業リスト</title>
<meta http-equiv="refresh" content="0; url=${url}">
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fbfbf9;color:#1c1c1a;
      font:14px/1.7 "Hiragino Sans","Yu Gothic",Meiryo,system-ui,sans-serif}
 .box{text-align:center;padding:28px 30px;background:#fff;border:1px solid #e2e0d8;border-radius:8px;width:min(92vw,420px)}
 a{color:#2f5d50}
 .note{color:#6f6d66;font-size:12px;margin-top:14px}
</style>
</head>
<body>
 <div class="box">
  <p>営業リストの画面へ移動しています…</p>
  <p><a href="${url}">開かないときはこちら</a></p>
  <p class="note">この入口の場所は変わりません。行き先だけが自動で入れ替わります。<br>
     繋がらないときは、画面を出している端末が眠っているか回線から外れています。</p>
 </div>
 <script>location.replace("${url}");</script>
</body>
</html>
HTML

cd "$LINK_DIR"
git add index.html
git -c user.email=noro_tatsuki@p2c-produce.com -c user.name=norotatsuki \
    commit -q -m "chore: 行き先を ${url} に更新" 2>/dev/null || exit 0
if git push -q origin main 2>/dev/null; then
  echo "[入口] 行き先を更新しました → ${url}"
else
  echo "[入口] 送れませんでした (次の見張りでやり直します)"
fi
