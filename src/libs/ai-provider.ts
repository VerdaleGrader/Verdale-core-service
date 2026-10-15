/**
 * Asks Gemini or Claude for testcase inputs with the author's own API key
 * (GRD-124). Plain `fetch` with an injectable `fetchImpl`, like HttpJudgeClient.
 *
 * The key and anything a provider answered are never logged or put in an error
 * message: providers can echo the key back, so callers only see an
 * `AiProviderError` with a fixed code.
 */
export type AiProviderName = 'gemini' | 'claude';

export type AiProviderErrorCode =
  | 'AI_KEY_INVALID'
  | 'AI_QUOTA_EXCEEDED'
  | 'AI_BAD_RESPONSE'
  | 'AI_UNAVAILABLE';

export class AiProviderError extends Error {
  constructor(readonly code: AiProviderErrorCode) {
    super(code);
  }
}

export interface AiPrompt {
  system: string;
  user: string;
}

export interface AiClient {
  /** Returns the model's list of input texts. Throws `AiProviderError`. */
  generateInputs(provider: AiProviderName, apiKey: string, prompt: AiPrompt): Promise<string[]>;
}

export interface HttpAiClientOptions {
  models: { gemini: string; claude: string };
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const MAX_OUTPUT_TOKENS = 16384;

export class HttpAiClient implements AiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpAiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }

  async generateInputs(
    provider: AiProviderName,
    apiKey: string,
    prompt: AiPrompt
  ): Promise<string[]> {
    const request =
      provider === 'gemini'
        ? this.geminiRequest(apiKey, prompt)
        : this.claudeRequest(apiKey, prompt);
    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AiProviderError('AI_UNAVAILABLE');
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) throw new AiProviderError(classifyFailure(response.status, text));
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AiProviderError('AI_BAD_RESPONSE');
    }
    const answer = provider === 'gemini' ? geminiText(json) : claudeText(json);
    return parseInputs(answer);
  }

  private geminiRequest(apiKey: string, prompt: AiPrompt) {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        this.options.models.gemini
      )}:generateContent`,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: {
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      },
    };
  }

  private claudeRequest(apiKey: string, prompt: AiPrompt) {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: this.options.models.claude,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
      },
    };
  }
}

/** Maps a failed HTTP answer to a code. The body is only searched, never kept. */
export function classifyFailure(status: number, body: string): AiProviderErrorCode {
  const lower = body.toLowerCase();
  if (status === 401 || status === 403) return 'AI_KEY_INVALID';
  if (status === 429 || status === 402) return 'AI_QUOTA_EXCEEDED';
  if (status === 400) {
    if (lower.includes('api key') || lower.includes('api_key') || lower.includes('x-api-key')) {
      return 'AI_KEY_INVALID';
    }
    if (lower.includes('credit balance') || lower.includes('quota') || lower.includes('billing')) {
      return 'AI_QUOTA_EXCEEDED';
    }
    return 'AI_BAD_RESPONSE';
  }
  if (status >= 500 || status === 408) return 'AI_UNAVAILABLE';
  return 'AI_BAD_RESPONSE';
}

function geminiText(json: unknown): string {
  const candidates = (json as { candidates?: unknown })?.candidates;
  const parts = Array.isArray(candidates)
    ? (candidates[0] as { content?: { parts?: unknown } })?.content?.parts
    : undefined;
  if (!Array.isArray(parts)) throw new AiProviderError('AI_BAD_RESPONSE');
  return parts
    .map((part) =>
      typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''
    )
    .join('');
}

function claudeText(json: unknown): string {
  const content = (json as { content?: unknown })?.content;
  if (!Array.isArray(content)) throw new AiProviderError('AI_BAD_RESPONSE');
  return content
    .map((block) => {
      const entry = block as { type?: unknown; text?: unknown };
      return entry.type === 'text' && typeof entry.text === 'string' ? entry.text : '';
    })
    .join('');
}

/** Accepts `{"inputs": [...]}` or a bare array, with or without a Markdown code fence. */
export function parseInputs(answer: string): string[] {
  const unfenced = answer
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let value: unknown;
  try {
    value = JSON.parse(unfenced);
  } catch {
    throw new AiProviderError('AI_BAD_RESPONSE');
  }
  const list = Array.isArray(value) ? value : (value as { inputs?: unknown })?.inputs;
  if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
    throw new AiProviderError('AI_BAD_RESPONSE');
  }
  return list as string[];
}
