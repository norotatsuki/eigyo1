import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

import type { Db } from '../../db/index.ts';
import { beginBulkLoad, endBulkLoad, finishRun, rebuildFts, startRun } from '../../db/index.ts';
import { readRecords } from '../csv.ts';
import {
  fetchCatalog,
  fileNumbersFor,
  requestFile,
  sourceDateFromFileName,
  type Catalog,
  type Region,
} from './catalog.ts';
import { COLUMN_COUNT, toRow, type CorporationRow } from './record.ts';

const BATCH_SIZE = 5_000;
const PROGRESS_EVERY = 250_000;

const INSERT_SQL = `
INSERT INTO corporations (
  corporate_number, process_kind, correction_kind, update_date, change_date,
  name, kind, pref_name, city_name, street_number, pref_code, city_code, post_code,
  address_outside, close_date, close_cause, successor_number, change_cause,
  assignment_date, latest, name_en, pref_en, city_en, address_outside_en, furigana,
  search_excluded, name_normalized, name_core, corp_form, address_full,
  is_active, source_date, ingested_at
) VALUES (
  @corporate_number, @process_kind, @correction_kind, @update_date, @change_date,
  @name, @kind, @pref_name, @city_name, @street_number, @pref_code, @city_code, @post_code,
  @address_outside, @close_date, @close_cause, @successor_number, @change_cause,
  @assignment_date, @latest, @name_en, @pref_en, @city_en, @address_outside_en, @furigana,
  @search_excluded, @name_normalized, @name_core, @corp_form, @address_full,
  @is_active, @source_date, @ingested_at
)
ON CONFLICT(corporate_number) DO UPDATE SET
  process_kind = excluded.process_kind,
  correction_kind = excluded.correction_kind,
  update_date = excluded.update_date,
  change_date = excluded.change_date,
  name = excluded.name,
  kind = excluded.kind,
  pref_name = excluded.pref_name,
  city_name = excluded.city_name,
  street_number = excluded.street_number,
  pref_code = excluded.pref_code,
  city_code = excluded.city_code,
  post_code = excluded.post_code,
  address_outside = excluded.address_outside,
  close_date = excluded.close_date,
  close_cause = excluded.close_cause,
  successor_number = excluded.successor_number,
  change_cause = excluded.change_cause,
  assignment_date = excluded.assignment_date,
  latest = excluded.latest,
  name_en = excluded.name_en,
  pref_en = excluded.pref_en,
  city_en = excluded.city_en,
  address_outside_en = excluded.address_outside_en,
  furigana = excluded.furigana,
  search_excluded = excluded.search_excluded,
  name_normalized = excluded.name_normalized,
  name_core = excluded.name_core,
  corp_form = excluded.corp_form,
  address_full = excluded.address_full,
  is_active = excluded.is_active,
  source_date = excluded.source_date,
  ingested_at = excluded.ingested_at
`;

export interface LoadResult {
  fileName: string;
  sourceDate: string;
  rowsRead: number;
  rowsUpserted: number;
  rowsSkipped: number;
}

export interface LoadOptions {
  region?: Region;
  /** 既に取得済みの zip があれば再利用する */
  cacheDir?: string;
  /** 進捗の報告先。既定は標準エラー出力 */
  onProgress?: (read: number, upserted: number) => void;
}

