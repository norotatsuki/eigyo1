import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export type Db = Database.Database;

/** 既定のデータベース位置。環境変数 EIGYO_DB で上書きできる。 */
export function defaultDbPath(): string {
  return process.env['EIGYO_DB'] ?? join(process.cwd(), 'data', 'eigyo.db');
}

/**
 * データベースを開き、スキーマを適用して返す。
 * スキーマはすべて IF NOT EXISTS なので、何度呼んでも安全。
 */
export function openDb(path: string = defaultDbPath()): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // 列の継ぎ足しは schema.sql より **先** に行う。
  // schema.sql には新しい列に張る索引が含まれるため、逆順にすると
  // 既存のデータベースで「no such column」で落ちる (実際に落とした)。
  // まっさらなデータベースでは表がまだ無いので、この段は素通りする。
  addMissingColumns(db);
  db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
  migrateFtsIfStale(db);
  return db;
}

/**
 * スキーマに足した列を、既に出来ているデータベースにも反映する。
 *
 * schema.sql は CREATE TABLE IF NOT EXISTS で書いてあるため、
 * 列を足しても既存のデータベースには入らない。取り込み直しを強いないよう、
 * 足りない列だけを継ぎ足す。
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [table: string, column: string, decl: string]> = [
  ['web_hosts', 'site_email', 'TEXT'],
  ['web_hosts', 'site_text', 'TEXT'],
  ['company_profiles', 'revenue', 'INTEGER'],
  ['company_profiles', 'scale_source', 'TEXT'],
  ['company_profiles', 'hiring', 'INTEGER'],
  ['company_profiles', 'hiring_roles', 'TEXT'],
  ['company_profiles', 'hiring_new_grad', 'INTEGER'],
  ['company_profiles', 'hiring_mid_career', 'INTEGER'],
  ['company_profiles', 'hiring_checked_at', 'TEXT'],
];

function addMissingColumns(db: Db): void {
  const tableExists = (name: string): boolean =>
    (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?`).get(name) as { n: number })
      .n > 0;

  for (const [table, column, decl] of ADDED_COLUMNS) {
    if (!tableExists(table)) continue; // まっさらなら schema.sql が作る
    const exists = db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`).get(table, column) as
      | { n: number }
      | undefined;
    if (exists && exists.n === 0) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

/**
 * 全文検索の索引定義が古い場合に作り直す。
 *
 * スキーマは IF NOT EXISTS で書かれているため、定義を変えても既存のデータベースには
 * 反映されない。索引の中身だけを作り直せば済むので、取り込み直しは不要。
 */
function migrateFtsIfStale(db: Db): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'corporations_fts'`)
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes('name_normalized')) return;

  const count = db.prepare('SELECT COUNT(*) AS n FROM corporations').get() as { n: number };
  if (count.n > 0) {
    process.stderr.write('[移行] 検索索引の定義が古いため作り直します…\n');
  }
  db.exec('DROP TABLE corporations_fts');
  db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
  if (count.n > 0) {
    rebuildFts(db);
    process.stderr.write('[移行] 検索索引を作り直しました\n');
  }
}

/**
 * 大量投入の間だけ耐久性を落として速度を取る。
 *
 * synchronous = OFF は「途中で電源が落ちるとデータベースが壊れうる」設定。
 * 取込は何度でもやり直せる (出典は公開データ) ため、ここでは速度を優先する。
 * 呼び出し側は finally で必ず {@link endBulkLoad} を呼ぶこと。
 */
export function beginBulkLoad(db: Db): void {
  db.pragma('synchronous = OFF');
  db.pragma('cache_size = -262144'); // 256MB
  db.pragma('temp_store = MEMORY');
}

export function endBulkLoad(db: Db): void {
  db.pragma('synchronous = NORMAL');
  db.pragma('wal_checkpoint(TRUNCATE)');
}

/**
 * 統計を取り直す。大量に書き込んだあとに必ず呼ぶ。
 *
 * これを怠ると SQLite が索引を選び損ね、都道府県で絞った検索が
 * 500 万行の全走査に落ちる (実測 13 秒 → ANALYZE 後 1 秒台)。
 * 500 万件で 11 秒ほどかかるが、取り込みの所要に比べれば無視できる。
 */
export function analyze(db: Db): void {
  db.exec('ANALYZE');
}

/** 全文検索の索引を作り直す。大量投入のあとに 1 度だけ呼ぶ。 */
export function rebuildFts(db: Db): void {
  db.exec(`INSERT INTO corporations_fts(corporations_fts) VALUES('rebuild')`);
}

/** 取込の監査記録を開始し、行 id を返す。 */
export function startRun(
  db: Db,
  run: { source: string; target: string; sourceDate?: string; fileName?: string },
): number {
  const stmt = db.prepare(
    `INSERT INTO ingest_runs (source, target, source_date, file_name, started_at, status)
     VALUES (?, ?, ?, ?, ?, 'running')`,
  );
  const info = stmt.run(
    run.source,
    run.target,
    run.sourceDate ?? null,
    run.fileName ?? null,
    new Date().toISOString(),
  );
  return Number(info.lastInsertRowid);
}

export function finishRun(
  db: Db,
  id: number,
  result: { rowsRead: number; rowsUpserted: number; status: 'ok' | 'failed'; error?: string },
): void {
  db.prepare(
    `UPDATE ingest_runs
        SET rows_read = ?, rows_upserted = ?, finished_at = ?, status = ?, error = ?
      WHERE id = ?`,
  ).run(
    result.rowsRead,
    result.rowsUpserted,
    new Date().toISOString(),
    result.status,
    result.error ?? null,
    id,
  );
}
