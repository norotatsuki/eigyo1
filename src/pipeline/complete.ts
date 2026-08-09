/**
 * 集め切るまでを一続きで回す。
 *
 * 手で順番に叩いてもよいが、全部で 10 時間ほどかかるうえ、
 * 「収集が終わったら業種を入れる」「抽出を直したら訪ね直す」といった
 * 順序が決まっている。手順を覚えていなくても最後まで進むようにする。
 *
 * **中断しても続きから始まる。** どこまで進んだかはデータベース側の状態
 * (crawl_status / social_links の有無) から判断していて、別に控えを持たない。
 * 控えを持つと、途中で落ちたときに実態とずれる。
 */
import type { Db } from '../db/index.ts';
import { classifyAll } from '../enrich/industry/classify.ts';
import {
  crawlPendingHosts, normalizeStoredSocial, rematchHosts, repairBusinessEvidence,
  repairEmails, repairRepresentatives, resetFailedHosts, scrubContactUrls,
} from '../enrich/site/crawl.ts';

export interface CompleteOptions {
  concurrency?: number;
  /** 1 回の収集で訪ねる上限。区切って進めることで、途中経過が残る */
  batchSize?: number;
  /** 送れる先がこの数に達したら止める */
  target?: number;
  /** 接続できなかった先を訪ね直す回数の上限 */
  maxAttempts?: number;
  /** 収集し終えた先を、いまの抽出で訪ね直すか */
  revisit?: boolean;
  onStage?: (stage: string, detail: string) => void;
}

export interface CompleteResult {
  visited: number;
  revisited: number;
  retried: number;
  qualified: number;
  stoppedAtTarget: boolean;
}

/** 送れる先 (メール または フォームが分かっている法人) の数。 */
function countQualified(db: Db): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM company_profiles
          WHERE (contact_email IS NOT NULL AND contact_email <> '')
             OR (contact_form_url IS NOT NULL AND contact_form_url <> '')`,
      )
      .get() as { n: number }
  ).n;
}

const pendingCount = (db: Db): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM web_hosts WHERE crawl_status = 'pending'").get() as { n: number }).n;

/**
 * 抽出を足す前に訪ねた先を、訪問対象に戻す。
 *
 * SNS も出典も入っていない行は、それらを取れるようになる前に訪ねたもの。
 * 本文は手元にあるが、リンクは HTML にしかないため訪ね直すしかない。
 */
export function requeueStale(db: Db): number {
  return db
    .prepare(
      `UPDATE web_hosts SET crawl_status = 'pending'
        WHERE crawl_status = 'ok' AND field_sources IS NULL`,
    )
    .run().changes;
}

export async function runToCompletion(
  db: Db,
  options: CompleteOptions = {},
): Promise<CompleteResult> {
  const concurrency = options.concurrency ?? 48;
  const batchSize = options.batchSize ?? 20_000;
  const maxAttempts = options.maxAttempts ?? 2;
  const say = options.onStage ?? ((): void => {});

  const result: CompleteResult = {
    visited: 0, revisited: 0, retried: 0, qualified: 0, stoppedAtTarget: false,
  };

  /** 未訪問が尽きるまで区切って回す。区切るのは途中経過を残すため。 */
  const drain = async (label: string): Promise<boolean> => {
    for (;;) {
      const left = pendingCount(db);
      if (left === 0) return false;
      say(label, `残り ${left.toLocaleString('ja-JP')} 件`);

      const r = await crawlPendingHosts(db, {
        limit: batchSize,
        concurrency,
        ...(options.target !== undefined ? { target: options.target } : {}),
      });
      result.visited += r.visited;
      if (r.stoppedAtTarget) {
        result.stoppedAtTarget = true;
        result.qualified = r.qualified;
        return true;
      }
      // 1 件も進まなかったら、これ以上回しても変わらない
      if (r.visited === 0) return false;
    }
  };

  // ① まだ訪ねていない先
  if (await drain('収集')) return result;

  /*
   * ② 抽出を足す前に集めた先を訪ね直す。
   *
   * 繋がらなかった先の再挑戦より先に回す。実測 (2026-08-10):
   *   訪ね直しの対象 44,453 件 … うち 31,647 件は既に宛先が取れている
   *                              = 生きているサイト。代表者 0 件 / SNS 507 件
   *                              つまり訪ねれば確実に埋まる。所要 62 分
   *   再挑戦の対象  137,500 件 … 一度繋がらなかった先。大半は死んだドメインで
   *                              歩留まりが低い。所要 3 時間超
   * 確実に埋まる方を先に済ませれば、全項目が 3 時間早く揃う。
   */
  if (options.revisit !== false) {
    const stale = requeueStale(db);
    if (stale > 0) {
      say('訪ね直し', `古い抽出のまま ${stale.toLocaleString('ja-JP')} 件`);
      result.revisited = stale;
      if (await drain('訪ね直し')) return result;
    }
  }

  // ③ 繋がらなかった先を、回数の上限まで訪ね直す。
  //    一時的な不調で落ちた先が混ざっているため
  const retryable = (
    db
      .prepare("SELECT COUNT(*) AS n FROM web_hosts WHERE crawl_status = 'failed' AND attempts < ?")
      .get(maxAttempts) as { n: number }
  ).n;
  if (retryable > 0) {
    say('再挑戦', `繋がらなかった ${retryable.toLocaleString('ja-JP')} 件`);
    result.retried = resetFailedHosts(db);
    if (await drain('再挑戦')) return result;
  }

  // ④ 集め終えてから、手元のデータだけで直せるものを直す。
  //    ここはサイトを訪ねないので、何度やっても相手に負担をかけない
  say('業種', 'サイトを集めた先に業種を入れます');
  const classified = classifyAll(db, { withSiteOnly: true });
  say('業種', `${classified.inferred.toLocaleString('ja-JP')} 件に入れました`);

  say('再照合', '収集済みのデータで突き合わせをやり直します');
  const rematched = rematchHosts(db);
  say('再照合', `紐付き ${rematched.matched.toLocaleString('ja-JP')} 件 / 外した ${rematched.cleared} 件`);

  say('点検', '宛先・代表者名・事業内容・SNS を見直します');
  const scrubbed = scrubContactUrls(db);
  const reps = repairRepresentatives(db);
  const biz = repairBusinessEvidence(db);
  const sns = normalizeStoredSocial(db);
  const mail = repairEmails(db);
  say(
    '点検',
    `宛先 -${scrubbed.removed} / 代表者名 -${reps.cleared} / 事業内容 -${biz.cleared}` +
    ` / SNS ${sns.fixed} / メール 直し ${mail.fixed} 除去 ${mail.cleared}`,
  );

  result.qualified = countQualified(db);
  return result;
}
