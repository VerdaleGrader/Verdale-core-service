import { AiProviderError, HttpAiClient, classifyFailure, parseInputs } from '@/libs/ai-provider';

const MODELS = { gemini: 'gemini-test', claude: 'claude-test' };
const PROMPT = { system: 'sys', user: 'usr' };

function client(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  }) as unknown as typeof fetch;
  return { ai: new HttpAiClient({ models: MODELS, fetchImpl }), calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('HttpAiClient', () => {
  it('asks Gemini with the key in a header, not the URL', async () => {
    const { ai, calls } = client(() =>
      json({ candidates: [{ content: { parts: [{ text: '{"inputs":["1 2\\n","3 4\\n"]}' }] } }] })
    );
    await expect(ai.generateInputs('gemini', 'secret-key', PROMPT)).resolves.toEqual([
      '1 2\n',
      '3 4\n',
    ]);
    expect(calls[0]!.url).toContain('gemini-test:generateContent');
    expect(calls[0]!.url).not.toContain('secret-key');
    expect((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key');
  });

  it('asks Claude and accepts a fenced answer', async () => {
    const { ai, calls } = client(() =>
      json({ content: [{ type: 'text', text: '```json\n["5\\n"]\n```' }] })
    );
    await expect(ai.generateInputs('claude', 'k', PROMPT)).resolves.toEqual(['5\n']);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe('claude-test');
    expect((calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('k');
  });

  it.each([
    [401, 'AI_KEY_INVALID'],
    [403, 'AI_KEY_INVALID'],
    [429, 'AI_QUOTA_EXCEEDED'],
    [503, 'AI_UNAVAILABLE'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const { ai } = client(() => json({ error: 'x' }, status));
    await expect(ai.generateInputs('claude', 'k', PROMPT)).rejects.toMatchObject({ code });
  });

  it('maps a network failure and a malformed answer', async () => {
    const down = client(() => {
      throw new Error('socket hang up');
    });
    await expect(down.ai.generateInputs('gemini', 'k', PROMPT)).rejects.toMatchObject({
      code: 'AI_UNAVAILABLE',
    });
    const odd = client(() => json({ content: [{ type: 'text', text: 'sorry, no' }] }));
    await expect(odd.ai.generateInputs('claude', 'k', PROMPT)).rejects.toMatchObject({
      code: 'AI_BAD_RESPONSE',
    });
  });

  it('never puts the key or the provider body in the error', async () => {
    const { ai } = client(() => new Response('bad key secret-key-123', { status: 401 }));
    const error = await ai
      .generateInputs('gemini', 'secret-key-123', PROMPT)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(JSON.stringify(error) + String((error as Error).message)).not.toContain('secret-key');
  });
});

describe('classifyFailure and parseInputs', () => {
  it('reads Gemini and Claude style 400s', () => {
    expect(classifyFailure(400, '{"error":{"message":"API key not valid"}}')).toBe(
      'AI_KEY_INVALID'
    );
    expect(classifyFailure(400, 'Your credit balance is too low')).toBe('AI_QUOTA_EXCEEDED');
    expect(classifyFailure(400, 'invalid request')).toBe('AI_BAD_RESPONSE');
  });

  it('rejects anything that is not a list of strings', () => {
    expect(() => parseInputs('{"inputs":[1,2]}')).toThrow(AiProviderError);
    expect(() => parseInputs('{"nope":true}')).toThrow(AiProviderError);
    expect(parseInputs('{"inputs":["a"]}')).toEqual(['a']);
  });
});
