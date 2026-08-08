// mailProbe — 実 mail 到達 verify helper
// Tier 3 (External side-effect) の verify に使う。
// project 側で provider 別 (Blast Engine / POP3 / IMAP / etc.) の実装を register する。

export type MailProbeOptions = {
  provider: string;             // 'blast-engine' | 'pop3' | 'imap' | 'sendgrid' | ...
  receiver: string;             // 到達先 mail address
  subject?: string;             // subject の完全一致 or 部分一致
  subjectContains?: string;
  fromAddress?: string;
  timeoutMs: number;            // 到達待ち timeout
  pollIntervalMs?: number;      // polling 間隔 (default: 500ms)
  credentials?: Record<string, string>;  // provider 固有 credential
};

type MailProvider = (opts: MailProbeOptions) => Promise<boolean>;

const providers = new Map<string, MailProvider>();

export function registerMailProvider(name: string, impl: MailProvider): void {
  providers.set(name, impl);
}

export async function mailProbe(opts: MailProbeOptions): Promise<boolean> {
  const provider = providers.get(opts.provider);
  if (!provider) {
    throw new Error(
      `mailProbe: provider "${opts.provider}" is not registered. ` +
      `project 側で registerMailProvider('${opts.provider}', async (opts) => {...}) を呼んでください。 ` +
      `既定 provider は unimplemented — 実 mail 到達を verify するには credential 付き実装が必要です。`,
    );
  }
  return provider(opts);
}
