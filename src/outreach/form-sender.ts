/**
 * 問い合わせフォームへの送信。
 *
 * 相手のフォームは千差万別なので、欄の意味を見出しから推し量って埋める。
 * 推し量れない必須欄が残ったら送らない。中途半端な内容を相手に届けない。
 *
 * **CAPTCHA を見つけたら必ず中止する。** 突破は不正アクセス禁止法と
 * 業務妨害の領域に入る。回避策を実装してはいけない。
 */
import { chromium, type Browser, type Page } from '@playwright/test';
import type { FormConfig } from './config.ts';

/** 欄の意味。見出しや属性から推し量る。 */
export type FieldKind =
  | 'company' | 'person' | 'kana' | 'email' | 'email_confirm'
  | 'tel' | 'subject' | 'message' | 'address' | 'postal' | 'url'
  | 'agree' | 'unknown';

/** 見出し・属性に現れる語から欄の意味を当てる。長い語から照合する。 */
const FIELD_HINTS: ReadonlyArray<readonly [FieldKind, readonly string[]]> = [
  ['email_confirm', ['メールアドレス確認', 'メール確認', 'confirm_email', 'email_confirm', 'email2', 'mail_conf']],
  ['kana', ['フリガナ', 'ふりがな', 'カナ', 'kana', 'furigana']],
  ['company', ['会社名', '御社名', '貴社名', '法人名', '企業名', '団体名', 'company', 'corp', 'organization']],
  ['person', ['担当者', 'ご担当', 'お名前', '氏名', '名前', 'name', 'yourname']],
  ['email', ['メールアドレス', 'メール', 'e-mail', 'email', 'mail']],
  ['tel', ['電話番号', 'お電話', '電話', 'tel', 'phone']],
  ['postal', ['郵便番号', 'zip', 'postal']],
  ['address', ['住所', '所在地', 'address']],
  ['url', ['ホームページ', 'サイト', 'url', 'website']],
  ['subject', ['件名', '題名', 'お問い合わせ種別', '用件', 'subject', 'title']],
  ['message', ['お問い合わせ内容', 'お問合せ内容', '内容', 'ご相談', 'メッセージ', 'body', 'message', 'inquiry', 'content']],
  ['agree', ['同意', '承諾', '個人情報の取扱', 'agree', 'consent', 'privacy']],
];

/** CAPTCHA の気配。1 つでもあれば送らない。 */
const CAPTCHA_MARKERS = [
  'g-recaptcha', 'recaptcha', 'h-captcha', 'hcaptcha', 'cf-turnstile', 'turnstile',
  '画像認証', '認証コード', 'captcha',
];

export interface FormField {
  selector: string;
  kind: FieldKind;
  tag: 'input' | 'textarea' | 'select';
  type: string;
  required: boolean;
  label: string;
}

export interface FormAnalysis {
  found: boolean;
  formSelector: string | null;
  fields: FormField[];
  hasCaptcha: boolean;
  captchaEvidence: string | null;
  submitSelector: string | null;
  /** 意味を当てられなかった必須欄 */
  unmappedRequired: FormField[];
}

export interface FormValues {
  company: string;
  person: string;
  kana?: string;
  email: string;
  tel: string;
  subject: string;
  message: string;
}

/** 設定から、フォームに入れる値を組み立てる。 */
export function valuesFrom(config: FormConfig, subject: string, message: string): FormValues {
  return {
    company: config.senderCompany,
    person: config.senderPerson,
    email: config.senderEmail,
    tel: config.senderTel,
    subject,
    message,
  };
}

function guessKind(haystack: string): FieldKind {
  const h = haystack.toLowerCase();
  for (const [kind, hints] of FIELD_HINTS) {
    if (hints.some((x) => h.includes(x.toLowerCase()))) return kind;
  }
  return 'unknown';
}

