import { describe, expect, it } from 'vitest';
import { extractRecruit, findRecruitUrl } from '../../src/enrich/site/recruit.ts';

describe('採用ページの見つけ方', () => {
  it('リンクの文字からも道筋からも探す', () => {
    expect(findRecruitUrl('<a href="/recruit/">採用情報</a>', 'https://x.co.jp/'))
      .toBe('https://x.co.jp/recruit/');
    expect(findRecruitUrl('<a href="/jinji/">求人のご案内</a>', 'https://x.co.jp/'))
      .toBe('https://x.co.jp/jinji/');
    expect(findRecruitUrl('<a href="/careers">Careers</a>', 'https://x.co.jp/'))
      .toBe('https://x.co.jp/careers');
  });

  it('採用と関係ないリンクは拾わない', () => {
    expect(findRecruitUrl('<a href="/company/">会社概要</a>', 'https://x.co.jp/')).toBeNull();
    expect(findRecruitUrl('<a href="mailto:saiyo@x.co.jp">採用担当</a>', 'https://x.co.jp/')).toBeNull();
  });
});

describe('募集の読み取り', () => {
  it('募集職種から部署の手がかりを取る', () => {
    const t = '採用情報 募集要項 施工管理 3名 設計 1名 応募資格 実務経験3年以上';
    const r = extractRecruit(t);
    expect(r.hiring).toBe(true);
    expect(r.roles).toContain('施工管理');
    expect(r.roles).toContain('設計');
  });

  it('新卒と中途を見分ける', () => {
    const r = extractRecruit('新卒採用 2027年度 募集要項 営業職 / 中途採用 経験者募集 エンジニア');
    expect(r.newGrad).toBe(true);
    expect(r.midCareer).toBe(true);
    expect(r.roles).toContain('営業');
    expect(r.roles).toContain('技術・開発');
  });

  it('募集を止めている場合はそちらを優先する', () => {
    // 職種名を載せたまま止めているサイトが多い
    const t = '採用情報 現在募集はしておりません 過去の募集職種: 営業職 エンジニア 募集要項';
    const r = extractRecruit(t);
    expect(r.hiring).toBe(false);
    expect(r.evidence).toBe('現在募集はしておりません');
  });

  it('職種が並んでいるだけでは募集中と決めつけない', () => {
    // 事業内容の説明で職種名が出ることがある
    const r = extractRecruit('当社には営業職と設計の担当者が在籍しています。');
    expect(r.hiring).toBe(false);
  });

  it('募集の文言だけで職種が無ければ募集中としない', () => {
    expect(extractRecruit('募集要項はこちら').hiring).toBe(false);
  });

  it('社内 SE と一般のエンジニアを区別する', () => {
    const r = extractRecruit('募集要項 社内SE 情報システム部門 1名 応募資格');
    expect(r.roles).toContain('情報システム');
  });

  it('採用に触れていないページでは何も返さない', () => {
    const r = extractRecruit('当社は地域に根ざした建設会社です。お気軽にお問い合わせください。');
    expect(r.hiring).toBe(false);
    expect(r.roles).toEqual([]);
    expect(r.evidence).toBeNull();
  });
});
