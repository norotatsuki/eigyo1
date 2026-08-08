/**
 * 送信の設定。
 *
 * ここが埋まるまで実送信はできない。埋め忘れたまま送ると
 * 特定電子メール法 4 条の表示義務を欠くことになるため、
 * 「足りない項目を挙げて止める」を既定の振る舞いにする。
 *
 * 置き場所は `outreach.config.json` (プロジェクト直下)。
 * 認証情報だけは環境変数から読む。設定ファイルに書かせない。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_PATH = join(process.cwd(), 'outreach.config.json');

/** 特定電子メール法 4 条が求める表示。メールにはこの 4 つが必ず要る。 */
export interface SenderIdentity {
  /** 送信者の氏名または名称 */
  name: string;
  /** 送信者の住所 */
  address: string;
  /** 受信拒否の通知先 (URL またはメールアドレス) */
  optOutUrl: string;
  /** 苦情・問い合わせの受付先 */
  inquiryContact: string;
}

export interface EmailConfig {
  /** 送信専用ドメイン。本業のドメインとは分けること */
  fromAddress: string;
  fromName: string;
  replyTo?: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    /** 利用者名。パスワードは環境変数 EIGYO_SMTP_PASS から読む */
    user: string;
  };
}

export interface FormConfig {
  /** フォームに入れる自社の連絡先 */
  senderCompany: string;
  senderPerson: string;
  senderEmail: string;
  senderTel: string;
}

export interface Caps {
  /** 1 日に送る上限 (経路ごと) */
  perDay: number;
  /** 1 時間に送る上限 */
  perHour: number;
}

export interface OutreachConfig {
  identity: SenderIdentity;
  email?: EmailConfig;
  form?: FormConfig;
  caps: Record<string, Caps>;
}

/**
 * よく使う送信元の設定。
 *
 * Gmail は「アプリパスワード」で SMTP を使う。二段階認証を有効にしたうえで
 * https://myaccount.google.com/apppasswords から発行し、
 * 環境変数 EIGYO_SMTP_PASS に入れる (設定ファイルには書かない)。
 *
 * 上限は Google 側の制限に合わせて低めにしてある。
 * 無料の Gmail は 1 日 500 通、Google Workspace は 2,000 通。
 * それ以前に迷惑メール報告が続くとアカウント自体が止まるため、
 * 少量から始めて反応を見ること。
 */
export const SMTP_PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: 587, secure: false },
  workspace: { host: 'smtp.gmail.com', port: 587, secure: false },
} as const;

export type SmtpPreset = keyof typeof SMTP_PRESETS;

/** 送信元の種類に応じた 1 日の上限の目安。 */
export const PRESET_DAILY_CAP: Readonly<Record<SmtpPreset, number>> = {
  gmail: 100,      // 無料 Gmail の上限は 500 だが、評価を守るため控えめに始める
  workspace: 300,  // Workspace の上限は 2,000。同上
};

const DEFAULT_CAPS: Record<string, Caps> = {
  postal: { perDay: 5000, perHour: 5000 },
  // 送信ドメインの評価を守るため、メールは少なく始めて徐々に増やす
  email: { perDay: 200, perHour: 40 },
  form: { perDay: 100, perHour: 20 },
  phone: { perDay: 100, perHour: 20 },
};

export interface ConfigCheck {
  config: OutreachConfig | null;
  /** 実送信に足りない項目。空なら送れる */
  missing: string[];
}

/** 設定を読み、実送信できる状態かを検める。 */
export function loadConfig(path = CONFIG_PATH): ConfigCheck {
  if (!existsSync(path)) {
    return { config: null, missing: [`設定ファイルがありません: ${path}`] };
  }
  let raw: Partial<OutreachConfig>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<OutreachConfig>;
  } catch (err) {
    return { config: null, missing: [`設定ファイルを読めません: ${err instanceof Error ? err.message : err}`] };
  }

  const missing: string[] = [];
  // 根拠は 1 行ずつ書く。「同上」だと、最初の項目が埋まっているときに
  // なぜ必要なのかが読み手に伝わらない
  const id = raw.identity;
  const LAW = '特定電子メール法 4 条';
  if (!id?.name) missing.push(`identity.name (送信者の名称) — ${LAW}`);
  if (!id?.address) missing.push(`identity.address (送信者の住所) — ${LAW}`);
  if (!id?.optOutUrl) missing.push(`identity.optOutUrl (受信拒否の通知先) — ${LAW}`);
  if (!id?.inquiryContact) missing.push(`identity.inquiryContact (問い合わせ先) — ${LAW}`);

  const config: OutreachConfig = {
    identity: {
      name: id?.name ?? '', address: id?.address ?? '',
      optOutUrl: id?.optOutUrl ?? '', inquiryContact: id?.inquiryContact ?? '',
    },
    ...(raw.email ? { email: raw.email } : {}),
    ...(raw.form ? { form: raw.form } : {}),
    caps: { ...DEFAULT_CAPS, ...(raw.caps ?? {}) },
  };
  return { config, missing };
}

/** その経路で実際に送れるかを検める。足りない項目を返す。 */
export function checkChannelReady(config: OutreachConfig | null, channel: string): string[] {
  if (!config) return ['設定が読み込めていません'];
  const missing: string[] = [];

  if (channel === 'email') {
    const e = config.email;
    if (!e?.fromAddress) missing.push('email.fromAddress (送信元アドレス)');
    if (!e?.fromName) missing.push('email.fromName (送信者名)');
    if (!e?.smtp?.host) missing.push('email.smtp.host');
    if (!e?.smtp?.user) missing.push('email.smtp.user');
    if (!process.env['EIGYO_SMTP_PASS']) missing.push('環境変数 EIGYO_SMTP_PASS (送信の認証情報)');
  }
  if (channel === 'form') {
    const f = config.form;
    if (!f?.senderCompany) missing.push('form.senderCompany (自社名)');
    if (!f?.senderPerson) missing.push('form.senderPerson (担当者名)');
    if (!f?.senderEmail) missing.push('form.senderEmail (返信先アドレス)');
    if (!f?.senderTel) missing.push('form.senderTel (電話番号)');
  }
  return missing;
}

/** 設定ファイルのひな形。`init-config` で書き出す。 */
export function configTemplate(preset?: SmtpPreset): typeof CONFIG_TEMPLATE {
  if (!preset) return CONFIG_TEMPLATE;
  return {
    ...CONFIG_TEMPLATE,
    email: {
      ...CONFIG_TEMPLATE.email,
      smtp: { ...SMTP_PRESETS[preset], user: '' },
    },
    caps: {
      ...CONFIG_TEMPLATE.caps,
      email: { perDay: PRESET_DAILY_CAP[preset], perHour: Math.ceil(PRESET_DAILY_CAP[preset] / 8) },
    },
  };
}

export const CONFIG_TEMPLATE = {
  identity: {
    name: '',
    address: '',
    optOutUrl: '',
    inquiryContact: '',
  },
  email: {
    fromAddress: '',
    fromName: '',
    replyTo: '',
    smtp: { host: '', port: 587, secure: false, user: '' },
  },
  form: { senderCompany: '', senderPerson: '', senderEmail: '', senderTel: '' },
  caps: DEFAULT_CAPS,
};
