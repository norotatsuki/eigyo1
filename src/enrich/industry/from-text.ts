/**
 * サイトの本文から業種を当てる (LLM を使わない)。
 *
 * 商号だけでは 2 割しか当たらない (屋号が多いため)。本文を見れば手がかりは増えるが、
 * 素朴に「最初に見つかった語」を採ると外す。実測した誤りの例:
 *   「株式会社21インコーポレーション」→ 本文に「銀行」→ 銀行業
 *   「株式会社21世紀プランニング」→ 本文に「放送」→ 放送業
 * いずれも支払い案内や取引先紹介にたまたま出た語だった。
 *
 * そこで **出現回数で重み付け** する。本当に建設会社なら「建設」は何度も出るが、
 * 取引先として 1 回名前が挙がるだけとは違う。
 */
import { KEYWORD_RULES, OVERRIDE_RULES } from './rules.ts';
import { divisionName } from './classification.ts';

export interface TextInference {
  code: string;
  name: string;
  confidence: number;
  /** 判断の根拠になった語と、その出現回数 */
  matched: string;
  occurrences: number;
}

/** この回数に満たない語は、たまたま出ただけとみなして採らない。 */
const MIN_OCCURRENCES = 3;

/** 本文のうち見るのはここまで。後ろの方は会社案内から離れていく。 */
const MAX_CHARS = 3000;

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

/**
 * 本文から業種を当てる。
 *
 * 得点は「出現回数 × 語の確信度」。回数が多いほど、その会社の本業に近い。
 * 確信度は語そのものの確かさ (「歯科」は強く、「工業」は弱い) を反映する。
 *
 * @param text サイトの本文
 * @param minOccurrences たまたま出た語を切る閾値
 */
export function classifyFromText(
  text: string,
  minOccurrences = MIN_OCCURRENCES,
): TextInference | null {
  const body = text.slice(0, MAX_CHARS).normalize('NFKC').toLowerCase();
  if (body.length === 0) return null;

  // 「一見 X に見えるが実は Y」は本文でも先に押さえる (獣医業など)
  for (const rule of OVERRIDE_RULES) {
    const n = countOccurrences(body, rule.keyword.toLowerCase());
    if (n >= minOccurrences) {
      return {
        code: rule.code, name: divisionName(rule.code),
        confidence: rule.confidence, matched: rule.keyword, occurrences: n,
      };
    }
  }

  let best: (TextInference & { score: number }) | null = null;
  for (const rule of KEYWORD_RULES) {
    const n = countOccurrences(body, rule.keyword.toLowerCase());
    if (n < minOccurrences) continue;
    const score = n * rule.confidence;
    if (!best || score > best.score) {
      best = {
        code: rule.code, name: divisionName(rule.code),
        // 何度も出ている語ほど確からしい。ただし語そのものの上限は超えない
        confidence: Math.min(rule.confidence + Math.min(0.15, (n - minOccurrences) * 0.02), 0.95),
        matched: rule.keyword, occurrences: n, score,
      };
    }
  }
  if (!best) return null;
  const { score: _score, ...rest } = best;
  return rest;
}
