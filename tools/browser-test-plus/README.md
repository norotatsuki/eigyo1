# @ccagi/browser-test-plus

> CC AGI TDD の Tier 2-4 (DB delta / external side-effect / audit trail) verify を
> 宣言的に書ける helper 群。失敗レポート 2026-07-24 の shallow-verify 系統的失敗
> 対策として実装。

## 何を解決するか

過去 (2026-07-24 CC AGI TDD Shallow Verify Systematic Failure Report):

- UC test が「UI 到達 = PASS」で止まり、実 DB write や audit trail の verify を
  系統的に skip していた
- 各 UC で helper を自作するか skip するかの二択、結局 skip が多発
- 「動くはず」「多分」で verdict を発行し、実測を飛ばしていた

本 package は下記 helper を標準搭載することで、install するだけで
Tier 2-4 verify が可能に:

- `dbProbe` — prisma を経由した before/after diff helper
- `auditProbe` — audit_logs / api_logs delta 検出
- `mailProbe` — 実 mail 到達 verify (Blast Engine dashboard API / POP3 / IMAP)
- `smsProbe` — 実 SMS 到達 verify (4S API log / user 実受信 wait)
- `larkChatProbe` — Lark BOT API で chat msg delta 検出
- `externalApiLogProbe` — meiyasu_api_logs 等の外部 API log record verify
- `sequenceVerify` — UC md mermaid arrow → assertion mapping helper

## インストール

```bash
npm install --save-dev @ccagi/browser-test-plus
# または yarn / pnpm
```

Prisma client は peer dependency:

```bash
npm install @prisma/client
```

## 使い方

### dbProbe — before/after diff

```typescript
import { dbProbe } from '@ccagi/browser-test-plus';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

test('login updates last_login_at', async ({ page }) => {
  const result = await dbProbe(prisma, 'users', { email: 'test@example.com' }, async () => {
    await page.goto('/login');
    await page.fill('input[name=email]', 'test@example.com');
    await page.fill('input[name=password]', 'valid-password');
    await page.click('button[type=submit]');
    await expect(page).toHaveURL('/dashboard');
  });
  // result: { before, after, delta, result: <action の戻り値> }
  expect(result.delta).toBeGreaterThanOrEqual(0); // update 系なので count は不変
  // last_login_at は別途 findFirst で verify
  const user = await prisma.users.findFirst({ where: { email: 'test@example.com' } });
  expect(user?.last_login_at).toBeTruthy();
});
```

### auditProbe — audit_logs delta 検出

```typescript
import { auditProbe } from '@ccagi/browser-test-plus';

test('AR010 API call records audit', async ({ page }) => {
  const result = await auditProbe(prisma, 'API_CALL_MEIYASU', async () => {
    await page.goto('/admin/meiyasu/trigger');
    await page.click('button[name=execute]');
  });
  expect(result.delta).toBeGreaterThanOrEqual(1);
});
```

### mailProbe — 実 mail 到達

```typescript
import { mailProbe } from '@ccagi/browser-test-plus';

test('signup sends welcome mail', async ({ page }) => {
  await page.goto('/signup');
  // ... form submit ...

  const arrived = await mailProbe({
    provider: 'blast-engine',
    receiver: 'test@example.com',
    subject: 'Welcome',
    timeoutMs: 10000,
  });
  expect(arrived).toBe(true);
});
```

### larkChatProbe — Lark chat msg delta

```typescript
import { larkChatProbe } from '@ccagi/browser-test-plus';

test('application submit posts to Lark', async ({ page }) => {
  const before = await larkChatProbe.snapshot({
    appId: process.env.LARK_APP_ID!,
    appSecret: process.env.LARK_APP_SECRET!,
    chatId: process.env.LARK_CHAT_ID!,
  });

  await page.goto('/apply');
  // ... form submit ...

  const delta = await larkChatProbe.awaitDelta({
    appId: process.env.LARK_APP_ID!,
    appSecret: process.env.LARK_APP_SECRET!,
    chatId: process.env.LARK_CHAT_ID!,
    since: before.latestMsgId,
    timeoutMs: 10000,
  });
  expect(delta.length).toBeGreaterThanOrEqual(1);
  expect(delta[0].text).toContain('新規申込');
});
```

### sequenceVerify — mermaid arrow ↔ assertion mapping

```typescript
import { sequenceVerify } from '@ccagi/browser-test-plus';

test('UC02-01 sequence coverage', async () => {
  const coverage = await sequenceVerify({
    ucMdPath: 'docs/use_case/UC02-01.md',
    testFilePaths: ['tests/uc02-01.spec.ts'],
  });
  expect(coverage.ratio).toBeGreaterThanOrEqual(1.0); // 100%
  // coverage.missing: [{ arrow: 5, description: '...' }, ...]
});
```

## Verdict Tier 対応表

| helper | 対応 Tier |
|---|---|
| dbProbe | Tier 2 (DB delta) |
| auditProbe | Tier 4 (Audit trail) |
| mailProbe / smsProbe / larkChatProbe | Tier 3 (External side-effect) |
| externalApiLogProbe | Tier 3 or Tier 4 |
| sequenceVerify | Tier 1-4 全体の網羅性 |

## 現在の実装状況

**v1.0.0 (2026-07-24 初版)**:

- スケルトン + 型定義 + Prisma peer dependency
- `dbProbe`: 実装済み
- `auditProbe`: 実装済み
- `sequenceVerify`: 実装済み (bash script version と同等)
- `mailProbe` / `smsProbe` / `larkChatProbe` / `externalApiLogProbe`: 型定義とスタブ実装
  (provider 別の実装は各 project で override 前提)

各 probe は本番接続 (Blast Engine / 4S / Lark 等) が必要なため、
project 側で env / credential を渡す前提。credential 不足時は throw する。

## 拡張方針

各 project で provider-specific 実装を追加:

```typescript
// src/mail-providers/blast-engine.ts
import { registerMailProvider } from '@ccagi/browser-test-plus';

registerMailProvider('blast-engine', async ({ receiver, subject, timeoutMs }) => {
  // Blast Engine dashboard API 呼出
  ...
});
```

## ライセンス

MIT
