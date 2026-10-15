import { PDFDocument } from 'pdf-lib';
import { Cast, castSpace, createDraft, joinSpace, problemUrl } from '@/test/fixtures';
import { createTestApp, describeDb, jobResult, resetDatabase, TestApp } from '@/test/harness';
import type { JobRequest } from '@/libs/judge';
import { buildPrompt } from '@/services/problem/ai-test.service';

describe('buildPrompt', () => {
  const base = {
    title: 'Sum',
    statement: 'Print $a+b$.',
    timeLimitMs: 1000,
    memoryLimitKb: 262144,
    count: 4,
    categories: [] as Array<'edge' | 'max' | 'random'>,
  };

  it('uses the statement alone by default and follows it when no category is chosen', () => {
    const prompt = buildPrompt(base);
    expect(prompt.user).toContain('Print $a+b$.');
    expect(prompt.user).toContain('Write exactly 4 inputs.');
    expect(prompt.user).toContain('sensible mix');
    expect(prompt.user).not.toContain('Reference solution');
    expect(prompt.system).toContain('{"inputs"');
  });

  it('adds the author’s note, and nothing when there is none', () => {
    expect(buildPrompt({ ...base, note: 'Use only prime numbers.' }).user).toContain(
      'Use only prime numbers.'
    );
    expect(buildPrompt(base).user).not.toContain('Extra notes');
  });

  it('names the chosen categories and adds the solution only when given', () => {
    const prompt = buildPrompt({
      ...base,
      categories: ['edge', 'max'],
      solution: { language: 'python', source: 'print(1)' },
    });
    expect(prompt.user).toContain('edge cases');
    expect(prompt.user).toContain('largest the constraints allow');
    expect(prompt.user).toContain('Reference solution (python)');
    expect(prompt.user).toContain('print(1)');
  });
});

