/**
 * 施策の実行。絞り込み → 送信前ゲート → 差し込み → 送信 → 記録 を繋ぐ。
 *
 * 既定は下見 (dry run)。何が誰に送られるかを先に見せる。
 * `live` を明示したときだけ実際に送る。事故は「うっかり本番」で起きる。
 */
import { mkdirSync } from 'node:fs';
import type { Db } from '../db/index.ts';
import { searchCompanies, type CompanyRow, type SearchFilter } from '../search/query.ts';
import { applyGate, recordOutreach, type Channel } from './gate.ts';
import { checkChannelReady, type OutreachConfig } from './config.ts';
import { checkTemplate, placeholdersIn, render, type Template, type TemplateVars } from './template.ts';
import { openBrowser, sendToForm, valuesFrom } from './form-sender.ts';
import { sendEmail, verifyMailer, type Mailer } from './email-sender.ts';

export interface RunOptions {
  /** 実際に送る。指定しなければ下見のみ */
  live?: boolean;
  /** 送る上限。設定の日次上限より小さい方を採る */
  limit?: number;
  campaign: string;
  /** 送信の間隔 (ミリ秒) */
  delayMs?: number;
  evidenceDir?: string;
  onProgress?: (done: number, sent: number) => void;
}

export interface RunResult {
  live: boolean;
  candidates: number;
  blockedByGate: number;
  blockedByReason: Record<string, number>;
  attempted: number;
  sent: number;
  skipped: number;
  failed: number;
  /** 送らなかった理由の内訳 */
  skipReasons: Record<string, number>;
  /** 実行を始められなかった理由。空なら実行した */
  blockers: string[];
  /** 下見のときの、最初の 1 通の中身 */
  preview: { to: string; subject: string; body: string } | null;
  /** 差し込みが埋まらないために送れない先の数 */
  emptyPlaceholder: number;
}

/**
 * その会社では値が埋まらない差し込みを挙げる。
 *
 * 空のまま送ると「{{業種}}の皆さま」が「の皆さま」になる。
 * 相手に届く文章としてみっともないので、埋まらない先には送らない。
 */
export function emptyPlaceholders(template: Template, vars: TemplateVars): string[] {
  const used = placeholdersIn(`${template.subject} ${template.body}`);
  return used.filter((p) => {
    const v = (vars as unknown as Record<string, string | undefined>)[p];
    return v === undefined || v.trim() === '';
  });
}

/** 会社 1 件から差し込みの値を作る。 */
export function varsFor(row: CompanyRow, config: OutreachConfig): TemplateVars {
  return {
    会社名: row.name,
    法人番号: row.corporate_number,
    都道府県: row.pref_name,
    市区町村: row.city_name,
    業種: row.industry_name ?? '',
    宛名: 'ご担当者様',
    自社名: config.identity.name,
    自社住所: config.identity.address,
    配信停止: config.identity.optOutUrl,
    問い合わせ先: config.identity.inquiryContact,
  };
}

