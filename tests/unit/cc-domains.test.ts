import { describe, expect, it } from 'vitest';
import { editionUrl, hostFromLine, unreverse } from '../../src/ingest/commoncrawl/domains.ts';

describe('逆順のドメインを戻す', () => {
  it('普通の並びに直す', () => {
    expect(unreverse('jp.co.example')).toBe('example.co.jp');
    expect(unreverse('com.facebook')).toBe('facebook.com');
  });

  it('区切りの無いものは取らない', () => {
    expect(unreverse('jp')).toBeNull();
  });
});

describe('一覧の 1 行からホスト名を取る', () => {
  const line = (rev: string): string => `12\t3.2E7\t9\t0.001\t${rev}\t42`;

  it('対象の接尾辞に当てはまる行を取る', () => {
    expect(hostFromLine(line('jp.co.example'), '.co.jp')).toBe('example.co.jp');
    expect(hostFromLine(line('jp.co.example.shop'), '.co.jp')).toBe('shop.example.co.jp');
  });

  it('接尾辞が違う行は取らない', () => {
    expect(hostFromLine(line('com.facebook'), '.co.jp')).toBeNull();
    expect(hostFromLine(line('jp.ne.example'), '.co.jp')).toBeNull();
    // `co.jp` で終わらない `jp.co...` 以外の並びを取り違えない
    expect(hostFromLine(line('jp.company'), '.co.jp')).toBeNull();
  });

  it('接尾辞そのものだけの行は会社ではない', () => {
    expect(hostFromLine(line('jp.co'), '.co.jp')).toBeNull();
  });

  it('見出し行と空行は読み飛ばす', () => {
    expect(hostFromLine('#harmonicc_pos\t#harmonicc_val\t#pr_pos\t#pr_val\t#host_rev\t#n_hosts', '.co.jp')).toBeNull();
    expect(hostFromLine('', '.co.jp')).toBeNull();
  });

  it('列が足りない行では落ちない', () => {
    expect(hostFromLine('12\t3.2E7', '.co.jp')).toBeNull();
  });

  it('接尾辞は差し替えられる', () => {
    expect(hostFromLine(line('jp.or.example'), '.or.jp')).toBe('example.or.jp');
  });
});

describe('取得先', () => {
  it('版の名前から場所を組み立てる', () => {
    expect(editionUrl('cc-main-2025-may-jun-jul')).toBe(
      'https://data.commoncrawl.org/projects/hyperlinkgraph/cc-main-2025-may-jun-jul/domain/cc-main-2025-may-jun-jul-domain-ranks.txt.gz',
    );
  });
});
