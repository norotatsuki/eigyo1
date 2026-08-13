#!/usr/bin/env node
/**
 * SQLite (data/eigyo.db) の中身を PostgreSQL へ移す。
 *
 * 581 万行あるので 1 件ずつ INSERT はしない。COPY へ流し込む。
 *
 * 途中で止まっても最初からやり直さなくてよい:
 *   表ごとに「PostgreSQL 側の件数」と「SQLite 側の件数」を比べ、
 *   一致していればその表は飛ばす。合っていなければその表だけ入れ直す。
 *   (表の単位で作り直す。最大でも 1 表ぶんしか無駄にならない)
 *
 * NULL と空文字を取り違えないこと。ここを間違えると
 * 「メールがある先」の判定 (IS NOT NULL) が全部狂う。
 * COPY の text 形式で \N を NULL として渡す。
 *
 *   使い方:
 *     DATABASE_URL=postgres://... node scripts/migrate-to-postgres.mjs
 *     DATABASE_URL=... node scripts/migrate-to-postgres.mjs --only corporations
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { Client } = require('pg');
const copyFrom = require('pg-copy-streams').from;

const SQLITE = process.env.SQLITE_PATH ?? 'data/eigyo.db';
const URL = process.env.DATABASE_URL;
if (!URL) {
  console.error('DATABASE_URL を渡してください (例: postgres://user:pass@host:5432/eigyo)');
  process.exit(1);
}
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

/** 移す順。参照している先を先に入れる (company_profiles は corporations を参照する) */
const TABLES = [
  'corporations', 'company_profiles', 'web_hosts', 'suppressions',
  'outreach_log', 'segments', 'ingest_runs', 'host_discovery_pages', 'meta_cache',
];

/*
 * PostgreSQL の text に入れられない文字を落とす。
 *
 * SQLite は何でも入る。PostgreSQL の text は NUL (U+0000) を格納できない。
 * 収集したページの本文に混じっており、実測 (2026-08-13):
 *   web_hosts.site_text                1,384 件
 *   company_profiles.business_evidence     41 件
 * NUL は文章としての意味を持たないので取り除く。ただし黙って変えない。
 * 何件から取り除いたかを数え、最後に必ず報告する。
 */
let stripped = 0;
function enc(v) {
  if (v === null || v === undefined) return '\\N';
  if (typeof v === 'number') return String(v);
  if (Buffer.isBuffer(v)) v = v.toString('utf8');
  let s = String(v);
  if (s.includes('\u0000')) { stripped++; s = s.replaceAll('\u0000', ''); }
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

const jp = (n) => n.toLocaleString('ja-JP');

async function main() {
  const sqlite = new Database(SQLITE, { readonly: true });
  sqlite.pragma('busy_timeout = 600000');
  const pg = new Client({ connectionString: URL });
  await pg.connect();

  // 表と索引を用意する (何度実行してもよい形にしてある)
  await pg.query(readFileSync('src/db/schema.pg.sql', 'utf8'));
  console.log('表を用意しました');

  for (const table of TABLES) {
    if (only && table !== only) continue;
    const src = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    const dstRow = await pg.query(`SELECT COUNT(*)::bigint AS n FROM ${table}`);
    const dst = Number(dstRow.rows[0].n);

    if (src === dst && src > 0) {
      console.log(`${table.padEnd(22)} 済み (${jp(src)} 件)`);
      continue;
    }
    if (src === 0) {
      console.log(`${table.padEnd(22)} 元が 0 件。飛ばします`);
      continue;
    }
    if (dst > 0) {
      console.log(`${table.padEnd(22)} 途中まで入っています (${jp(dst)}/${jp(src)})。入れ直します`);
      await pg.query(`TRUNCATE ${table} CASCADE`);
    }

    // 列の並びを SQLite 側から取り、その順で流す
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const started = Date.now();
    let done = 0;

    const rows = sqlite.prepare(`SELECT ${cols.join(', ')} FROM ${table}`).iterate();
    const source = Readable.from((function* () {
      for (const r of rows) {
        done++;
        if (done % 500_000 === 0) {
          const sec = ((Date.now() - started) / 1000).toFixed(0);
          process.stderr.write(`  ${table} ${jp(done)}/${jp(src)} 件 (${sec} 秒)\n`);
        }
        yield cols.map((c) => enc(r[c])).join('\t') + '\n';
      }
    })());

    const sink = pg.query(copyFrom(`COPY ${table} (${cols.join(', ')}) FROM STDIN`));
    await pipeline(source, sink);

    const after = Number((await pg.query(`SELECT COUNT(*)::bigint AS n FROM ${table}`)).rows[0].n);
    const sec = ((Date.now() - started) / 1000).toFixed(1);
    const ok = after === src;
    console.log(`${table.padEnd(22)} ${ok ? '完了' : '★不一致'} ${jp(after)}/${jp(src)} 件 (${sec} 秒)`);
    if (!ok) { console.error('件数が合いません。中断します'); process.exit(1); }
  }

  if (!only) {
    console.log('索引を作ります (ここが一番時間がかかります)');
    const t0 = Date.now();
    await pg.query(readFileSync('src/db/indexes.pg.sql', 'utf8'));
    console.log(`索引を作りました (${((Date.now() - t0) / 1000).toFixed(0)} 秒)`);
    console.log('統計を取ります');
    await pg.query('ANALYZE');
  }

  await pg.end();
  sqlite.close();
  if (stripped > 0) {
    console.log(`NUL 文字を ${jp(stripped)} 個の値から取り除きました`
      + ' (PostgreSQL の text は NUL を格納できない。文章の意味は失われない)');
  }
  console.log('移行を終えました');
}

main().catch((e) => { console.error(e); process.exit(1); });
