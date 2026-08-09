import { describe, expect, it } from 'vitest';
import {
  contactUrlRejectReason,
  emailRejectReason,
  extractFromHtml,
  findEmail,
  findObfuscatedEmail,
  findRepresentative,
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

describe('宛先に使えないメールを外す', () => {
  // 実データで拾ってしまった見本アドレス。これを宛先にすると届かない
  it('雛形のまま公開されている見本を外す', () => {
    expect(emailRejectReason('sample@address.com')).toBe('見本');
    expect(emailRejectReason('test@example.com')).toBe('見本');
    expect(emailRejectReason('info@yourdomain.jp')).toBe('見本');
  });

  it('送信専用と採用専用を外す', () => {
    expect(emailRejectReason('noreply@kaisha.co.jp')).toBe('送信専用');
    expect(emailRejectReason('recruit@sample-corp.co.jp')).toBe('採用専用');
    expect(emailRejectReason('saiyo@kaisha.co.jp')).toBe('採用専用');
  });

  it('普通の問い合わせ先は通す', () => {
    expect(emailRejectReason('info@kaisha.co.jp')).toBeNull();
    expect(emailRejectReason('soumu@kaisha.co.jp')).toBeNull();
    // 社名にたまたま test が入るだけの先を見本と取り違えない
    expect(emailRejectReason('info@testing-lab.co.jp')).toBeNull();
  });

  it('見本しか無いページからは何も取らない', () => {
    expect(findEmail('<a href="mailto:sample@address.com">連絡</a>', 'sample@address.com')).toBeNull();
  });
});

describe('難読化して書かれたメールを読み取る', () => {
  // 迷惑メール避けの書き方を戻すだけ。無いものを作り出してはいけない
  it('at と dot の書き換えを戻す', () => {
    expect(findObfuscatedEmail('info [at] kaisha.jp までご連絡ください')).toBe('info@kaisha.jp');
    expect(findObfuscatedEmail('お問い合わせ: soumu(at)kaisha(dot)co(dot)jp')).toBe('soumu@kaisha.co.jp');
  });

  it('全角のアットマークを戻す', () => {
    expect(findObfuscatedEmail('info＠kaisha.co.jp')).toBe('info@kaisha.co.jp');
  });

  it('数値文字参照で書かれたメールを読む', () => {
    const text = '&#105;&#110;&#102;&#111;@kaisha.co.jp';
    expect(findEmail('', text)).toBe('info@kaisha.co.jp');
  });

  it('難読化されていても見本なら採らない', () => {
    expect(findObfuscatedEmail('sample [at] address.com')).toBeNull();
  });

  it('メールでないものを拾わない', () => {
    expect(findObfuscatedEmail('営業時間 9:00 at 18:00')).toBeNull();
  });
});

describe('代表者名を拾う', () => {
  it('会社概要の書き方から取る', () => {
    expect(findRepresentative('代表取締役　山田 太郎')).toBe('山田 太郎');
    expect(findRepresentative('代表者：佐藤花子')).toBe('佐藤花子');  // 書かれていない区切りは作らない
    expect(findRepresentative('代表取締役社長 鈴木一郎')).toBe('鈴木一郎');
  });

  it('部署や役職を人名と取り違えない', () => {
    expect(findRepresentative('代表取締役社長室のご案内')).toBeNull();
    expect(findRepresentative('代表取締役 挨拶')).toBeNull();
  });

  it('書かれていなければ取らない', () => {
    expect(findRepresentative('会社概要 資本金 1000万円')).toBeNull();
  });

  // 会社概要は表なので、隣の見出しに食い込むことがある
  it('うしろに続く見出し語を切り落とす', () => {
    expect(findRepresentative('代表者 宇佐美浩一 設立 2015年')).toBe('宇佐美浩一');
    expect(findRepresentative('代表取締役　田中一郎　資本金')).toBe('田中一郎');
  });

  it('見出し語しか続かないなら取らない', () => {
    expect(findRepresentative('代表者 設立 2015年')).toBeNull();
  });

  // 実データ: 講座の名前を人名として取っていた
  it('漢字とカタカナが混ざった長い語は人名として取らない', () => {
    expect(findRepresentative('代表者 発信力向上プログラム')).toBeNull();
    expect(findRepresentative('代表者 統合マネジメントシステム')).toBeNull();
  });

  it('カタカナだけの名前は、姓名が分かれていれば取る', () => {
    expect(findRepresentative('代表取締役 ジョン スミス')).toBe('ジョン スミス');
    expect(findRepresentative('代表取締役 ジョン・スミス')).toBe('ジョン・スミス');
  });

  // 実データで残っていた取り違え
  it('人名でない語を取らない', () => {
    expect(findRepresentative('代表者 名鑑')).toBeNull();
    expect(findRepresentative('代表者 など')).toBeNull();
  });

  it('見出し語の先頭 1 字が残った形を切る', () => {
    expect(findRepresentative('代表者 猪又晃晴 設立')).toBe('猪又晃晴');
  });

  // 実データ: 見出しの「インタビュー」を人名として取っていた
  it('区切りの無いカタカナ語は人名として取らない', () => {
    expect(findRepresentative('代表者 インタビュー')).toBeNull();
    expect(findRepresentative('代表者 プロフィール')).toBeNull();
  });

  it('長すぎるものは人名とみなさない', () => {
    expect(findRepresentative('代表者 特定非営利活動')).toBeNull();
  });
});
