/**
 * 合言葉なしで開く道 (--open / EIGYO_PUBLIC=1) の確かめ。
 *
 * ここは間違えると 500 万社の連絡先が黙って外に出る場所なので、
 * 「開くと書いたときだけ開く」ことを、実際にサーバを立てて確かめる。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { openDb } from '../../src/db/index.ts';
import { serve } from '../../src/web/server.ts';

let running: Server | null = null;
afterEach(async () => {
  if (running) await new Promise<void>((r) => running!.close(() => r()));
  running = null;
});

/** 立ち上げて、実際に確保できた口を返す */
function start(options: Parameters<typeof serve>[1]): Promise<number> {
  const db = openDb(':memory:');
  return new Promise((resolve) => {
    running = serve(db, { ...options, port: 0, onListen: (url) => resolve(Number(new URL(url).port)) });
  });
}

/** 追いかけずに、最初の応答をそのまま見る */
async function status(port: number, path = '/'): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
  return res.status;
}

describe('合言葉なしで開く', () => {
  it('外向きに開くのに合言葉も open も無ければ、立ち上がらない', async () => {
    const db = openDb(':memory:');
    expect(() => serve(db, { host: '0.0.0.0', port: 0 })).toThrow(/合言葉が要ります/);
  });

  it('短すぎる合言葉も断る (8 文字未満)', async () => {
    const db = openDb(':memory:');
    expect(() => serve(db, { host: '0.0.0.0', port: 0, password: 'short' })).toThrow(/合言葉が要ります/);
  });

  it('open を渡せば、合言葉なしでも立ち上がり、入室画面を挟まない', async () => {
    const port = await start({ host: '0.0.0.0', open: true });
    expect(await status(port)).toBe(200);        // 302 (入室画面へ誘導) ではない
    expect(await status(port, '/api/meta')).toBe(200);
  });

  it('open が無ければ、合言葉ありでも画面の手前で止める', async () => {
    const port = await start({ host: '0.0.0.0', password: 'longenoughpw' });
    expect(await status(port)).toBe(302);
    expect(await status(port, '/api/search')).toBe(401);
  });

  it('open は明示したときだけ効く。false や未指定では開かない', async () => {
    const db = openDb(':memory:');
    expect(() => serve(db, { host: '0.0.0.0', port: 0, open: false })).toThrow(/合言葉が要ります/);
    expect(() => serve(db, { host: '0.0.0.0', port: 0 })).toThrow(/合言葉が要ります/);
  });

  it('手元だけ (127.0.0.1) は今までどおり、何も渡さずに開く', async () => {
    const port = await start({ host: '127.0.0.1' });
    expect(await status(port)).toBe(200);
  });
});
