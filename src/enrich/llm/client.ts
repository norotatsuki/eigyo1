/**
 * LLM への問い合わせ口 (OpenAI 互換)。
 *
 * 使うのは「手元にある文章を読んで判断させる」ためだけ。
 * 知らないことを答えさせない。とくに接触先 (URL・メール・電話) を
 * 生成させることは禁止する。存在しない宛先に送れば
 * バウンスで送信元の評価が焼け、最悪は無関係な第三者に届く。
 *
 * 鍵は環境変数 OPENAI_API_KEY から読む。設定ファイルには書かせない。
 */

export interface LlmConfig {
  baseUrl: string;
  model: string;
  /** 1 回の応答の上限。抽出も分類も短いので小さくてよい */
  maxTokens: number;
  timeoutMs: number;
}

export const DEFAULT_LLM: LlmConfig = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  maxTokens: 500,
  timeoutMs: 60_000,
};

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export const emptyUsage = (): Usage => ({ promptTokens: 0, completionTokens: 0, calls: 0 });

export interface LlmResult<T> {
  value: T | null;
  usage: Usage;
  error?: string;
}

/** 問い合わせ口。試験では差し替える。 */
export interface Llm {
  /** 指示と本文を渡し、JSON を返させる */
  askJson: <T>(system: string, user: string) => Promise<LlmResult<T>>;
}

function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    promptTokens: a.promptTokens + (b.promptTokens ?? 0),
    completionTokens: a.completionTokens + (b.completionTokens ?? 0),
    calls: a.calls + (b.calls ?? 0),
  };
}

/** 環境変数の鍵を使って実際に問い合わせる口を作る。 */
export function createLlm(config: LlmConfig = DEFAULT_LLM): Llm {
  const key = process.env['OPENAI_API_KEY'];
  if (!key) throw new Error('環境変数 OPENAI_API_KEY が設定されていません');

  return {
    async askJson<T>(system: string, user: string): Promise<LlmResult<T>> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), config.timeoutMs);
      try {
        const res = await fetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          signal: ctrl.signal,
          body: JSON.stringify({
            model: config.model,
            max_tokens: config.maxTokens,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          return { value: null, usage: emptyUsage(), error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
        }
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const usage = addUsage(emptyUsage(), {
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
          calls: 1,
        });
        const content = json.choices?.[0]?.message?.content;
        if (!content) return { value: null, usage, error: '応答が空です' };
        try {
          return { value: JSON.parse(content) as T, usage };
        } catch {
          return { value: null, usage, error: 'JSON として読めません' };
        }
      } catch (err) {
        return {
          value: null,
          usage: emptyUsage(),
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * 費用の見積もり。
 *
 * 何十万件も回す前に、いくらかかるかを知っておく必要がある。
 * 単価は変わるので、利用者が指定できるようにしてある。
 */
export interface Pricing {
  /** 100 万トークンあたりの価格 (入力) */
  inputPerMillion: number;
  /** 100 万トークンあたりの価格 (出力) */
  outputPerMillion: number;
  currency: string;
}

export function estimateCost(usage: Usage, pricing: Pricing): number {
  return (
    (usage.promptTokens / 1_000_000) * pricing.inputPerMillion +
    (usage.completionTokens / 1_000_000) * pricing.outputPerMillion
  );
}

/** おおよそのトークン数。日本語は 1 文字あたり 1 トークン前後として見る。 */
export function roughTokens(text: string): number {
  return Math.ceil(text.length * 0.9);
}
