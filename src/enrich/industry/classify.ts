/**
 * 商号と法人格から業種を推定する。
 *
 * これは**推定**であって、権威ある出典ではない。
 * gBizINFO のような公的な出典が入ったら、そちらで上書きされるべきもの。
 * そのため保存時に必ず出典 (industry_source) と確信度を残し、
 * 上書きの可否を出典で判断できるようにする。
 */
import { analyze, type Db } from '../../db/index.ts';
import { invalidateMeta, loadMeta } from '../../search/meta.ts';
import { divisionName } from './classification.ts';
import { CORP_FORM_RULES, KEYWORD_RULES, OVERRIDE_RULES } from './rules.ts';
import { classifyFromText } from './from-text.ts';

/** 推定の出典名。company_profiles.industry_source に入る値。 */
export const SOURCE_NAME_INFERENCE = 'name_inference';

/** 権威ある出典。これらが入っている行は推定で上書きしない。 */
const AUTHORITATIVE_SOURCES: readonly string[] = ['gbizinfo', 'manual'];

export interface Inference {
  code: string;
  name: string;
  confidence: number;
  /** 判断の根拠になった語または法人格 */
  matched: string;
}

/**
 * 1 件分の推定。当てはまらなければ null。
 *
 * 商号の語と法人格の両方を見て、確信度の高い方を採る。
 * 商号の語は長いものから照合するため、「不動産鑑定」は「不動産」より先に当たる。
 */
export function inferIndustry(nameCore: string, corpForm: string | null): Inference | null {
  // 「一見 X に見えるが実は Y」を先に押さえる (獣医業を医療業にしない等)
  for (const rule of OVERRIDE_RULES) {
    if (nameCore.includes(rule.keyword)) {
      return {
        code: rule.code,
        name: divisionName(rule.code),
        confidence: rule.confidence,
        matched: rule.keyword,
      };
    }
  }

  // 長い一致を優先する。確信度で選ぶと、短い語が偶然はまったときに勝ってしまう。
  //
  // 実データで踏んだ誤り: 「有限会社後藤衛生コンサルタント」は
  // 「衛生コンサルタント」の中に「生コン」(確信度 0.9) を含む。
  // 同時に「コンサル」(0.7) にも当たっているのに、確信度で選んだために
  // 窯業・土石製品製造業と判定していた。
  //
  // KEYWORD_RULES は長さの降順に並べてあるので、最初に当たったものを採ればよい。
  // 同じ長さの語が複数当たる場合は、並び順が確信度の降順なので自然に強い方が残る。
  let best: Inference | null = null;

  for (const rule of KEYWORD_RULES) {
    if (!nameCore.includes(rule.keyword)) continue;
    best = {
      code: rule.code,
      name: divisionName(rule.code),
      confidence: rule.confidence,
      matched: rule.keyword,
    };
    break;
  }

  if (corpForm) {
    const byForm = CORP_FORM_RULES[corpForm];
    if (byForm && (best === null || byForm.confidence > best.confidence)) {
      best = {
        code: byForm.code,
        name: divisionName(byForm.code),
        confidence: byForm.confidence,
        matched: corpForm,
      };
    }
  }

  return best;
}

export interface ClassifyResult {
  scanned: number;
  inferred: number;
  skippedAuthoritative: number;
  /** 中分類コード → 件数 */
  byCode: Map<string, number>;
  /** 確信度 (小数第1位) → 件数。推定の質を判断する材料になる */
  byConfidence: Map<number, number>;
}

export interface ClassifyOptions {
  /** これ未満の確信度は保存しない */
  minConfidence?: number;
  /** 営業対象だけを対象にする (既定 true) */
  activeOnly?: boolean;
  /** 一度に読み取る件数。既定 20000 */
  pageSize?: number;
  onProgress?: (scanned: number, inferred: number) => void;
}

/** 権威ある出典の一覧は AUTHORITATIVE_SOURCES ひとつを正とする。 */
const AUTHORITATIVE_LIST = AUTHORITATIVE_SOURCES.map((s) => `'${s}'`).join(', ');

