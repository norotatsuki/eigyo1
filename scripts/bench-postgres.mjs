#!/usr/bin/env node
/**
 * PostgreSQL 側で、画面が実際に投げる条件を測る。
 *
 * 見るのは 2 つ。
 *   ・所要時間
 *   ・EXPLAIN ANALYZE の計画 (Seq Scan が出ていたら索引が効いていない)
 *
 *   使い方: DATABASE_URL=postgres://... node scripts/bench-postgres.mjs [--plan]
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const URL = process.env.DATABASE_URL;
if (!URL) { console.error('DATABASE_URL を渡してください'); process.exit(1); }
const showPlan = process.argv.includes('--plan');

/** 既定で必ず付く 2 条件 (活動中 / 営業お断りを除く) */
const BASE = `c.is_active = 1
  AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.corporate_number = c.corporate_number)
  AND NOT EXISTS (SELECT 1 FROM company_profiles pr
                   WHERE pr.corporate_number = c.corporate_number AND pr.solicitation_refused = 1)`;

const FROM = `FROM corporations c LEFT JOIN company_profiles p ON p.corporate_number = c.corporate_number`;

const CASES = [
  ['単純 (先頭 500)', `WHERE ${BASE}`],
  ['都道府県 (東京)', `WHERE ${BASE} AND c.pref_code = '13'`],
  ['市区町村 (港区)', `WHERE ${BASE} AND c.pref_code = '13' AND c.city_code = '103'`],
  ['業種 (宿泊業)', `WHERE ${BASE} AND p.industry_code LIKE '75%' AND p.industry_confidence >= 0.7`],
  ['メールあり', `WHERE ${BASE} AND p.contact_email IS NOT NULL`],
  ['フォームあり', `WHERE ${BASE} AND p.contact_form_url IS NOT NULL`],
  ['送れる先', `WHERE ${BASE} AND (p.contact_email IS NOT NULL OR p.contact_form_url IS NOT NULL)`],
  ['SNS あり', `WHERE ${BASE} AND p.social_links IS NOT NULL`],
  ['代表者あり', `WHERE ${BASE} AND p.representative IS NOT NULL`],
  ['サイトあり', `WHERE ${BASE} AND p.website_url IS NOT NULL`],
  ['資本金 1000万-5000万', `WHERE ${BASE} AND p.capital BETWEEN 10000000 AND 50000000`],
  ['従業員 30-50', `WHERE ${BASE} AND p.employees BETWEEN 30 AND 50`],
  ['年商 1-3 億', `WHERE ${BASE} AND p.revenue BETWEEN 100000000 AND 300000000`],
  ['商号の語 (建設)', `WHERE ${BASE} AND c.name_normalized LIKE '%建設%'`],
  ['複合: 東京×港区×宿泊×メール',
    `WHERE ${BASE} AND c.pref_code='13' AND c.city_code='103'
       AND p.industry_code LIKE '75%' AND p.contact_email IS NOT NULL`],
  ['複合: 東京×従業員30-50×年商1-3億×メール×フォーム',
    `WHERE ${BASE} AND c.pref_code='13' AND p.employees BETWEEN 30 AND 50
       AND p.revenue BETWEEN 100000000 AND 300000000
       AND p.contact_email IS NOT NULL AND p.contact_form_url IS NOT NULL`],
];

const pg = new Client({ connectionString: URL });
await pg.connect();
console.log('条件'.padEnd(46) + '件数'.padStart(10) + '一覧'.padStart(10) + '  計画');
console.log('─'.repeat(84));

for (const [name, where] of CASES) {
  const listSql = `SELECT c.corporate_number, c.name, c.pref_name, c.city_name,
                          p.contact_email, p.contact_form_url, p.capital, p.employees
                   ${FROM} ${where} ORDER BY c.corporate_number LIMIT 500`;
  const countSql = `SELECT COUNT(*) ${FROM} ${where}`;

  const t1 = Date.now();
  const n = Number((await pg.query(countSql)).rows[0].count);
  const cMs = Date.now() - t1;

  const t2 = Date.now();
  await pg.query(listSql);
  const lMs = Date.now() - t2;

  const plan = (await pg.query('EXPLAIN (ANALYZE, BUFFERS) ' + listSql)).rows.map((r) => r['QUERY PLAN']);
  const seq = plan.some((l) => /Seq Scan on (corporations|company_profiles)/.test(l));
  console.log(name.padEnd(46) + String(n).padStart(10) +
    `${(lMs / 1000).toFixed(2)}s`.padStart(10) + `  ${seq ? '★全表走査' : '索引'} (件数 ${(cMs / 1000).toFixed(1)}s)`);
  if (showPlan) for (const l of plan.slice(0, 6)) console.log('      ' + l);
}
await pg.end();
