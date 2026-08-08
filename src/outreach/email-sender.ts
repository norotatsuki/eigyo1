/**
 * メール送信。
 *
 * 到達性がすべてを決める。迷惑メール判定されたら 0 件と同じなので、
 *   送信専用ドメインを本業と分ける / SPF・DKIM・DMARC を整える /
 *   少量から始めて徐々に増やす
 * を運用側の前提とし、ここでは「法定の表示を欠いたまま送らせない」ことを担う。
 *
 * 認証情報は設定ファイルに書かせず、環境変数 EIGYO_SMTP_PASS から読む。
 */
import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailConfig, OutreachConfig } from './config.ts';

export interface Mailer {
  transport: Transporter;
  from: string;
}

export type EmailOutcome =
  | { status: 'sent'; messageId: string }
  | { status: 'failed'; reason: string };

/** 送信の口を用意し、実際に繋がることを確かめてから返す。 */
export async function verifyMailer(config: EmailConfig): Promise<Mailer> {
  const pass = process.env['EIGYO_SMTP_PASS'];
  if (!pass) throw new Error('環境変数 EIGYO_SMTP_PASS が設定されていません');

  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass },
  });
  // 繋がらないまま何百通も試すと、送信元の評価を落とす。先に確かめる
  await transport.verify();
  return { transport, from: `${config.fromName} <${config.fromAddress}>` };
}

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

/**
 * 1 通送る。
 *
 * 配信停止の口を List-Unsubscribe にも入れる。本文の記載は法定の要件だが、
 * 受信側の「登録解除」ボタンから外せる方が相手の手間が少なく、
 * 苦情として報告される確率も下がる。
 */
export async function sendEmail(
  mailer: Mailer,
  config: OutreachConfig,
  message: EmailMessage,
): Promise<EmailOutcome> {
  try {
    const optOut = config.identity.optOutUrl;
    const info = await mailer.transport.sendMail({
      from: mailer.from,
      to: message.to,
      subject: message.subject,
      text: message.body,
      ...(config.email?.replyTo ? { replyTo: config.email.replyTo } : {}),
      headers: optOut
        ? {
            'List-Unsubscribe': optOut.startsWith('http') ? `<${optOut}>` : `<mailto:${optOut}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          }
        : {},
    });
    return { status: 'sent', messageId: String(info.messageId ?? '') };
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}