/** ページを読んで、フォームの構造を把握する。送信はしない。 */
export async function analyzeForm(page: Page): Promise<FormAnalysis> {
  const html = await page.content();
  const lower = html.toLowerCase();
  const marker = CAPTCHA_MARKERS.find((m) => lower.includes(m.toLowerCase()));

  const raw = await page.evaluate(() => {
    const forms = [...document.querySelectorAll('form')];
    // 入力欄が最も多いフォームを本命とみなす
    const target = forms
      .map((f) => ({ f, n: f.querySelectorAll('input,textarea,select').length }))
      .sort((a, b) => b.n - a.n)[0]?.f;
    if (!target) return null;

    // 見出しの探し方。表の場合は「同じ行の th」を見る。
    // 直前の兄弟要素を先に見ると、1 行ずれて隣の欄の見出しを拾ってしまう
    // (会社名の欄に氏名が入る、という形で実際に起きた)。
    const labelFor = (el: Element): string => {
      const id = el.getAttribute('id');
      if (id) {
        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (l?.textContent) return l.textContent;
      }
      const wrap = el.closest('label');
      if (wrap?.textContent) return wrap.textContent;

      const tr = el.closest('tr');
      const th = tr?.querySelector('th');
      if (th?.textContent) return th.textContent;

      const dd = el.closest('dd');
      const dt = dd?.previousElementSibling;
      if (dt?.tagName === 'DT' && dt.textContent) return dt.textContent;

      const cell = el.closest('td');
      const prevCell = cell?.previousElementSibling;
      if (prevCell?.textContent) return prevCell.textContent;

      const row = el.closest('li,div,p');
      return row?.previousElementSibling?.textContent ?? '';
    };

    const nth = (el: Element): string => {
      const same = [...target.querySelectorAll(el.tagName.toLowerCase())];
      return `${el.tagName.toLowerCase()}:nth-of-type(${same.indexOf(el) + 1})`;
    };

    const fields = [...target.querySelectorAll('input,textarea,select')]
      .filter((el) => {
        const t = (el.getAttribute('type') ?? '').toLowerCase();
        return !['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(t);
      })
      .map((el) => {
        const name = el.getAttribute('name') ?? '';
        const id = el.getAttribute('id') ?? '';
        return {
          selector: name ? `[name="${name}"]` : id ? `#${id}` : nth(el),
          tag: el.tagName.toLowerCase(),
          type: (el.getAttribute('type') ?? (el.tagName === 'TEXTAREA' ? 'textarea' : 'text')).toLowerCase(),
          required: el.hasAttribute('required') || /必須/.test(labelFor(el)),
          label: `${labelFor(el)} ${name} ${id} ${el.getAttribute('placeholder') ?? ''}`
            .replace(/\s+/g, ' ').trim().slice(0, 120),
        };
      });

    const submit = target.querySelector(
      'button[type=submit],input[type=submit],button:not([type]),input[type=image]',
    );
    return {
      formSelector: target.id ? `#${target.id}` : 'form',
      fields,
      submitSelector: submit
        ? submit.id
          ? `#${submit.id}`
          : `${target.id ? `#${target.id} ` : 'form '}${submit.tagName.toLowerCase()}[type="${submit.getAttribute('type') ?? 'submit'}"]`
        : null,
    };
  });

  if (!raw) {
    return {
      found: false, formSelector: null, fields: [], hasCaptcha: Boolean(marker),
      captchaEvidence: marker ?? null, submitSelector: null, unmappedRequired: [],
    };
  }

  const fields: FormField[] = raw.fields.map((f) => ({
    selector: f.selector,
    kind: guessKind(f.label),
    tag: f.tag as FormField['tag'],
    type: f.type,
    required: f.required,
    label: f.label,
  }));

  return {
    found: true,
    formSelector: raw.formSelector,
    fields,
    hasCaptcha: Boolean(marker),
    captchaEvidence: marker ?? null,
    submitSelector: raw.submitSelector,
    unmappedRequired: fields.filter(
      (f) => f.required && f.kind === 'unknown' && !['checkbox', 'radio'].includes(f.type),
    ),
  };
}

/** 欄の意味に応じて入れる値を決める。 */
export function valueForField(field: FormField, v: FormValues): string | null {
  switch (field.kind) {
    case 'company': return v.company;
    case 'person': return v.person;
    case 'kana': return v.kana ?? null;
    case 'email':
    case 'email_confirm': return v.email;
    case 'tel': return v.tel;
    case 'subject': return v.subject;
    case 'message': return v.message;
    default: return null;
  }
}

export type SendOutcome =
  | { status: 'sent'; evidence: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

export interface SendFormOptions {
  /** 実際に送信ボタンを押すか。既定は押さない */
  live?: boolean;
  /** 送信後の画面を残す場所 */
  evidenceDir?: string;
  timeoutMs?: number;
}

/**
 * 1 件のフォームに送る。
 *
 * `live` を渡さない限り送信ボタンは押さない。押さない場合でも
 * 欄の対応づけまでは行うので、何が送られるかを事前に確かめられる。
 */
export async function sendToForm(
  browser: Browser,
  url: string,
  values: FormValues,
  options: SendFormOptions = {},
): Promise<{ outcome: SendOutcome; analysis: FormAnalysis | null }> {
  const timeout = options.timeoutMs ?? 30_000;
  const context = await browser.newContext({ locale: 'ja-JP' });
  const page = await context.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    if (!res || !res.ok()) {
      return { outcome: { status: 'failed', reason: `ページを開けません (HTTP ${res?.status() ?? '?'})` }, analysis: null };
    }

    const analysis = await analyzeForm(page);

    // CAPTCHA は突破しない。見つけたら即座に中止する
    if (analysis.hasCaptcha) {
      return {
        outcome: { status: 'skipped', reason: `CAPTCHA を検出 (${analysis.captchaEvidence}) — 突破しない` },
        analysis,
      };
    }
    if (!analysis.found) return { outcome: { status: 'skipped', reason: 'フォームが見つかりません' }, analysis };
    if (analysis.unmappedRequired.length > 0) {
      const labels = analysis.unmappedRequired.map((f) => f.label).join(' / ');
      return { outcome: { status: 'skipped', reason: `意味を判じられない必須欄: ${labels}` }, analysis };
    }
    if (!analysis.submitSelector) {
      return { outcome: { status: 'skipped', reason: '送信ボタンが見つかりません' }, analysis };
    }

    let filled = 0;
    for (const field of analysis.fields) {
      const value = valueForField(field, values);
      if (value === null) continue;
      try {
        await page.fill(field.selector, value, { timeout: 5_000 });
        filled++;
      } catch {
        // 埋められない欄が 1 つあっても、必須でなければ続ける
      }
    }
    if (filled === 0) return { outcome: { status: 'skipped', reason: '埋められる欄がありません' }, analysis };

    // 同意のチェックは必須のことが多い。あれば入れる
    for (const field of analysis.fields) {
      if (field.type === 'checkbox' && field.required) {
        await page.check(field.selector, { timeout: 3_000 }).catch(() => undefined);
      }
    }

    if (options.live !== true) {
      return {
        outcome: { status: 'skipped', reason: `下見のみ (${filled} 欄を埋められることを確認)` },
        analysis,
      };
    }

    // 押す前の状態を控える。押しただけでは送れたことにならない
    const urlBefore = page.url();
    const bodyBefore = (await page.textContent('body').catch(() => '')) ?? '';

    await page.click(analysis.submitSelector, { timeout });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);

    // 相手側の必須チェックに引っかかると、押しても何も起きない。
    // それを「送信済み」と数えると、1000 社に送ったつもりで 0 社になる
    // (試験用フォームで実際に起きた)。成立を確かめるまで成功と呼ばない。
    const invalid = await page
      .$$eval('form :invalid', (els) =>
        els.map((e) => `${e.getAttribute('name') ?? e.tagName}: ${(e as HTMLInputElement).validationMessage ?? ''}`),
      )
      .catch(() => [] as string[]);
    if (invalid.length > 0) {
      return {
        outcome: { status: 'failed', reason: `相手側の入力チェックで止まりました: ${invalid.join(' / ')}` },
        analysis,
      };
    }

    const urlAfter = page.url();
    const bodyAfter = (await page.textContent('body').catch(() => '')) ?? '';
    const moved = urlAfter !== urlBefore;
    const changed = bodyAfter.trim() !== bodyBefore.trim();
    if (!moved && !changed) {
      return {
        outcome: { status: 'failed', reason: '送信ボタンを押しても画面が変わりません (送れていない可能性)' },
        analysis,
      };
    }

    let evidence = urlAfter;
    if (options.evidenceDir) {
      const file = `${options.evidenceDir}/${new URL(url).hostname}-${Date.now()}.png`;
      await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
      evidence = file;
    }
    return { outcome: { status: 'sent', evidence }, analysis };
  } catch (err) {
    return {
      outcome: { status: 'failed', reason: err instanceof Error ? err.message : String(err) },
      analysis: null,
    };
  } finally {
    await context.close();
  }
}

export async function openBrowser(headed = false): Promise<Browser> {
  return chromium.launch({ headless: !headed });
}
