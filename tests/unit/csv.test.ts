import { describe, expect, it } from 'vitest';
import { readRecords, splitRecord } from '../../src/ingest/csv.ts';

async function* chunks(...parts: string[]): AsyncGenerator<string, void, void> {
  for (const p of parts) yield p;
}

async function collect(...parts: string[]): Promise<string[][]> {
  const out: string[][] = [];
  for await (const r of readRecords(chunks(...parts))) out.push(r);
  return out;
}

describe('splitRecord', () => {
  it('引用符の有無が混ざっていても分解する', () => {
    expect(splitRecord('1,1000013050238,01,"鳥取簡易裁判所",,101')).toEqual([
      '1', '1000013050238', '01', '鳥取簡易裁判所', '', '101',
    ]);
  });

  it('引用符の中の区切り文字を項目の一部として扱う', () => {
    expect(splitRecord('a,"2-223, Higashimachi",b')).toEqual(['a', '2-223, Higashimachi', 'b']);
  });

  it('二重の引用符を 1 つの引用符に戻す', () => {
    expect(splitRecord('a,"He said ""hi""",b')).toEqual(['a', 'He said "hi"', 'b']);
  });

  it('末尾の空項目を落とさない', () => {
    expect(splitRecord('a,b,')).toEqual(['a', 'b', '']);
  });
});

describe('readRecords', () => {
  it('断片の切れ目が行の途中でも正しく繋ぐ', async () => {
    const rows = await collect('1,"あい', 'うえお",3\n2,"かき",4\n');
    expect(rows).toEqual([
      ['1', 'あいうえお', '3'],
      ['2', 'かき', '4'],
    ]);
  });

  it('引用符の中の改行を項目の一部として保つ', async () => {
    const rows = await collect('1,"上\n下",3\n');
    expect(rows).toEqual([['1', '上\n下', '3']]);
  });

  it('CRLF を扱える', async () => {
    const rows = await collect('a,b\r\nc,d\r\n');
    expect(rows).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('先頭の BOM を取り除く', async () => {
    const rows = await collect('﻿a,b\n');
    expect(rows[0]).toEqual(['a', 'b']);
  });

  it('末尾に改行が無くても最終行を返す', async () => {
    const rows = await collect('a,b\nc,d');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(['c', 'd']);
  });

  it('空行は読み飛ばす', async () => {
    const rows = await collect('a,b\n\nc,d\n');
    expect(rows).toEqual([['a', 'b'], ['c', 'd']]);
  });
});