/** 今日すでに送った件数。上限の判定に使う。 */
export function sentToday(db: Db, channel: Channel, now = new Date()): number {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM outreach_log
        WHERE channel = ? AND outcome = 'sent' AND occurred_at >= ?`,
    )
    .get(channel, from.toISOString()) as { n: number };
  return row.n;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 施策を走らせる。
 *
 * 送る前に必ず 3 つを検める。1 つでも欠ければ実行しない。
 *   設定    … 送信元・法定表示・認証情報
 *   ひな形  … 特定電子メール法 4 条の表示が本文に出ているか
 *   上限    … その日にもう送りすぎていないか
 */
export async function runCampaign(
  db: Db,
  filter: SearchFilter,
  channel: Channel,
  template: Template,
  config: OutreachConfig | null,
  options: RunOptions,
): Promise<RunResult> {
  const result: RunResult = {
    live: options.live === true,
    candidates: 0, blockedByGate: 0, blockedByReason: {},
    attempted: 0, sent: 0, skipped: 0, failed: 0, skipReasons: {},
    blockers: [], preview: null, emptyPlaceholder: 0,
  };

  if (!config) {
    result.blockers.push('設定がありません (init-config で作成してください)');
    return result;
  }
  if (template.channel !== channel) {
    result.blockers.push(`ひな形の経路が違います (ひな形=${template.channel} / 指定=${channel})`);
  }
  const tpl = checkTemplate(template, config);
  if (!tpl.ok) result.blockers.push(...tpl.problems);

  // 実際に送るときだけ、認証情報まで検める。下見は設定が不完全でもできる
  if (options.live === true) {
    result.blockers.push(...checkChannelReady(config, channel));
  }
  if (result.blockers.length > 0) return result;

  const cap = config.caps[channel]?.perDay ?? 0;
  const already = sentToday(db, channel);
  const remaining = Math.max(0, cap - already);
  const limit = Math.min(options.limit ?? remaining, remaining || (options.live === true ? 0 : (options.limit ?? 20)));
  if (options.live === true && remaining === 0) {
    result.blockers.push(`本日の上限に達しています (${channel}: ${already}/${cap})`);
    return result;
  }

  // 候補を集めてゲートに通す。止めた分はゲートが記録する
  const rows = searchCompanies(db, filter, { limit: Math.max(limit * 3, limit) });
  result.candidates = rows.length;
  const gate = applyGate(db, rows.map((r) => r.corporate_number), channel, { campaign: options.campaign });
  result.blockedByGate = gate.blocked.length;
  result.blockedByReason = gate.blockedByReason;

  const allowed = new Set(gate.allowed);
  const targets = rows.filter((r) => allowed.has(r.corporate_number)).slice(0, limit);

  // 差し込みが埋まらない先を先に外す。空欄のまま送ると文章が壊れる
  const sendable = targets.filter((row) => {
    const empty = emptyPlaceholders(template, varsFor(row, config));
    if (empty.length > 0) {
      result.emptyPlaceholder++;
      const key = `差し込みが空: ${empty.join(', ')}`;
      result.skipReasons[key] = (result.skipReasons[key] ?? 0) + 1;
      return false;
    }
    return true;
  });

  // 下見: 1 通目の中身だけを見せて終わる
  if (options.live !== true) {
    const first = sendable[0];
    if (first) {
      const vars = varsFor(first, config);
      const dest = channel === 'email' ? first.contact_email : channel === 'form' ? first.contact_form_url : null;
      result.preview = {
        to: `${first.name}${dest ? ` — ${dest}` : ''}`,
        subject: render(template.subject, vars),
        body: render(template.body, vars),
      };
    }
    result.attempted = sendable.length;
    result.skipped = result.emptyPlaceholder;
    return result;
  }

  if (options.evidenceDir) mkdirSync(options.evidenceDir, { recursive: true });
  const delayMs = options.delayMs ?? 3000;

  const noteSkip = (reason: string): void => {
    result.skipped++;
    const key = reason.slice(0, 40);
    result.skipReasons[key] = (result.skipReasons[key] ?? 0) + 1;
  };

  const finalTargets = sendable;
  result.skipped = result.emptyPlaceholder;

  if (channel === 'form') {
    const browser = await openBrowser();
    try {
      for (const row of finalTargets) {
        result.attempted++;
        const vars = varsFor(row, config);
        const values = valuesFrom(config.form!, render(template.subject, vars), render(template.body, vars));
        const url = row.contact_form_url;
        if (!url) {
          noteSkip('問い合わせ先が分かりません');
          recordOutreach(db, { corporateNumber: row.corporate_number, channel, outcome: 'blocked', blockedReason: 'no_destination', campaign: options.campaign });
          continue;
        }
        const { outcome } = await sendToForm(browser, url, values, {
          live: true,
          ...(options.evidenceDir ? { evidenceDir: options.evidenceDir } : {}),
        });
        if (outcome.status === 'sent') {
          result.sent++;
          recordOutreach(db, { corporateNumber: row.corporate_number, channel, outcome: 'sent', campaign: options.campaign, note: outcome.evidence });
        } else if (outcome.status === 'skipped') {
          noteSkip(outcome.reason);
          recordOutreach(db, { corporateNumber: row.corporate_number, channel, outcome: 'blocked', blockedReason: outcome.reason, campaign: options.campaign });
        } else {
          result.failed++;
          recordOutreach(db, { corporateNumber: row.corporate_number, channel, outcome: 'failed', campaign: options.campaign, note: outcome.reason });
        }
        options.onProgress?.(result.attempted, result.sent);
        await sleep(delayMs);
      }
    } finally {
      await browser.close();
    }
    return result;
  }

  if (channel === 'email') {
    const mailer: Mailer = await verifyMailer(config.email!);
    for (const row of finalTargets) {
      result.attempted++;
      const to = row.contact_email;
      if (!to) {
        noteSkip('メールアドレスが分かりません');
        recordOutreach(db, { corporateNumber: row.corporate_number, channel, outcome: 'blocked', blockedReason: 'no_destination', campaign: options.campaign });
        continue;
      }
      const vars = varsFor(row, config);
      const outcome = await sendEmail(mailer, config, {
        to, subject: render(template.subject, vars), body: render(template.body, vars),
      });
      if (outcome.status === 'sent') {
        result.sent++;
        recordOutreach(db, { corporateNumber: row.corporate_number, channel, outcome: 'sent', campaign: options.campaign, note: outcome.messageId });
      } else {
        result.failed++;
        recordOutreach(db, { corporateNumber: row.corporate_number, channel, outcome: 'failed', campaign: options.campaign, note: outcome.reason });
      }
      options.onProgress?.(result.attempted, result.sent);
      await sleep(delayMs);
    }
    return result;
  }

  // 郵送と電話は人が動く。ここでは「送った」の記録だけを引き受ける
  for (const row of finalTargets) {
    result.attempted++;
    result.sent++;
    recordOutreach(db, { corporateNumber: row.corporate_number, channel, outcome: 'sent', campaign: options.campaign });
  }
  return result;
}
