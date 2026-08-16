#!/usr/bin/env bash
#
# 変わらない入口を保つ。
#
# 仮の外部リンク (trycloudflare) は張り直すたびに名前が変わる。
# 配るのは変わらない入口 1 本だけにして、行き先はそこから引かせる。
#
#   入口:  https://norotatsuki.github.io/eigyo-link/
#
# 【なぜ 2 段構えか】
#   最初は index.html に行き先を直接書いていた。しかし GitHub Pages は
#   push から配信反映まで再ビルドを挟む。仮 URL は 1 日に何度も変わるため、
#   その待ち時間のあいだ入口が死んだ URL を指し続けた (実際に切れた)。
#
#   そこで行き先を url.txt という別ファイルに出し、入口の頁は開くたびに
#   raw.githubusercontent.com からそれを読んで飛ぶ形にした。raw は
#   再ビルドを挟まないので、push した時点で新しい行き先が効く。
#   入口の頁自体はもう書き換えないので、Pages の再ビルドも起きない。
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
if [ "$(cat "$LINK_DIR/url.txt" 2>/dev/null)" = "$url" ]; then exit 0; fi

printf '%s\n' "$url" > "$LINK_DIR/url.txt"

# 入口の頁は一度だけ置く。以降は url.txt だけが変わる
if [ ! -f "$LINK_DIR/index.html" ] || ! grep -q "url.txt" "$LINK_DIR/index.html"; then
  cat > "$LINK_DIR/index.html" <<'HTML'
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>営業リスト</title>
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fbfbf9;color:#1c1c1a;
      font:14px/1.7 "Hiragino Sans","Yu Gothic",Meiryo,system-ui,sans-serif}
 .box{text-align:center;padding:28px 30px;background:#fff;border:1px solid #e2e0d8;
      border-radius:8px;width:min(92vw,440px)}
 a{color:#2f5d50}
 .note{color:#6f6d66;font-size:12px;margin-top:14px}
 .ng{color:#8a5a2b}
</style>
</head>
<body>
 <div class="box">
  <p id="msg">営業リストの画面へ移動しています…</p>
  <p id="link"></p>
  <p class="note">この入口の場所は変わりません。行き先だけが自動で入れ替わります。<br>
     繋がらないときは、画面を出している端末が眠っているか回線から外れています。</p>
 </div>
<script>
// 行き先は毎回読み直す。頁自体は書き換えないので Pages の再ビルドを待たない。
// 時刻を付けて、途中の CDN に古い行き先を握られないようにする。
(async () => {
  const src = 'https://raw.githubusercontent.com/norotatsuki/eigyo-link/main/url.txt?t=' + Date.now();
  try {
    const res = await fetch(src, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const url = (await res.text()).trim();
    if (!/^https:\/\//.test(url)) throw new Error('形が違います');
    document.getElementById('link').innerHTML =
      '<a href="' + url + '">開かないときはこちら</a>';
    location.replace(url);
  } catch (e) {
    document.getElementById('msg').className = 'ng';
    document.getElementById('msg').textContent =
      '行き先を読めませんでした (' + e.message + ')。少し待って開き直してください。';
  }
})();
</script>
</body></html>
HTML
  (cd "$LINK_DIR" && git add index.html)
fi

cd "$LINK_DIR"
git add url.txt
git -c user.email=noro_tatsuki@p2c-produce.com -c user.name=norotatsuki \
    commit -q -m "chore: 行き先を ${url} に更新" 2>/dev/null || exit 0
if git push -q origin main 2>/dev/null; then
  echo "[入口] 行き先を更新しました → ${url}"
else
  echo "[入口] 送れませんでした (次の見張りでやり直します)"
fi
