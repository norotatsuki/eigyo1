import { describe, expect, it } from 'vitest';
import {
  createAuth, isLoopback, issueToken, passwordMatches, tokenFromCookie, tokenValid,
} from '../../src/web/auth.ts';

describe('合言葉の照合', () => {
  const auth = createAuth('correct-horse', true);

  it('合っていれば通す', () => {
    expect(passwordMatches(auth, 'correct-horse')).toBe(true);
  });

  it('違えば通さない', () => {
    expect(passwordMatches(auth, 'correct-hors')).toBe(false);
    expect(passwordMatches(auth, '')).toBe(false);
    expect(passwordMatches(auth, 'correct-horse ')).toBe(false);
  });
});

describe('入室の証', () => {
  const auth = createAuth('correct-horse', true);

  it('自分で出した証は通る', () => {
    expect(tokenValid(auth, issueToken(auth))).toBe(true);
  });

  it('期限が切れていれば通さない', () => {
    const old = issueToken(auth, Date.now() - 13 * 60 * 60 * 1000);
    expect(tokenValid(auth, old)).toBe(false);
  });

  it('署名を書き換えたものは通さない', () => {
    const t = issueToken(auth);
    const [body] = t.split('.');
    expect(tokenValid(auth, `${body}.${'0'.repeat(64)}`)).toBe(false);
  });

  // 起動ごとに鍵が変わる。他所で作った証は使えない
  it('別の起動で作った証は通さない', () => {
    const other = createAuth('correct-horse', true);
    expect(tokenValid(auth, issueToken(other))).toBe(false);
  });

  it('壊れた証でも落ちない', () => {
    for (const bad of [undefined, '', 'abc', '.', 'x.y', '999999999999.']) {
      expect(tokenValid(auth, bad)).toBe(false);
    }
  });
});

describe('cookie から証を取り出す', () => {
  it('他の cookie が混ざっていても取れる', () => {
    expect(tokenFromCookie('a=1; eigyo_session=tok%2Fen; b=2')).toBe('tok/en');
  });

  it('無ければ undefined', () => {
    expect(tokenFromCookie('a=1')).toBeUndefined();
    expect(tokenFromCookie(undefined)).toBeUndefined();
  });
});

describe('手元に閉じているかの判定', () => {
  // ここを間違えると、合言葉なしで外に開いてしまう
  it('手元の宛先を見分ける', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
  });

  it('外向きの宛先は手元ではない', () => {
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('192.168.1.10')).toBe(false);
  });
});
