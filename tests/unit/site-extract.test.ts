import { describe, expect, it } from 'vitest';
import {
  contactUrlRejectReason,
  extractFromHtml,
  findRefusal,
  findTel,
  nameFromCopyright,
  pickCompanyName,
  toText,
} from '../../src/enrich/site/extract.ts';

describe('pickCompanyName', () => {
  // 実際に収集して失敗した題名。宣伝文句を巻き込んでいた
  it('宣伝文句つきの題名から前株の社名だけを取る', () => {
    expect(pickCompanyName('千歳烏山の不動産なら株式会社ゼロエイト')).toBe('株式会社ゼロエイト');
    expect(pickCompanyName('東京の税務なら株式会社サンプル会計｜公式')).toBe('株式会社サンプル会計');
  });

  it('区切りのある題名を分けてから探す', () => {
    expect(pickCompanyName('株式会社サンプル｜総合建設業')).toBe('株式会社サンプル');
    expect(pickCompanyName('採用情報 | サンプル建設株式会社')).toBe('サンプル建設株式会社');
  });

  it('後株は区切りがほぼ社名のときだけ取る', () => {
    expect(pickCompanyName('サンキュウ株式会社')).toBe('サンキュウ株式会社');
    // 宣伝文句に埋もれた後株は取らない (誤った社名を作るより空欄がまし)
    expect(pickCompanyName('福岡の業務用厨房機器の導入ならサンキュウ株式会社')).toBeNull();
  });

  it('会社名が無い題名では取らない', () => {
    expect(pickCompanyName('トップページ')).toBeNull();
    expect(pickCompanyName('お問い合わせ｜採用情報')).toBeNull();
  });

  it('助詞の手前で切る', () => {
    expect(pickCompanyName('株式会社サンプルの公式サイト')).toBe('株式会社サンプル');
  });
});

describe('nameFromCopyright', () => {
  it('著作権表示から社名を拾う', () => {
    expect(nameFromCopyright('© 2026 株式会社サンプル All Rights Reserved.')).toBe('株式会社サンプル');
    expect(nameFromCopyright('Copyright 2026 サンプル工業株式会社')).toBe('サンプル工業株式会社');
  });

  it('社名が無ければ取らない', () => {
    expect(nameFromCopyright('© 2026 All Rights Reserved.')).toBeNull();
  });
});

describe('findRefusal', () => {
  it('営業お断りの表示を見つけて文言を残す', () => {
    const t = 'お問い合わせフォーム 営業目的のお問い合わせはお断りいたします。ご了承ください。';
    expect(findRefusal(t)).toContain('営業目的のお問い合わせはお断り');
  });

  it('言い回しの違いを拾う', () => {
    expect(findRefusal('※営業・勧誘目的のご連絡はご遠慮ください')).not.toBeNull();
    expect(findRefusal('セールス目的のお電話はお控えください')).not.toBeNull();
  });

  it('普通の案内文では反応しない', () => {
    expect(findRefusal('お気軽にお問い合わせください。営業時間は9時から18時です。')).toBeNull();
  });
});

describe('findTel', () => {
  // 実測で見つけた不具合: 郵便番号の中から電話番号を拾っていた
  it('郵便番号を電話番号として拾わない', () => {
    expect(findTel('〒100-0001 東京都千代田区')).toBeNull();
    expect(findTel('〒680-0011')).toBeNull();
  });

  it('郵便番号と電話番号が並んでいても電話番号だけを取る', () => {
    expect(findTel('〒100-0001 東京都千代田区千代田1-1 TEL 03-1234-5678')).toBe('03-1234-5678');
  });

  it('桁数の合わないものは取らない', () => {
    expect(findTel('0120-1')).toBeNull();
    expect(findTel('012345678901234')).toBeNull();
  });

  it('携帯もフリーダイヤルも取る', () => {
    expect(findTel('090-1234-5678')).toBe('090-1234-5678');
    expect(findTel('0120-123-456')).toBe('0120-123-456');
  });
});

