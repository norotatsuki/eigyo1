// smsProbe — 実 SMS 到達 verify helper
// Tier 3 (External side-effect) の verify に使う。
// project 側で provider 別 (4S / Twilio / etc.) の実装を register する。

export type SmsProbeOptions = {
  provider: string;
  phoneNumber: string;
  bodyContains?: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  credentials?: Record<string, string>;
};

type SmsProvider = (opts: SmsProbeOptions) => Promise<boolean>;

const providers = new Map<string, SmsProvider>();

export function registerSmsProvider(name: string, impl: SmsProvider): void {
  providers.set(name, impl);
}

export async function smsProbe(opts: SmsProbeOptions): Promise<boolean> {
  const provider = providers.get(opts.provider);
  if (!provider) {
    throw new Error(
      `smsProbe: provider "${opts.provider}" is not registered. ` +
      `project 側で registerSmsProvider('${opts.provider}', async (opts) => {...}) を呼んでください。`,
    );
  }
  return provider(opts);
}