describeDb('AI testcases: a model writes inputs, Judge makes the outputs (GRD-124)', () => {
  let t: TestApp;
  let cast: Cast;
  const KEY = 'sk-test-0123456789abcdef-SECRET';

  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    cast = await castSpace(t);
  });
  afterEach(async () => t.close());

  const url = (suffix = '') => problemUrl(cast.slug, 'sum', suffix);

  async function withSolution(client = cast.editor) {
    await createDraft(client, cast.slug, 'sum');
    const solution = await client.request('POST', url('/solutions'), {
      language: 'python',
      source: 'print(SECRET_SOLUTION)',
      is_primary: true,
    });
    expect(solution.status).toBe(201);
    return solution.body.id as string;
  }

  const saveKey = (client = cast.editor, provider = 'claude', apiKey = KEY) =>
    client.request('PUT', `/api/v1/me/ai-credentials/${provider}`, { api_key: apiKey });

  async function start(
    solutionId: string,
    extra: Record<string, unknown> = {},
    client = cast.editor
  ) {
    return client.request('POST', url('/ai-tests'), {
      provider: 'claude',
      count: 3,
      solution_id: solutionId,
      ...extra,
    });
  }

  const answered = (
    job: JobRequest,
    outputs: Record<number, Partial<{ verdict: string; stdout: string }>>
  ) =>
    jobResult(job, {
      kind: 'generate',
      verdict: 'AC',
      tests: job.tests.map((test, index) => {
        const given = outputs[index] ?? { verdict: 'AC', stdout: `${index + 1}\n` };
        return {
          id: test.id,
          verdict: given.verdict ?? 'AC',
          time_ms: 4,
          memory_kb: 900,
          ...(given.stdout !== undefined ? { stdout: given.stdout } : {}),
        };
      }),
      summary: { passed: job.tests.length, total: job.tests.length, time_ms: 4, memory_kb: 900 },
    } as never);

  describe('API keys', () => {
    it('saves a key, shows only its last four characters, replaces and removes it', async () => {
      const saved = await saveKey();
      expect(saved.status).toBe(200);
      expect(saved.body).toEqual({ provider: 'claude', last4: KEY.slice(-4) });

      const listed = await cast.editor.request('GET', '/api/v1/me/ai-credentials');
      expect(listed.body).toEqual({
        enabled: true,
        items: [{ provider: 'claude', last4: KEY.slice(-4) }],
      });
      expect(JSON.stringify(listed.body)).not.toContain('SECRET');

      expect((await saveKey(cast.editor, 'claude', 'another-key-value-9999')).body.last4).toBe(
        '9999'
      );
      expect((await cast.editor.request('DELETE', '/api/v1/me/ai-credentials/claude')).status).toBe(
        204
      );
      expect((await cast.editor.request('GET', '/api/v1/me/ai-credentials')).body.items).toEqual(
        []
      );
    });

    it('stores the key encrypted, never as text', async () => {
      await saveKey();
      const row = await t.prisma.userAiCredential.findFirstOrThrow();
      expect(Buffer.from(row.key_ciphertext).toString('utf8')).not.toContain('SECRET');
      expect(row.key_id).toBe('ai-test');
    });

    it('keeps each person’s keys apart and needs a login', async () => {
      await saveKey();
      expect((await cast.owner.request('GET', '/api/v1/me/ai-credentials')).body.items).toEqual([]);
      expect((await cast.visitor.request('GET', '/api/v1/me/ai-credentials')).status).toBe(401);
      expect((await saveKey(cast.editor, 'openai')).status).toBe(400);
      expect((await saveKey(cast.editor, 'claude', 'has a space inside')).status).toBe(400);
    });
  });

  describe('starting', () => {
    it('only people who can edit the problem may start; the key must exist first', async () => {
      const solutionId = await withSolution();
      await saveKey(cast.solver);
      expect((await start(solutionId, {}, cast.solver)).status).toBe(403);
      expect((await start(solutionId, {}, cast.outsider)).status).toBe(404);
      expect((await start(solutionId, {}, cast.visitor)).status).toBe(401);
      const missingKey = await start(solutionId);
      expect(missingKey.status).toBe(409);
      expect(missingKey.body.error_code).toBe('AI_KEY_MISSING');
      expect(t.ai.calls).toHaveLength(0);

      const observer = await joinSpace(t, cast, 'olga', 'observer');
      await saveKey(observer);
      expect((await start(solutionId, {}, observer)).status).toBe(403);
    });

    it('needs a count, a known provider and a solution of this problem', async () => {
      const solutionId = await withSolution();
      await saveKey();
      expect((await start(solutionId, { count: undefined })).status).toBe(400);
      expect((await start(solutionId, { count: 0 })).status).toBe(400);
      expect((await start(solutionId, { count: 21 })).status).toBe(400);
      expect((await start(solutionId, { provider: 'openai' })).status).toBe(400);
      expect((await start('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    });
  });

  describe('the flow', () => {
    it('puts the author’s note in the prompt, and refuses one that is too long', async () => {
      const solutionId = await withSolution();
      await saveKey();
      expect((await start(solutionId, { note: 'x'.repeat(1001) })).status).toBe(400);
      expect((await start(solutionId, { note: '  Make n a power of two.  ' })).status).toBe(202);
      await t.settle();
      expect(t.ai.calls[0]!.prompt.user).toContain('Make n a power of two.');
    });

    it('sends only the statement by default, then runs the solution on the inputs and drafts them', async () => {
      const solutionId = await withSolution();
      await saveKey();
      const started = await start(solutionId, { categories: ['edge'] });
      expect(started.status).toBe(202);
      expect(started.body).toMatchObject({ status: 'generating', requested_count: 3 });
      await t.settle();

      expect(t.ai.calls).toHaveLength(1);
      const call = t.ai.calls[0]!;
      expect(call).toMatchObject({ provider: 'claude', apiKey: KEY });
      expect(call.prompt.user).toContain('Read $a$ and $b$ and print $a + b$.');
      expect(call.prompt.user).toContain('edge cases');
      expect(call.prompt.user).not.toContain('SECRET_SOLUTION');

      expect(t.judge.jobs).toHaveLength(1);
      const job = t.judge.last;
      expect(job).toMatchObject({
        kind: 'generate',
        language: 'python',
        source: 'print(SECRET_SOLUTION)',
      });
      expect(job.tests).toHaveLength(3);
      expect(job.tests.every((test) => test.output === undefined)).toBe(true);

      const computing = await cast.editor.request('GET', url(`/ai-tests/${started.body.id}`));
      expect(computing.body.status).toBe('computing');
      expect(computing.body.items.map((item: { status: string }) => item.status)).toEqual([
        'pending',
        'pending',
        'pending',
      ]);

      expect((await t.deliver(answered(job, {}))).status).toBe(204);
      const done = await cast.editor.request('GET', url(`/ai-tests/${started.body.id}`));
      expect(done.body).toMatchObject({ status: 'completed', usable_count: 3, skipped_count: 0 });
      expect(done.body.items[0]).toMatchObject({
        status: 'ok',
        input_text: '1 2\n',
        output_preview: '1\n',
      });
      expect(done.body.items[0].output.sha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('sends the solution to the provider only when the author turned that on', async () => {
      const solutionId = await withSolution();
      await saveKey();
      await start(solutionId, { include_solution: true });
      await t.settle();
      expect(t.ai.calls[0]!.prompt.user).toContain('print(SECRET_SOLUTION)');
    });

    it('sends a PDF statement to the model as a document instead of refusing it', async () => {
      const solutionId = await withSolution();
      await saveKey();
      const document = await PDFDocument.create();
      document.addPage();
      const bytes = Buffer.from(await document.save());
      const uploaded = await cast.editor.upload('PUT', url('/statement/pdf'), [
        { name: 'file', filename: 'statement.pdf', content: bytes, contentType: 'application/pdf' },
      ]);
      expect(uploaded.status).toBe(200);
      const started = await start(solutionId);
      expect(started.status).toBe(202);
      await t.settle();
      const call = t.ai.calls[0]!;
      expect(call.prompt.pdf?.equals(bytes)).toBe(true);
      expect(call.prompt.user).toContain('The statement is the attached PDF.');
      expect(t.judge.jobs).toHaveLength(1);
    });

    it('adds nothing to the testcases: drafts stay drafts until the author saves them', async () => {
      const solutionId = await withSolution();
      await saveKey();
      const started = await start(solutionId);
      await t.settle();
      await t.deliver(answered(t.judge.last, {}));
      expect(await t.prisma.testCase.count()).toBe(0);
      const list = await cast.editor.request('GET', url('/tests'));
      expect(list.body.items).toEqual([]);

      // The author confirms: the same hashes go through the existing save.
      const finished = await cast.editor.request('GET', url(`/ai-tests/${started.body.id}`));
      const tests = finished.body.items.map(
        (item: { input: { sha256: string }; output: { sha256: string } }) => ({
          is_sample: false,
          input: { sha256: item.input.sha256 },
          output: { sha256: item.output.sha256 },
        })
      );
      const saved = await cast.editor.request('PUT', url('/tests'), { tests });
      expect(saved.status).toBe(200);
      expect(saved.body.items).toHaveLength(3);
    });

    it('skips inputs that are malformed, empty or repeated, and says why', async () => {
      const solutionId = await withSolution();
      await saveKey();
      t.ai.inputs = ['1 2\n', '1 2\r\n', '', 'bad\u0000input\n', '7 8\n'];
      const started = await start(solutionId, { count: 5 });
      await t.settle();
      await t.deliver(answered(t.judge.last, {}));
      const done = await cast.editor.request('GET', url(`/ai-tests/${started.body.id}`));
      expect(done.body.items.map((item: { status: string }) => item.status)).toEqual([
        'ok',
        'skipped',
        'skipped',
        'skipped',
        'ok',
      ]);
      expect(done.body.items[1].skip_reason).toBe('Input 2 repeats input 1.');
      expect(done.body.items[2].skip_reason).toBe('Input 3 is empty.');
      expect(done.body.items[3].skip_reason).toMatch(/^Input 4 contains a NUL byte/);
      expect(done.body).toMatchObject({ usable_count: 2, skipped_count: 3 });
      expect(t.judge.last.tests).toHaveLength(2);
    });

    it('skips an input the solution cannot run, with the reason, and keeps the rest', async () => {
      const solutionId = await withSolution();
      await saveKey();
      const started = await start(solutionId);
      await t.settle();
      await t.deliver(answered(t.judge.last, { 1: { verdict: 'TLE' }, 2: { verdict: 'RE' } }));
      const done = await cast.editor.request('GET', url(`/ai-tests/${started.body.id}`));
      expect(done.body.items.map((item: { status: string }) => item.status)).toEqual([
        'ok',
        'skipped',
        'skipped',
      ]);
      expect(done.body.items[1].skip_reason).toBe('Time limit exceeded on this input.');
      expect(done.body.items[2].skip_reason).toBe('Runtime error on this input.');
      expect(done.body).toMatchObject({ status: 'completed', usable_count: 1, skipped_count: 2 });
    });

    it('fails the job when the solution does not compile', async () => {
      const solutionId = await withSolution();
      await saveKey();
      const started = await start(solutionId);
      await t.settle();
      await t.deliver(
        jobResult(t.judge.last, {
          kind: 'generate',
          verdict: 'CE',
          compile: { ok: false, message: 'error: expected ;\nmore', time_ms: 3 },
          tests: [],
          summary: { passed: 0, total: 0, time_ms: 0, memory_kb: 0 },
        } as never)
      );
      const done = await cast.editor.request('GET', url(`/ai-tests/${started.body.id}`));
      expect(done.body.status).toBe('failed');
      expect(done.body.error).toEqual({ code: 'COMPILE_ERROR', message: 'error: expected ;' });
    });

    it('answers a duplicate Judge result without changing anything, and an unknown job with 404', async () => {
      const solutionId = await withSolution();
      await saveKey();
      await start(solutionId);
      await t.settle();
      const result = answered(t.judge.last, {});
      expect((await t.deliver(result)).status).toBe(204);
      expect((await t.deliver(result)).status).toBe(204);
      const unknown = { ...result, job_id: '00000000-0000-4000-8000-000000000001' };
      expect((await t.deliver(unknown)).status).toBe(404);
    });
  });

  describe('failures are explained', () => {
    it.each([
      ['AI_KEY_INVALID', /did not accept your API key/],
      ['AI_QUOTA_EXCEEDED', /quota/],
      ['AI_BAD_RESPONSE', /could not read/],
      ['AI_UNAVAILABLE', /could not be reached/],
    ] as const)('maps a provider failure %s to a job error', async (code, message) => {
      const solutionId = await withSolution();
      await saveKey();
      t.ai.failure = code;
      const started = await start(solutionId);
      await t.settle();
      const done = await cast.editor.request('GET', url(`/ai-tests/${started.body.id}`));
      expect(done.body.status).toBe('failed');
      expect(done.body.error.code).toBe(code);
      expect(done.body.error.message).toMatch(message);
      expect(t.judge.jobs).toHaveLength(0);
    });

    it('fails when the model returns nothing usable, and when Judge is down', async () => {
      const solutionId = await withSolution();
      await saveKey();
      t.ai.inputs = [];
      let started = await start(solutionId);
      await t.settle();
      expect(
        (await cast.editor.request('GET', url(`/ai-tests/${started.body.id}`))).body.error.code
      ).toBe('AI_BAD_RESPONSE');

      t.ai.inputs = ['1 2\n'];
      t.judge.mode = 'down';
      started = await start(solutionId);
      await t.settle();
      const done = await cast.editor.request('GET', url(`/ai-tests/${started.body.id}`));
      expect(done.body.error.code).toBe('JUDGE_UNAVAILABLE');
    });

    it('allows one run at a time per problem, and a new one after it ends', async () => {
      const solutionId = await withSolution();
      await saveKey();
      await start(solutionId);
      await t.settle();
      const second = await start(solutionId);
      expect(second.status).toBe(409);
      expect(second.body.error_code).toBe('AI_TEST_RUNNING');
      await t.deliver(answered(t.judge.last, {}));
      expect((await start(solutionId)).status).toBe(202);
    });

    it('never puts the key in the responses', async () => {
      const solutionId = await withSolution();
      await saveKey();
      const started = await start(solutionId);
      await t.settle();
      const status = await cast.editor.request('GET', url(`/ai-tests/${started.body.id}`));
      expect(JSON.stringify([started.body, status.body])).not.toContain(KEY);
    });
  });

  describe('who can read a job', () => {
    it('is hidden from people outside the Space and from other problems', async () => {
      const solutionId = await withSolution();
      await saveKey();
      const started = await start(solutionId);
      await t.settle();
      const path = url(`/ai-tests/${started.body.id}`);
      expect((await cast.outsider.request('GET', path)).status).toBe(404);
      expect((await cast.solver.request('GET', path)).status).toBe(403);
      expect((await cast.visitor.request('GET', path)).status).toBe(401);
      expect(
        (
          await cast.editor.request(
            'GET',
            problemUrl(cast.slug, 'other', `/ai-tests/${started.body.id}`)
          )
        ).status
      ).toBe(404);
    });
  });
});
