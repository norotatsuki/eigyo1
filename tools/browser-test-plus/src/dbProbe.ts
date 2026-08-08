// dbProbe — before/after DB row count diff helper
// Tier 2 (Middle state / DB delta) の verify に使う。

export type DbProbeResult<T> = {
  before: number;
  after: number;
  delta: number;
  result: T;
};

// Prisma を dynamic import で受ける (peer dependency)。
// TypeScript の型は any にして project 側の Prisma 型に依存しない。
export async function dbProbe<T>(
  prisma: any,
  model: string,
  filter: object,
  action: () => Promise<T>,
): Promise<DbProbeResult<T>> {
  const modelClient = (prisma as Record<string, any>)[model];
  if (!modelClient || typeof modelClient.count !== 'function') {
    throw new Error(`dbProbe: prisma.${model}.count is not available. model="${model}" が正しいか確認してください。`);
  }
  const before = await modelClient.count({ where: filter });
  const result = await action();
  const after = await modelClient.count({ where: filter });
  return { before, after, delta: after - before, result };
}
