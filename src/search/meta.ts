/**
 * 絞り込みの選択肢を、実データから作る。
 *
 * 都道府県や業種の一覧を手で書くと、取り込んだ中身とずれる。
 * 「選べるのに 0 件」「あるのに選べない」を避けるため、必ずデータから数える。
 */
import type { Db } from '../db/index.ts';
import { divisionName, MAJOR_DIVISIONS, majorDivisionOf } from '../enrich/industry/classification.ts';
import { CORP_KIND_LABEL } from '../ingest/nta/record.ts';

export interface Choice {
  code: string;
  label: string;
  count: number;
}

export interface IndustryChoice extends Choice {
  /** 大分類の記号 (A-T)。画面での見出し分けに使う */
  major: string;
  majorLabel: string;
}

export interface Meta {
  sourceDate: string | null;
  totalActive: number;
  prefectures: Choice[];
  kinds: Choice[];
  corpForms: Choice[];
  industries: IndustryChoice[];
  /** 都道府県コード → その県の市区町村。全国で 1900 ほどなので控えに含めてよい */
  cities: Record<string, Choice[]>;
  /** 業種が入っている件数 (確信度 0.7 以上) */
  industryReliable: number;
}

/**
 * 画面で使う選択肢を一式そろえる。
 *
 * 500 万行の集計になり作ると 46 秒かかるため、結果を控えて使い回す。
 * 取り込みや業種推定で中身が変われば指紋が変わり、自動で作り直される。
 */
export function loadMeta(db: Db, options: { onCompute?: () => void } = {}): Meta {
  const fingerprint = metaFingerprint(db);
  const cached = db.prepare('SELECT fingerprint, payload FROM meta_cache WHERE id = 1').get() as
    | { fingerprint: string; payload: string }
    | undefined;
  if (cached?.fingerprint === fingerprint) return JSON.parse(cached.payload) as Meta;

  options.onCompute?.();
  const meta = computeMeta(db);
  db.prepare(
    `INSERT INTO meta_cache (id, fingerprint, payload, computed_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       fingerprint = excluded.fingerprint,
       payload = excluded.payload,
       computed_at = excluded.computed_at`,
  ).run(fingerprint, JSON.stringify(meta), new Date().toISOString());
  return meta;
}

/**
 * 中身が変わったかを見分けるための指紋。
 *
 * COUNT(*) は 500 万行の走査になり 4.5 秒かかるため使わない。
 * 主キーの最大値と取込記録だけを見る (いずれも索引で即座に返る)。
 *
 * 既存行の書き換え (業種推定のやり直しなど) はこの指紋では捉えられないため、
 * 書き込む側が {@link invalidateMeta} を呼んで明示的に捨てる。
 */
function metaFingerprint(db: Db): string {
  const c = db.prepare('SELECT MAX(id) AS maxId FROM corporations').get() as { maxId: number | null };
  const p = db.prepare('SELECT MAX(rowid) AS maxRow FROM company_profiles').get() as {
    maxRow: number | null;
  };
  const r = db.prepare('SELECT MAX(id) AS maxId, MAX(finished_at) AS last FROM ingest_runs').get() as {
    maxId: number | null;
    last: string | null;
  };
  return `${c.maxId ?? 0}:${p.maxRow ?? 0}:${r.maxId ?? 0}:${r.last ?? '-'}`;
}

/** 集計の控えを捨てる。中身を書き換えた側が呼ぶ。 */
export function invalidateMeta(db: Db): void {
  db.prepare('DELETE FROM meta_cache WHERE id = 1').run();
}

function computeMeta(db: Db): Meta {
  const basis = db.prepare('SELECT MAX(source_date) AS d FROM corporations').get() as { d: string | null };
  const total = db.prepare('SELECT COUNT(*) AS n FROM corporations WHERE is_active = 1').get() as { n: number };

  const prefectures = (
    db
      .prepare(
        `SELECT pref_code AS code, MIN(pref_name) AS label, COUNT(*) AS count
           FROM corporations WHERE is_active = 1 AND pref_code <> ''
          GROUP BY pref_code ORDER BY pref_code`,
      )
      .all() as Choice[]
  ).filter((c) => c.label);

  const kinds = (
    db
      .prepare(
        `SELECT CAST(kind AS TEXT) AS code, COUNT(*) AS count
           FROM corporations WHERE is_active = 1 AND kind IS NOT NULL
          GROUP BY kind ORDER BY count DESC`,
      )
      .all() as Array<{ code: string; count: number }>
  ).map((r) => ({ ...r, label: CORP_KIND_LABEL[Number(r.code)] ?? `不明(${r.code})` }));

  const corpForms = db
    .prepare(
      `SELECT corp_form AS code, corp_form AS label, COUNT(*) AS count
         FROM corporations WHERE is_active = 1 AND corp_form IS NOT NULL
        GROUP BY corp_form HAVING count >= 100 ORDER BY count DESC`,
    )
    .all() as Choice[];

  const industries = (
    db
      .prepare(
        `SELECT p.industry_code AS code, COUNT(*) AS count
           FROM company_profiles p
           JOIN corporations c ON c.corporate_number = p.corporate_number
          WHERE c.is_active = 1 AND p.industry_code IS NOT NULL
          GROUP BY p.industry_code ORDER BY p.industry_code`,
      )
      .all() as Array<{ code: string; count: number }>
  ).map((r) => {
    const major = majorDivisionOf(r.code) ?? 'T';
    return {
      ...r,
      label: divisionName(r.code),
      major,
      majorLabel: MAJOR_DIVISIONS[major] ?? major,
    };
  });

  const reliable = db
    .prepare(
      `SELECT COUNT(*) AS n FROM company_profiles p
         JOIN corporations c ON c.corporate_number = p.corporate_number
        WHERE c.is_active = 1 AND p.industry_confidence >= 0.7`,
    )
    .get() as { n: number };

  return {
    sourceDate: basis.d,
    totalActive: total.n,
    prefectures,
    kinds,
    corpForms,
    industries,
    cities: computeCities(db),
    industryReliable: reliable.n,
  };
}

/**
 * 全都道府県の市区町村を 1 回の走査で数える。
 *
 * 選ばれるたびに県ごとに引くと東京都で 2 秒かかる。全国でも 1900 ほどしかないので、
 * まとめて数えて控えに載せてしまう方が、画面の反応も速く実装も単純になる。
 */
function computeCities(db: Db): Record<string, Choice[]> {
  const rows = db
    .prepare(
      `SELECT pref_code AS pref, city_code AS code, MIN(city_name) AS label, COUNT(*) AS count
         FROM corporations
        WHERE is_active = 1 AND pref_code <> '' AND city_code <> ''
        GROUP BY pref_code, city_code
        ORDER BY pref_code, city_code`,
    )
    .all() as Array<Choice & { pref: string }>;

  const byPref: Record<string, Choice[]> = {};
  for (const { pref, code, label, count } of rows) {
    if (!label) continue;
    (byPref[pref] ??= []).push({ code, label, count });
  }
  return byPref;
}
