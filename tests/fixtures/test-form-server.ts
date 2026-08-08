/**
 * 送信を確かめるための、手元に立てる問い合わせフォーム。
 *
 * 実在の企業に試し送りをするわけにいかないので、相手役をこちらで用意する。
 * 受け取った内容をそのまま保持し、試験から中身を検められるようにする。
 */
import { createServer, type Server } from 'node:http';

export interface Received {
  path: string;
  fields: Record<string, string>;
}

export interface TestFormServer {
  url: string;
  received: Received[];
  close: () => Promise<void>;
}

/** 素直なフォーム。会社名・氏名・メール・電話・件名・内容と、必須の同意。 */
const PLAIN_FORM = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>お問い合わせ</title></head>
<body><h1>お問い合わせ</h1>
<form method="post" action="/submit" id="inquiry">
  <table>
    <tr><th>会社名<span>必須</span></th><td><input type="text" name="company" required></td></tr>
    <tr><th>お名前<span>必須</span></th><td><input type="text" name="yourname" required></td></tr>
    <tr><th>メールアドレス<span>必須</span></th><td><input type="email" name="email" required></td></tr>
    <tr><th>メールアドレス確認</th><td><input type="email" name="email_confirm"></td></tr>
    <tr><th>電話番号</th><td><input type="tel" name="tel"></td></tr>
    <tr><th>件名</th><td><input type="text" name="subject"></td></tr>
    <tr><th>お問い合わせ内容<span>必須</span></th><td><textarea name="message" required></textarea></td></tr>
    <tr><th>個人情報の取扱いに同意<span>必須</span></th><td><input type="checkbox" name="agree" required></td></tr>
  </table>
  <button type="submit">送信する</button>
</form></body></html>`;

/** CAPTCHA つき。送信させてはいけない相手。 */
const CAPTCHA_FORM = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>お問い合わせ</title></head>
<body><form method="post" action="/submit">
  <label>会社名<input type="text" name="company" required></label>
  <label>お問い合わせ内容<textarea name="message" required></textarea></label>
  <div class="g-recaptcha" data-sitekey="dummy"></div>
  <button type="submit">送信</button>
</form></body></html>`;

/** 意味の分からない必須欄がある。埋められないので送ってはいけない。 */
const ODD_FORM = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>お問い合わせ</title></head>
<body><form method="post" action="/submit">
  <label>会社名<input type="text" name="company" required></label>
  <label>お問い合わせ内容<textarea name="message" required></textarea></label>
  <label>ご契約番号<span>必須</span><input type="text" name="contract_no" required></label>
  <button type="submit">送信</button>
</form></body></html>`;

/** 営業お断りが書かれている。 */
const REFUSING_FORM = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>お問い合わせ</title></head>
<body><p>営業目的のお問い合わせはお断りしております。</p>
<form method="post" action="/submit">
  <label>会社名<input type="text" name="company" required></label>
  <label>お問い合わせ内容<textarea name="message" required></textarea></label>
  <button type="submit">送信</button>
</form></body></html>`;

const PAGES: Record<string, string> = {
  '/': PLAIN_FORM,
  '/plain': PLAIN_FORM,
  '/captcha': CAPTCHA_FORM,
  '/odd': ODD_FORM,
  '/refusing': REFUSING_FORM,
};

export async function startTestFormServer(port = 0): Promise<TestFormServer> {
  const received: Received[] = [];

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?', 1)[0]!;

    if (req.method === 'POST' && path === '/submit') {
      let body = '';
      req.on('data', (c) => {
        body += String(c);
      });
      req.on('end', () => {
        const fields: Record<string, string> = {};
        for (const [k, v] of new URLSearchParams(body)) fields[k] = v;
        received.push({ path, fields });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html lang="ja"><body><h1>送信が完了しました</h1></body></html>');
      });
      return;
    }

    const page = PAGES[path];
    if (page) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
