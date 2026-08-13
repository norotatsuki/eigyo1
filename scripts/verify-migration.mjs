#!/usr/bin/env node
/**
 * SQLite と PostgreSQL を突き合わせる。
 *
 * 「入った」ではなく「1 件も欠けていない・化けていない」を確かめる。
 *   ① 表ごとの総数
 *   ② 主要項目 (メール/フォーム/代表者/SNS/サイト/電話) の件数
 *   ③ 都道府県別・業種別の件数 (分布がずれていないか)
 *   ④ 無作為に選んだ 1,000 社を 1 項目ずつ比較
 *
 * NULL と空文字の取り違えはここで必ず出る (件数が合わなくなる)。
 *
 *   使い方: DATABASE_URL=postgres://... node scripts/verify-migration.mjs [標本数]
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { Client } = require('pg');

const SQLITE = process.env.SQLITE_PATH ?? 'data/eigyo.db';
const URL = process.env.DATABASE_URL;
const SAMPLE = Number(process.argv[2] ?? 1000);
if (!URL) { console.error('DATABASE_URL を渡してください'); process.exit(1); }

const jp = (n) => Number(n).toLocaleString('ja-JP');
let ng = 0;

function cmp(label, a, b) {
  const ok = Number(a) === Number(b);
  if (!ok) ng++;
  console.log(`  ${label.padEnd(26)} SQLite ${jp(a).padStart(10)}  PostgreSQL ${jp(b).padStart(10)}  ${ok ? 'ok' : '★ちがう'}`);
}

const sqlite = new Database(SQLITE, { readonly: true });
sqlite.pragma('busy_timeout = 600000');
const pg = new Client({ connectionString: URL });
await pg.connect();

const s1 = (q) => Object.values(sqlite.prepare(q).get())[0];
const p1 = async (q) => Number(Object.values((await pg.query(q)).rows[0])[0]);

console.log('― ① 表ごとの総数 ―');
for (const t of ['corporations', 'company_profiles', 'web_hosts', 'suppressions',
                 'outreach_log', 'segments', 'ingest_runs', 'host_discovery_pages']) {
  cmp(t, s1(`SELECT COUNT(*) FROM ${t}`), await p1(`SELECT COUNT(*) FROM ${t}`));
}

console.log('\n― ② 主要項目 ―');
const fields = [
  ['メール', 'company_profiles', 'contact_email'],
  ['問い合わせフォーム', 'company_profiles', 'contact_form_url'],
  ['代表者', 'company_profiles', 'representative'],
  ['SNS', 'company_profiles', 'social_links'],
  ['Web サイト', 'company_profiles', 'website_url'],
  ['電話', 'company_profiles', 'contact_tel'],
  ['業種', 'company_profiles', 'industry_code'],
  ['資本金', 'company_profiles', 'capital'],
  ['従業員数', 'company_profiles', 'employees'],
  ['年商', 'company_profiles', 'revenue'],
  ['サイト側メール', 'web_hosts', 'site_email'],
  ['サイト本文', 'web_hosts', 'site_text'],
];
for (const [label, table, col] of fields) {
  cmp(label, s1(`SELECT COUNT(*) FROM ${table} WHERE ${col} IS NOT NULL`),
      await p1(`SELECT COUNT(*) FROM ${table} WHERE ${col} IS NOT NULL`));
}

console.log('\n― ③ 都道府県別 (上位 8) ―');
const sPref = sqlite.prepare(
  `SELECT pref_name AS k, COUNT(*) AS n FROM corporations WHERE is_active=1
    GROUP BY pref_name ORDER BY n DESC LIMIT 8`).all();
for (const r of sPref) {
  const n = await p1(
    `SELECT COUNT(*) FROM corporations WHERE is_active=1 AND pref_name = '${r.k.replace(/'/g, "''")}'`);
  cmp(r.k, r.n, n);
}

console.log('\n― ③ 業種別 (上位 8) ―');
const sInd = sqlite.prepare(
  `SELECT industry_code AS k, COUNT(*) AS n FROM company_profiles
    WHERE industry_code IS NOT NULL GROUP BY industry_code ORDER BY n DESC LIMIT 8`).all();
for (const r of sInd) {
  const n = await p1(`SELECT COUNT(*) FROM company_profiles WHERE industry_code = '${r.k}'`);
  cmp(`業種 ${r.k}`, r.n, n);
}

console.log(`\n― ④ 無作為 ${jp(SAMPLE)} 社を 1 項目ずつ比較 ―`);
const sample = sqlite.prepare(
  `SELECT corporate_number FROM corporations ORDER BY RANDOM() LIMIT ?`).all(SAMPLE);
const COLS_CORP = ['name', 'pref_name', 'city_name', 'address_full', 'post_code',
                   'kind', 'corp_form', 'name_core', 'is_active', 'assignment_date'];
const COLS_PROF = ['website_url', 'contact_email', 'contact_form_url', 'contact_tel',
                   'representative', 'social_links', 'industry_code', 'capital',
                   'employees', 'revenue'];
const getC = sqlite.prepare(`SELECT ${COLS_CORP.join(',')} FROM corporations WHERE corporate_number = ?`);
const getP = sqlite.prepare(`SELECT ${COLS_PROF.join(',')} FROM company_profiles WHERE corporate_number = ?`);

let checked = 0, mismatch = 0;
const shown = [];
for (const { corporate_number: cn } of sample) {
  const sc = getC.get(cn);
  const sp = getP.get(cn) ?? {};
  const pc = (await pg.query(
    `SELECT ${COLS_CORP.join(',')} FROM corporations WHERE corporate_number = $1`, [cn])).rows[0];
  const pp = (await pg.query(
    `SELECT ${COLS_PROF.join(',')} FROM company_profiles WHERE corporate_number = $1`, [cn])).rows[0] ?? {};
  if (!pc) { mismatch++; if (shown.length < 5) shown.push(`${cn} PostgreSQL に無い`); continue; }
  for (const c of COLS_CORP.concat(COLS_PROF)) {
    const a = (sc[c] ?? sp[c] ?? null);
    const b = (pc[c] ?? pp[c] ?? null);
    checked++;
    // 数値は型が違っても値が同じなら良しとする (INTEGER ↔ BIGINT)
    const same = a === null && b === null ? true
      : a === null || b === null ? false
      : String(a) === String(b);
    if (!same) {
      mismatch++;
      if (shown.length < 8) shown.push(`${cn} ${c}: SQLite=${JSON.stringify(a)} PG=${JSON.stringify(b)}`);
    }
  }
}
console.log(`  比べた項目 ${jp(checked)} / 食い違い ${jp(mismatch)}`);
for (const s of shown) console.log(`    ★ ${s}`);
if (mismatch > 0) ng++;

await pg.end();
sqlite.close();
console.log(`\n${ng === 0 ? '欠損なし。移行できています' : `★ ${ng} 箇所で食い違いがあります`}`);
process.exit(ng === 0 ? 0 : 1);
