/**
 * 接地の検証 — LLM が言ったことが原文にあるかを確かめる。
 *
 * これがこの層の要である。LLM は知らないことを聞かれると、
 * もっともらしい答えを作る。会社のメールアドレスや電話番号を
 * 作られると、存在しない宛先に送ってバウンスで送信元の評価を焼くか、
 * 最悪は無関係な第三者に届く。
 *
 * そこで「抽出」は必ず原文との照合を通す。
 * 原文に無い値は、LLM がどれだけ自信ありげでも捨てる。
 *
 * 照合は表記のゆれを吸収する必要がある。原文が全角、応答が半角という
 * ことは日常的に起きるため、NFKC で揃えてから比べる。
 */

/** 比べるための正規化。全角半角・空白・区切りの横棒を揃える。 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‐-―−－]/g, '-')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** その値が原文に現れるか。 */
export function appearsIn(value: string, source: string): boolean {
  const v = normalizeForMatch(value);
  if (v.length === 0) return false;
  return normalizeForMatch(source).includes(v);
}

export interface GroundCheck<T> {
  /** 原文に裏づけのある項目だけを残した結果 */
  grounded: Partial<T>;
  /** 原文に無かったため捨てた項目 */
  rejected: Array<{ field: string; value: string; reason: string }>;
}

/**
 * 抽出結果を原文と突き合わせ、裏づけのある項目だけを残す。
 *
 * @param fields 検証する項目。原文にそのまま現れるはずのものだけを挙げる
 *               (会社名・住所・電話・メールなど)。
 *               「業種」のような判断の結果は原文に現れないので、ここには入れない。
 */
export function keepGrounded<T extends Record<string, unknown>>(
  extracted: T,
  source: string,
  fields: ReadonlyArray<keyof T & string>,
): GroundCheck<T> {
  const grounded: Partial<T> = {};
  const rejected: GroundCheck<T>['rejected'] = [];

  for (const field of fields) {
    const raw = extracted[field];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = String(raw);

    if (appearsIn(value, source)) {
      grounded[field] = raw;
    } else {
      rejected.push({
        field,
        value,
        reason: '原文に見当たらないため採用しない (作られた値の可能性)',
      });
    }
  }
  return { grounded, rejected };
}

/** メールアドレスとして成り立っているか。接地の検証と併せて使う。 */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value.trim());
}

/** 電話番号として成り立っているか (日本の市外局番から始まる 10-11 桁)。 */
export function looksLikeTel(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return (digits.length === 10 || digits.length === 11) && digits.startsWith('0');
}

/** URL として成り立っているか。 */
export function looksLikeUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