const UPSERT_SQL = `
INSERT INTO company_profiles
  (corporate_number, industry_code, industry_name, industry_source, industry_confidence, updated_at)
VALUES (@n, @code, @name, @source, @confidence, @now)
ON CONFLICT(corporate_number) DO UPDATE SET
  industry_code = excluded.industry_code,
  industry_name = excluded.industry_name,
  industry_source = excluded.industry_source,
  industry_confidence = excluded.industry_confidence,
  updated_at = excluded.updated_at
WHERE company_profiles.industry_source IS NULL
   OR company_profiles.industry_source NOT IN (${AUTHORITATIVE_LIST})
`;

/**
 * 取り込み済みの全法人に推定をかけ、company_profiles に書き込む。
 *
 * 権威ある出典 (gBizINFO / 手入力) が既に入っている行は書き換えない。
 * 何度実行しても結果は変わらない。
 */
export function classifyAll(db: Db, options: ClassifyOptions = {}): ClassifyResult {
  const minConfidence = options.minConfidence ?? 0.5;
  const activeOnly = options.activeOnly ?? true;
  const now = new Date().toISOString();

  const upsert = db.prepare(UPSERT_SQL);
  const byCode = new Map<string, number>();
  const byConfidence = new Map<number, number>();
  let scanned = 0;
  let inferred = 0;

  const flush = db.transaction((items: Array<{ n: string; hit: Inference }>) => {
    for (const { n, hit } of items) {
      upsert.run({
        n,
        code: hit.code,
        name: hit.name,
        source: SOURCE_NAME_INFERENCE,
        confidence: hit.confidence,
        now,
      });
    }
  });

  // 反復子を開いたまま書き込むことはできない (better-sqlite3 が拒否する) ため、
  // id で区切って読み切ってから書く。
  const pageSize = options.pageSize ?? 20_000;
  // 収集済みのサイト本文があれば併せて見る。商号だけでは 2 割しか当たらない
  const page = db.prepare(
    `SELECT c.id AS id, c.corporate_number AS n, c.name_core AS core, c.corp_form AS form,
            (SELECT h.site_text FROM web_hosts h
              WHERE h.corporate_number = c.corporate_number AND h.site_text IS NOT NULL
              LIMIT 1) AS site_text
       FROM corporations c
      WHERE c.id > ? ${activeOnly ? 'AND c.is_active = 1' : ''}
      ORDER BY c.id
      LIMIT ?`,
  );

  let lastId = 0;
  for (;;) {
    const rows = page.all(lastId, pageSize) as Array<{
      id: number;
      n: string;
      core: string;
      form: string | null;
      site_text: string | null;
    }>;
    if (rows.length === 0) break;

    const batch: Array<{ n: string; hit: Inference }> = [];
    for (const row of rows) {
      scanned++;
      // 商号で当たらなければ本文を見る (LLM を使わずに済む分はここで済ませる)
      let hit = inferIndustry(row.core, row.form);
      if (!hit && row.site_text) {
        const fromText = classifyFromText(row.site_text);
        if (fromText) {
          hit = {
            code: fromText.code, name: fromText.name,
            confidence: fromText.confidence,
            matched: `本文:${fromText.matched}×${fromText.occurrences}`,
          };
        }
      }
      if (hit && hit.confidence >= minConfidence) {
        batch.push({ n: row.n, hit });
        inferred++;
        byCode.set(hit.code, (byCode.get(hit.code) ?? 0) + 1);
        const band = Math.round(hit.confidence * 10) / 10;
        byConfidence.set(band, (byConfidence.get(band) ?? 0) + 1);
      }
    }
    if (batch.length > 0) flush(batch);

    lastId = rows[rows.length - 1]!.id;
    options.onProgress?.(scanned, inferred);
  }

  // 権威ある出典があって書き換えなかった件数を数える
  const skipped = db
    .prepare(`SELECT COUNT(*) AS n FROM company_profiles WHERE industry_source IN (${AUTHORITATIVE_LIST})`)
    .get() as { n: number };

  // 大量に書き込んだので統計を取り直す。
  // 画面の選択肢の控えもここで作り直しておく。捨てるだけにすると、
  // 次に画面を開いた人が 40 秒待たされる (待つならここで待つ方がよい)
  analyze(db);
  invalidateMeta(db);
  loadMeta(db);

  return { scanned, inferred, skippedAuthoritative: skipped.n, byCode, byConfidence };
}
