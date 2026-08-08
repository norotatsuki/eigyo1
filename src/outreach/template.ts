/**
 * 文面のひな形と差し込み。
 *
 * 一律の文面は読まれない。かといって全件を手で書くことはできない。
 * 骨格は人が書き、会社ごとに変わるところだけを差し込む。
 *
 * メールについては、特定電子メール法 4 条が求める 4 項目
 * (送信者の名称 / 住所 / 受信拒否の通知先 / 問い合わせ先) が
 * 文面に含まれていなければ送らせない。これは検証で強制する。
 */
import type { OutreachConfig } from './config.ts';

/** 差し込みに使える値。 */
export interface TemplateVars {
  会社名: string;
  法人番号: string;
  都道府県: string;
  市区町村: string;
  業種: string;
  /** 宛名。部署が分からないので既定は「ご担当者様」 */
  宛名: string;
  /** 設定から入る自社の情報 */
  自社名: string;
  自社住所: string;
  配信停止: string;
  問い合わせ先: string;
}

export interface Template {
  name: string;
  channel: string;
  /** メールの件名。フォームでは表題の欄に使う */
  subject: string;
  body: string;
}

const PLACEHOLDER = /\{\{\s*([^}\s]+)\s*\}\}/g;

/** ひな形に値を差し込む。未知の名前はそのまま残さず空にする (中括弧が相手に届かないように)。 */
export function render(text: string, vars: Partial<TemplateVars>): string {
  return text.replace(PLACEHOLDER, (_, key: string) => {
    const v = (vars as Record<string, string | undefined>)[key];
    return v ?? '';
  });
}

/** ひな形が使っている差し込み名の一覧。 */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string))];
}

export interface TemplateCheck {
  ok: boolean;
  problems: string[];
}

/**
 * 送る前にひな形を検める。
 *
 * メールは特定電子メール法 4 条の 4 項目が本文に出ていなければ通さない。
 * 差し込みで入る形 ({{自社名}} など) でも、差し込み後に実際の値が
 * 入ることを確かめる。
 */
export function checkTemplate(template: Template, config: OutreachConfig): TemplateCheck {
  const problems: string[] = [];

  if (template.subject.trim() === '') problems.push('件名が空です');
  if (template.body.trim() === '') problems.push('本文が空です');

  const unknown = placeholdersIn(`${template.subject} ${template.body}`).filter(
    (p) => !ALLOWED_PLACEHOLDERS.includes(p),
  );
  if (unknown.length > 0) {
    problems.push(`使えない差し込み名: ${unknown.join(', ')} (使えるのは ${ALLOWED_PLACEHOLDERS.join(', ')})`);
  }

  if (template.channel === 'email') {
    const rendered = render(template.body, {
      自社名: config.identity.name,
      自社住所: config.identity.address,
      配信停止: config.identity.optOutUrl,
      問い合わせ先: config.identity.inquiryContact,
    });
    const required: Array<[string, string]> = [
      ['送信者の名称', config.identity.name],
      ['送信者の住所', config.identity.address],
      ['受信拒否の通知先', config.identity.optOutUrl],
      ['問い合わせ先', config.identity.inquiryContact],
    ];
    for (const [label, value] of required) {
      if (value === '' || !rendered.includes(value)) {
        problems.push(`本文に ${label} が出ていません — 特定電子メール法 4 条`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

export const ALLOWED_PLACEHOLDERS: readonly string[] = [
  '会社名', '法人番号', '都道府県', '市区町村', '業種', '宛名',
  '自社名', '自社住所', '配信停止', '問い合わせ先',
];

/** 法定表示を満たすメールのひな形。そのまま使わず、骨格として書き換えること。 */
export const EMAIL_TEMPLATE_SKELETON: Template = {
  name: 'email-skeleton',
  channel: 'email',
  subject: '{{会社名}} {{宛名}} — ご提案のご連絡',
  body: `{{会社名}}
{{宛名}}

突然のご連絡失礼いたします。{{自社名}}の担当でございます。

（ここに用件を書く。相手に何の得があるのかを最初の3行で。）

ご不要の場合は以下より配信停止のお手続きをお願いいたします。
{{配信停止}}

--
{{自社名}}
{{自社住所}}
お問い合わせ: {{問い合わせ先}}
`,
};

/** 問い合わせフォームに入れる文面の骨格。 */
export const FORM_TEMPLATE_SKELETON: Template = {
  name: 'form-skeleton',
  channel: 'form',
  subject: 'ご提案のご連絡',
  body: `突然のご連絡失礼いたします。{{自社名}}でございます。

（ここに用件を書く。フォームは文字数制限があることが多いので短く。）

ご不要でしたらご放念ください。
`,
};