/** zip の展開に外部コマンドを使う。存在を先に確かめる。 */
function assertUnzipAvailable(): void {
  const probe = spawnSync('unzip', ['-v'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    throw new Error('unzip コマンドが見つかりません。zip の展開に必要です');
  }
}

/**
 * 国税庁の全件データを取り込む。
 *
 * 既定は全国 1 本 (zip 約 250MB / 展開後 約 1.5GB / 約 500 万件)。
 * 都道府県を指定すれば小さい単位で試せる。
 */
export async function loadZenken(db: Db, options: LoadOptions = {}): Promise<LoadResult> {
  const region: Region = options.region ?? '全国';
  const cacheDir = options.cacheDir ?? join(process.cwd(), 'data', 'raw');
  mkdirSync(cacheDir, { recursive: true });
  assertUnzipAvailable();

  const catalog: Catalog = await fetchCatalog();
  const fileNumbers = fileNumbersFor(catalog, 'csv-unicode', region);

  let totalRead = 0;
  let totalUpserted = 0;
  let totalSkipped = 0;
  let lastFileName = '';
  let lastSourceDate = '';

  for (const fileNo of fileNumbers) {
    const zipPath = await ensureDownloaded(catalog, fileNo, cacheDir);
    const sourceDate = sourceDateFromFileName(zipPath.fileName) ?? new Date().toISOString().slice(0, 10);
    lastFileName = zipPath.fileName;
    lastSourceDate = sourceDate;

    const runId = startRun(db, {
      source: 'nta_zenken',
      target: `${region}#${fileNo}`,
      sourceDate,
      fileName: zipPath.fileName,
    });

    try {
      const result = await loadFromZip(db, zipPath.path, sourceDate, options.onProgress);
      totalRead += result.read;
      totalUpserted += result.upserted;
      totalSkipped += result.skipped;
      finishRun(db, runId, {
        rowsRead: result.read,
        rowsUpserted: result.upserted,
        status: 'ok',
      });
    } catch (err) {
      finishRun(db, runId, {
        rowsRead: totalRead,
        rowsUpserted: totalUpserted,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  rebuildFts(db);

  return {
    fileName: lastFileName,
    sourceDate: lastSourceDate,
    rowsRead: totalRead,
    rowsUpserted: totalUpserted,
    rowsSkipped: totalSkipped,
  };
}

/** 同じ基準日の zip が既にあれば使い回す。無ければ取得する。 */
async function ensureDownloaded(
  catalog: Catalog,
  fileNo: string,
  cacheDir: string,
): Promise<{ path: string; fileName: string }> {
  const file = await requestFile(catalog, fileNo);
  const path = join(cacheDir, file.fileName);

  if (existsSync(path) && statSync(path).size > 0) {
    // 本体を読まずに閉じる
    await file.body.cancel();
    return { path, fileName: file.fileName };
  }

  await pipeline(Readable.fromWeb(file.body), createWriteStream(path));
  return { path, fileName: file.fileName };
}

/** zip を展開しながら流し読みして投入する。 */
async function loadFromZip(
  db: Db,
  zipPath: string,
  sourceDate: string,
  onProgress?: (read: number, upserted: number) => void,
): Promise<{ read: number; upserted: number; skipped: number }> {
  const stmt = db.prepare(INSERT_SQL);
  const insertMany = db.transaction((rows: CorporationRow[]) => {
    for (const row of rows) stmt.run(row);
  });

  const child = spawn('unzip', ['-p', zipPath, '*.csv'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => {
    stderr += d;
  });
  child.stdout.setEncoding('utf8');

  const ingestedAt = new Date().toISOString();
  let read = 0;
  let upserted = 0;
  let skipped = 0;
  let batch: CorporationRow[] = [];

  beginBulkLoad(db);
  try {
    for await (const fields of readRecords(child.stdout as AsyncIterable<string>)) {
      read++;
      if (fields.length < COLUMN_COUNT) {
        skipped++;
        continue;
      }
      const row = toRow(fields, sourceDate, ingestedAt);
      if (!row) {
        skipped++;
        continue;
      }
      batch.push(row);
      if (batch.length >= BATCH_SIZE) {
        insertMany(batch);
        upserted += batch.length;
        batch = [];
        if (upserted % PROGRESS_EVERY < BATCH_SIZE) onProgress?.(read, upserted);
      }
    }
    if (batch.length > 0) {
      insertMany(batch);
      upserted += batch.length;
    }
  } finally {
    endBulkLoad(db);
  }

  const code: number = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) throw new Error(`unzip が異常終了しました (code=${code}): ${stderr.trim()}`);

  onProgress?.(read, upserted);
  return { read, upserted, skipped };
}