describe('extractFromHtml', () => {
  const html = `<!doctype html><html><head><title>株式会社サンプル建設｜公式</title></head>
    <body>
      <table>
        <tr><th>商号</th><td>株式会社サンプル建設</td></tr>
        <tr><th>所在地</th><td>〒680-0011 鳥取県鳥取市東町2-223</td></tr>
        <tr><th>電話番号</th><td>0857-12-3456</td></tr>
      </table>
      <a href="/contact/">お問い合わせ</a>
      <p>営業目的のお問い合わせはお断りしております。</p>
    </body></html>`;

  it('会社概要の表から取る', () => {
    const r = extractFromHtml(html, 'https://example.co.jp/');
    expect(r.name).toBe('株式会社サンプル建設');
    expect(r.address).toContain('鳥取県鳥取市東町');
    expect(r.tel).toBe('0857-12-3456');
  });

  it('問い合わせページを絶対 URL にして返す', () => {
    expect(extractFromHtml(html, 'https://example.co.jp/').contactUrl).toBe('https://example.co.jp/contact/');
  });

  it('営業お断りを検出する', () => {
    expect(extractFromHtml(html, 'https://example.co.jp/').refusedText).toContain('お断り');
  });

  it('表が無くても題名と本文から拾う', () => {
    const plain = `<html><head><title>東京の運送なら株式会社サンプル運輸</title></head>
      <body>〒100-0001 東京都千代田区千代田1-1 TEL 03-1234-5678
      <a href="https://example.jp/inquiry">お問合せ</a></body></html>`;
    const r = extractFromHtml(plain, 'https://example.jp/');
    expect(r.name).toBe('株式会社サンプル運輸');
    expect(r.address).toContain('東京都千代田区');
    expect(r.tel).toBe('03-1234-5678');
    expect(r.contactUrl).toBe('https://example.jp/inquiry');
  });

  it('手がかりが無ければ空で返す (でっち上げない)', () => {
    const r = extractFromHtml('<html><head><title>トップ</title></head><body>ようこそ</body></html>', 'https://x.jp/');
    expect(r.name).toBeNull();
    expect(r.address).toBeNull();
    expect(r.contactUrl).toBeNull();
  });

  it('タグを落として本文だけにする', () => {
    expect(toText('<p>あ<script>var x=1</script>い</p>')).toBe('あ い');
  });
});

describe('問い合わせ先として使ってよいか', () => {
  // 実際に集めてしまったもの。営業文を SNS に投稿する形になっていた
  it('SNS は宛先にしない', () => {
    expect(contactUrlRejectReason('https://line.me/R/ti/p/8hkQT9W_-U')).toBe('SNS');
    expect(contactUrlRejectReason('https://www.instagram.com/itsu2bashi_contact/?hl=ja')).toBe('SNS');
    expect(contactUrlRejectReason('https://www.facebook.com/example/')).toBe('SNS');
  });

  // 実際に集めてしまったもの。応募者向けの窓口に営業を送ることになっていた
  it('採用向けの窓口は宛先にしない', () => {
    expect(contactUrlRejectReason('https://www.aaconst.co.jp/recruit_foreigner/')).toBe('採用向け');
    expect(contactUrlRejectReason('https://acrotec.co.jp/recruitment-information')).toBe('採用向け');
    expect(contactUrlRejectReason('https://recruit.3g-afy.co.jp/new_entry_form')).toBe('採用向け');
    expect(contactUrlRejectReason('https://career.asahi-sun-clean.co.jp/information/')).toBe('採用向け');
    expect(contactUrlRejectReason('https://autoserver.co.jp/careers/contact/')).toBe('採用向け');
  });

  it('語がどこに出たかを見る (社名の一部を採用サイトと取り違えない)', () => {
    // 社名に career を含むだけの会社。ここは営業してよい相手である
    expect(contactUrlRejectReason('https://alta-career.co.jp/contact')).toBeNull();
    // 問い合わせ用紙の入口。応募用紙ではない
    expect(contactUrlRejectReason('https://www.3-win.co.jp/inquiry/entry.php')).toBeNull();
    expect(contactUrlRejectReason('https://armonia.co.jp/contact/entry/')).toBeNull();
    // 一方 応募用紙とわかる形は外す
    expect(contactUrlRejectReason('https://5corporation.co.jp/entryform/')).toBe('採用向け');
  });

  it('資料や別ページも宛先にしない', () => {
    expect(contactUrlRejectReason('https://example.co.jp/pdf/annai.pdf')).toBe('ファイル');
    expect(contactUrlRejectReason('https://example.co.jp/privacy/')).toBe('別ページ');
  });

  it('普通の問い合わせページは通す', () => {
    expect(contactUrlRejectReason('https://example.co.jp/contact/')).toBeNull();
    expect(contactUrlRejectReason('https://example.co.jp/inquiry.html')).toBeNull();
    // 社名にたまたま x が入るだけの先を SNS と取り違えない
    expect(contactUrlRejectReason('https://www.3-ex.com/contact_carport.html')).toBeNull();
  });

  it('弾いた先の次にある正しい問い合わせページを拾う', () => {
    const html = `<a href="/recruit/contact/">採用のお問い合わせ</a>
                  <a href="https://www.instagram.com/foo/">お問い合わせ</a>
                  <a href="/contact/">お問い合わせ</a>`;
    const e = extractFromHtml(html, 'https://example.co.jp/');
    expect(e.contactUrl).toBe('https://example.co.jp/contact/');
  });
});
