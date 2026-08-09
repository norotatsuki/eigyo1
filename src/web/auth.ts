/**
 * 合言葉による入室確認。
 *
 * 手元 (127.0.0.1) だけで動かしている間は要らない。他の端末から届く形に
 * した瞬間、**500 万社の情報と、メールアドレス・代表者名が誰でも見られる状態**
 * になるため、外向きに開くときは合言葉を必ず要る形にする。
 *
 * 凝ったことはしない。利用者は社内の数人で、守りたいのは「URL を知っただけの人」
 * である。ただし雑にもしない:
 *   - 合言葉の照合は時間差が出ない比べ方をする (打ち間違いの回数から絞られないため)
 *   - 入室の証は起動ごとの秘密で署名する (作れないようにする)
 *   - 証は HttpOnly。画面側の script から読めない
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'eigyo_session';
/** 入室の有効期間。長すぎると端末を離れたときに危ない */
const TTL_MS = 12 * 60 * 60 * 1000;

export interface Auth {
  /** 合言葉が要るか。手元だけで動かしているなら false */
  required: boolean;
  password: string;
  /** 起動ごとに作る署名の鍵。落として立て直せば入室し直しになる */
  secret: Buffer;
}

export function createAuth(password: string | null, required: boolean): Auth {
  return { required, password: password ?? '', secret: randomBytes(32) };
}

/** 同じ長さに均してから比べる。合っている文字数が時間に出ないようにする。 */
export function passwordMatches(auth: Auth, given: string): boolean {
  const a = createHmac('sha256', auth.secret).update(auth.password).digest();
  const b = createHmac('sha256', auth.secret).update(given).digest();
  return timingSafeEqual(a, b);
}

/** 入室の証を作る。期限と署名を入れる。 */
export function issueToken(auth: Auth, now = Date.now()): string {
  const expires = now + TTL_MS;
  const body = String(expires);
  const sign = createHmac('sha256', auth.secret).update(body).digest('hex');
  return `${body}.${sign}`;
}

/** 証が本物で、期限内か。 */
export function tokenValid(auth: Auth, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [body, sign] = token.split('.');
  if (!body || !sign) return false;
  const expected = createHmac('sha256', auth.secret).update(body).digest('hex');
  if (sign.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(sign), Buffer.from(expected))) return false;
  const expires = Number(body);
  return Number.isFinite(expires) && expires > now;
}

/** 要求に付いてきた証を取り出す。 */
export function tokenFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/**
 * 手元だけに閉じているか。
 *
 * 閉じているなら合言葉は要らない。開くなら必ず要る。
 * ここを間違えると、合言葉なしで外に開いてしまう。
 */
export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** 入室の画面。合言葉だけを尋ねる。 */
export function loginPage(message = ''): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>営業リスト — 入室</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#fbfbf9;
         color:#1c1c1a; font:14px/1.6 "Hiragino Sans","Yu Gothic",Meiryo,system-ui,sans-serif; }
  form { background:#fff; border:1px solid #e2e0d8; border-radius:8px; padding:28px 30px; width:min(92vw,340px); }
  h1 { font-size:15px; margin:0 0 4px; }
  p { color:#6f6d66; font-size:12px; margin:0 0 18px; }
  input { width:100%; padding:9px 11px; border:1px solid #e2e0d8; border-radius:5px; font:inherit; }
  button { width:100%; margin-top:12px; padding:9px; border:1px solid #2f5d50; background:#2f5d50;
           color:#fff; border-radius:5px; font:inherit; cursor:pointer; }
  .ng { color:#8a5a2b; font-size:12px; margin-top:10px; }
</style></head>
<body>
  <form method="post" action="/login">
    <h1>営業リスト</h1>
    <p>社内向けの画面です。合言葉を入れてください。</p>
    <input type="password" name="password" autocomplete="current-password" autofocus
           aria-label="合言葉" required>
    <button type="submit">入る</button>
    ${message ? `<div class="ng">${message}</div>` : ''}
  </form>
</body></html>`;
}
