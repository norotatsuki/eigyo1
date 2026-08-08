// externalApiLogProbe — 外部 API log (meiyasu_api_logs 等) の record 発火 verify
// Tier 3 or Tier 4 (External + Audit) の verify に使う。

export type ExternalApiLogProbeOptions = {
  provider: string;          // 'meiyasu' | 'sbps' | 'blastengine' | ...
  endpoint?: string;         // 呼出 endpoint (path)
  since?: Date;              // filter: since より新しい record のみ
  requiredKeys?: string[];   // 期待 request body keys
};

type ProviderProbe = (
  prisma: any,
  opts: ExternalApiLogProbeOptions,
) => Promise<{ delta: number; records: any[] }>;

const providers = new Map<string, ProviderProbe>();

export function registerExternalApiLogProvider(name: string, impl: ProviderProbe): void {
  providers.set(name, impl);
}

// default: `<provider>_api_logs` table を count する generic 実装
async function defaultProbe(
  prisma: any,
  opts: ExternalApiLogProbeOptions,
): Promise<{ delta: number; records: any[] }> {
  const table = `${opts.provider}_api_logs`;
  const modelClient = (prisma as Record<string, any>)[table];
  if (!modelClient || typeof modelClient.count !== 'function') {
    throw new Error(
      `externalApiLogProbe: prisma.${table} が存在しません。 ` +
      `Prisma schema に model ${table} が定義されているか、writer が実装されているか確認してください。 ` +
      `失敗レポート 2026-07-24 の meiyasu_api_logs (writer 0 hit) 事例と同型の gap の可能性があります。`,
    );
  }
  const where: Record<string, unknown> = {};
  if (opts.endpoint) where.endpoint = opts.endpoint;
  if (opts.since) where.created_at = { gte: opts.since };
  const records = await modelClient.findMany({ where, orderBy: { created_at: 'desc' } });
  return { delta: records.length, records };
}

export async function externalApiLogProbe(
  prisma: any,
  opts: ExternalApiLogProbeOptions,
): Promise<{ delta: number; records: any[] }> {
  const impl = providers.get(opts.provider) ?? defaultProbe;
  return impl(prisma, opts);
}
