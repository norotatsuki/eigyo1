/**
 * LLM にサイトの本文を読ませて、会社の情報を取り出す。
 *
 * 正規表現では「会社概要の表」のような決まった形しか拾えず、
 * 実測で会社名 68% / 住所 65% が上限だった。文章の中に紛れた書き方は取れない。
 *
 * ただし **LLM の出力をそのまま信じない**。
 * 抽出した値が原文に現れることを確かめてから採用する (grounding.ts)。
 */
import { DIVISIONS } from '../industry/classification.ts';
import type { Extracted } from '../site/extract.ts';
import type { Llm, Usage } from './client.ts';
import { emptyUsage } from './client.ts';
import { keepGrounded, looksLikeEmail, looksLikeTel } from './grounding.ts';

const EXTRACT_SYSTEM = `あなたは日本企業のウェブサイトの本文から、事実だけを抜き出す係です。

厳守すること:
- 本文に書かれていないことは絶対に書かない。分からない項目は null にする。
- 推測・補完・言い換えをしない。本文にある文字列をそのまま抜き出す。
- 会社名は正式名称 (株式会社/有限会社などを含む形) を本文どおりに。
  サイトの宣伝文句 (「〇〇なら」「地域No.1の」) は含めない。
- 住所は郵便番号を含む形が本文にあればそれを。
- 電話番号・メールアドレスは本文に書かれているものだけ。作らない。

次の形の JSON だけを返す:
{"name":string|null,"address":string|null,"tel":string|null,"email":string|null}`;

const CLASSIFY_SYSTEM = `あなたは日本企業を日本標準産業分類の中分類に当てはめる係です。

厳守すること:
- 与えられた情報だけで判断する。知らない会社について想像しない。
- 判断がつかない場合は code を null にする。当てずっぽうを返さない。
- confidence は 0.0-1.0 で、自信の度合いを正直に表す。

次の形の JSON だけを返す:
{"code":string|null,"confidence":number,"reason":string}`;

export interface LlmExtractResult {
  /** 原文に裏づけのある項目だけ */
  extracted: Partial<Extracted>;
  /** 原文に無かったため捨てた項目 */
  rejected: Array<{ field: string; value: string; reason: string }>;
  usage: Usage;
  error?: string;
}

/** 本文が長すぎると費用がかさむ。会社情報が載っている前半だけを渡す。 */
export function trimForLlm(text: string, maxChars = 4000): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

/**
 * サイトの本文から会社の情報を取り出す。
 *
 * 返るのは「原文に裏づけのある項目」だけ。
 * LLM が作った値は rejected に回して採用しない。
 */
export async function extractWithLlm(llm: Llm, text: string): Promise<LlmExtractResult> {
  const source = trimForLlm(text);
  const r = await llm.askJson<{
    name?: string | null; address?: string | null; tel?: string | null; email?: string | null;
  }>(EXTRACT_SYSTEM, source);

  if (!r.value) {
    return { extracted: {}, rejected: [], usage: r.usage, ...(r.error ? { error: r.error } : {}) };
  }

  // 原文に無い値は捨てる。ここを通さないと作られた宛先が混ざる
  const { grounded, rejected } = keepGrounded(
    {
      name: r.value.name ?? null,
      address: r.value.address ?? null,
      tel: r.value.tel ?? null,
      email: r.value.email ?? null,
    },
    source,
    ['name', 'address', 'tel', 'email'],
  );

  // 形として成り立っていないものも落とす
  const extracted: Partial<Extracted> = {};
  if (grounded.name) extracted.name = String(grounded.name);
  if (grounded.address) extracted.address = String(grounded.address);
  if (grounded.tel) {
    const tel = String(grounded.tel);
    if (looksLikeTel(tel)) extracted.tel = tel;
    else rejected.push({ field: 'tel', value: tel, reason: '電話番号の形をしていない' });
  }
  if (grounded.email) {
    const email = String(grounded.email);
    if (looksLikeEmail(email)) extracted.email = email;
    else rejected.push({ field: 'email', value: email, reason: 'メールアドレスの形をしていない' });
  }

  return { extracted, rejected, usage: r.usage };
}

export interface LlmClassifyResult {
  code: string | null;
  name: string | null;
  confidence: number;
  reason: string;
  usage: Usage;
  error?: string;
}

/** 使ってよい中分類の一覧を指示に載せる。これ以外のコードは採用しない。 */
const DIVISION_LIST = Object.entries(DIVISIONS)
  .map(([code, label]) => `${code}=${label}`)
  .join(' / ');

/**
 * 会社名と (あれば) サイトの本文から業種を当てる。
 *
 * 業種は「判断の結果」なので原文には現れない。接地の検証はかけられない。
 * 代わりに、返せるコードを日本標準産業分類の一覧に限り、
 * 一覧に無いコードは捨てる。確信度もそのまま保存し、
 * 低いものは検索で切り落とせるようにする。
 */
export async function classifyWithLlm(
  llm: Llm,
  companyName: string,
  siteText?: string,
): Promise<LlmClassifyResult> {
  const user = [
    `会社名: ${companyName}`,
    siteText ? `サイトの本文:\n${trimForLlm(siteText, 1500)}` : '(サイトの本文は取得できていません)',
    '',
    `使える中分類: ${DIVISION_LIST}`,
  ].join('\n');

  const r = await llm.askJson<{ code?: string | null; confidence?: number; reason?: string }>(
    CLASSIFY_SYSTEM,
    user,
  );
  if (!r.value) {
    return {
      code: null, name: null, confidence: 0, reason: '',
      usage: r.usage, ...(r.error ? { error: r.error } : {}),
    };
  }

  const code = r.value.code ?? null;
  // 一覧に無いコードは採用しない (作られた番号を弾く)
  if (code !== null && !(code in DIVISIONS)) {
    return {
      code: null, name: null, confidence: 0,
      reason: `一覧に無いコード (${code}) のため採用しない`,
      usage: r.usage,
    };
  }
  const confidence = Math.max(0, Math.min(1, r.value.confidence ?? 0));
  return {
    code,
    name: code ? (DIVISIONS[code] ?? null) : null,
    confidence,
    reason: r.value.reason ?? '',
    usage: r.usage,
  };
}

export const _internal = { EXTRACT_SYSTEM, CLASSIFY_SYSTEM, emptyUsage };
