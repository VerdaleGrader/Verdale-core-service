import { Cast, castSpace, createPublishedProblem, submitCode } from '@/test/fixtures';
import { jobResult, createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';
import TLogger from '@/logging/logger';
import { signedHeaders } from '@/libs/hmac';

describeDb('Result callback from Judge (GRD-45)', () => {
  let t: TestApp;
  let cast: Cast;
  let submissionId: string;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    cast = await castSpace(t, { visibility: 'public' });
    await createPublishedProblem(cast);
    submissionId = (await submitCode(cast.solver, cast.slug, 'sum')).body.id;
    await t.settle();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await t.close();
  });

  const stored = () =>
    t.prisma.submission.findUniqueOrThrow({
      where: { id: submissionId },
      include: { results: true },
    });

  describe('storing a result', () => {
    it('updates the submission and every test, in the problem’s test order', async () => {
      const result = jobResult(t.judge.last, {
        verdict: 'WA',
        summary: { passed: 1, total: 2, time_ms: 40, memory_kb: 4096 },
      });
      result.tests = [result.tests[1]!, result.tests[0]!]; // Judge listed them in another order
      result.tests[0]!.verdict = 'WA';
      expect((await t.deliver(result)).status).toBe(204);
      const row = await stored();
      expect(row).toMatchObject({
        status: 'completed',
        verdict: 'WA',
        time_ms: 40,
        memory_kb: 4096,
        tests_passed: 1,
        tests_total: 2,
        judge_version: 'test-1',
        error_code: null,
        compile_message: null,
      });
      expect(row.judged_at).toEqual(new Date(result.judged_at));
      const results = [...row.results].sort((a, b) => a.position - b.position);
      expect(results.map((r) => [r.position, r.is_sample, r.verdict])).toEqual([
        [1, true, 'AC'],
        [2, false, 'WA'],
      ]);
      expect(results[0]).toMatchObject({ stdout_preview: '3\n', exit_code: 0 });
    });

    it('turns Judge’s verdicts into ours one for one', async () => {
      for (const verdict of ['AC', 'WA', 'TLE', 'MLE', 'RE', 'OLE'] as const) {
        const { body } = await submitCode(cast.editor, cast.slug, 'sum');
        await t.settle();
        const job = t.judge.last;
        const result = jobResult(job, { verdict });
        result.tests[1]!.verdict = verdict === 'AC' ? 'AC' : verdict;
        expect((await t.deliver(result)).status).toBe(204);
        expect(
          (await t.prisma.submission.findUniqueOrThrow({ where: { id: body.id } })).verdict
        ).toBe(verdict);
      }
    });

    it('keeps the compile message for a compilation error, and no timings or tests', async () => {
      const message = 'main.cpp:3:1: error: expected ;\n'.repeat(400);
      await t.deliver(
        jobResult(t.judge.last, {
          verdict: 'CE',
          compile: { ok: false, message, time_ms: 200 },
          tests: [],
          summary: { passed: 0, total: 2, time_ms: 0, memory_kb: 0 },
        })
      );
      const row = await stored();
      expect(row).toMatchObject({ verdict: 'CE', time_ms: null, memory_kb: null, tests_passed: 0 });
      expect(row.compile_message!.length).toBe(8192);
      expect(row.compile_message).toBe(message.slice(0, 8192));
      expect(row.results).toHaveLength(0);
    });

    it('marks skipped tests as skipped', async () => {
      const result = jobResult(t.judge.last, {
        verdict: 'WA',
        summary: { passed: 0, total: 2, time_ms: 5, memory_kb: 1000 },
      });
      result.tests[0]!.verdict = 'WA';
      result.tests[1] = { id: result.tests[1]!.id, verdict: 'SKIPPED', time_ms: 0, memory_kb: 0 };
      await t.deliver(result);
      const row = await stored();
      expect(row.results.find((r) => r.position === 2)).toMatchObject({
        verdict: 'SKIPPED',
        time_ms: 0,
      });
    });

    it('tells whether a test is a sample from Core’s own record, not from the result', async () => {
      const result = jobResult(t.judge.last);
      // a result that wrongly carries a preview for the hidden test
      result.tests[1] = {
        ...result.tests[1]!,
        stdout_preview: 'sneaky',
        checker_message: 'sneaky',
      };
      await t.deliver(result);
      const hidden = (await stored()).results.find((r) => r.position === 2)!;
      expect(hidden).toMatchObject({
        is_sample: false,
        stdout_preview: null,
        checker_message: null,
      });
    });

    it('ignores fields it does not know (contract changes are additive)', async () => {
      const result = { ...jobResult(t.judge.last), future_field: { anything: true } };
      expect((await t.deliver(result)).status).toBe(204);
    });
  });

  describe('signature, timestamp and key id are checked first', () => {
    const expectRefused = async (
      response: { status: number; body: { error_code: string } },
      code: string
    ) => {
      expect(response.status).toBe(401);
      expect(response.body.error_code).toBe(code);
      expect((await stored()).status).toBe('queued');
      expect((await stored()).results).toHaveLength(0);
    };

    it('refuses a request with no signature headers', async () => {
      const body = JSON.stringify(jobResult(t.judge.last));
      const response = await t.app.inject({
        method: 'POST',
        url: '/internal/judge/result',
        payload: body,
        headers: { 'content-type': 'application/json' },
      });
      await expectRefused(
        { status: response.statusCode, body: JSON.parse(response.body) },
        'MISSING_SIGNATURE'
      );
    });

    it('refuses an unknown key id', async () => {
      await expectRefused(
        await t.deliver(jobResult(t.judge.last), { keyId: 'someone-else' }),
        'UNKNOWN_KEY_ID'
      );
    });

    it('refuses a wrong secret', async () => {
      await expectRefused(
        await t.deliver(jobResult(t.judge.last), {
          secret: 'a-different-secret-that-is-long-enough-1',
        }),
        'INVALID_SIGNATURE'
      );
    });

    it('refuses a timestamp more than 5 minutes old or ahead', async () => {
      await expectRefused(
        await t.deliver(jobResult(t.judge.last), { timestampMs: Date.now() - 6 * 60_000 }),
        'STALE_TIMESTAMP'
      );
      await expectRefused(
        await t.deliver(jobResult(t.judge.last), { timestampMs: Date.now() + 6 * 60_000 }),
        'STALE_TIMESTAMP'
      );
    });

    it('accepts a timestamp inside the window', async () => {
      const response = await t.deliver(jobResult(t.judge.last), {
        timestampMs: Date.now() - 4 * 60_000,
      });
      expect(response.status).toBe(204);
    });

    it('refuses a body that was changed after it was signed', async () => {
      const signed = JSON.stringify(jobResult(t.judge.last, { verdict: 'WA' }));
      const headers = signedHeaders(
        'judge-test',
        'test-judge-to-core-secret-0123456789abcdef',
        'POST',
        '/internal/judge/result',
        signed
      );
      const tampered = signed.replace('"WA"', '"AC"');
      const response = await t.app.inject({
        method: 'POST',
        url: '/internal/judge/result',
        payload: tampered,
        headers: { ...headers, 'content-type': 'application/json' },
      });
      await expectRefused(
        { status: response.statusCode, body: JSON.parse(response.body) },
        'INVALID_SIGNATURE'
      );
    });

    it('refuses a signature made for another path', async () => {
      const body = JSON.stringify(jobResult(t.judge.last));
      const headers = signedHeaders(
        'judge-test',
        'test-judge-to-core-secret-0123456789abcdef',
        'POST',
        '/internal/jobs',
        body
      );
      const response = await t.app.inject({
        method: 'POST',
        url: '/internal/judge/result',
        payload: body,
        headers: { ...headers, 'content-type': 'application/json' },
      });
      await expectRefused(
        { status: response.statusCode, body: JSON.parse(response.body) },
        'INVALID_SIGNATURE'
      );
    });

    it('checks the signature before it parses anything, so garbage is 401 not 400', async () => {
      await expectRefused(
        await t.deliver(null, { rawBody: '{not json', keyId: 'nobody' }),
        'UNKNOWN_KEY_ID'
      );
    });

    it('does not use the browser session or CSRF rules (no cookie, no Origin needed)', async () => {
      expect((await t.deliver(jobResult(t.judge.last))).status).toBe(204);
    });
  });

  describe('the same result twice (idempotent by job id)', () => {
    it('is acknowledged both times and written once', async () => {
      const result = jobResult(t.judge.last);
      expect((await t.deliver(result)).status).toBe(204);
      const first = await stored();
      expect((await t.deliver(result)).status).toBe(204);
      expect((await t.deliver(result)).status).toBe(204);
      const after = await stored();
      expect(after.results).toHaveLength(2);
      expect(await t.prisma.submissionTestResult.count()).toBe(2);
      expect(after.judged_at).toEqual(first.judged_at);
      expect(after.updated_at).toEqual(first.updated_at);
    });

    it('two deliveries at the same moment: one is stored, the other is a duplicate, both succeed', async () => {
      const result = jobResult(t.judge.last);
      const responses = await Promise.all([
        t.deliver(result),
        t.deliver(result),
        t.deliver(result),
      ]);
      expect(responses.map((response) => response.status)).toEqual([204, 204, 204]);
      expect(await t.prisma.submissionTestResult.count()).toBe(2);
    });

    it('a different verdict for a job that already has a result is refused and never overwrites it', async () => {
      await t.deliver(jobResult(t.judge.last, { verdict: 'AC' }));
      const warn = jest.spyOn(TLogger.prototype, 'warn');
      const conflicting = await t.deliver(jobResult(t.judge.last, { verdict: 'WA' }));
      expect(conflicting.status).toBe(409);
      expect((await stored()).verdict).toBe('AC');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/different result/) })
      );
    });

    it('results for the same job arriving in the other order: the first one stored wins', async () => {
      const ise = jobResult(t.judge.last, {
        verdict: 'ISE',
        tests: [],
        summary: { passed: 0, total: 2, time_ms: 0, memory_kb: 0 },
        error: { code: 'SANDBOX_FAILURE', message: 'x' },
      });
      await t.deliver(ise);
      expect((await t.deliver(jobResult(t.judge.last, { verdict: 'AC' }))).status).toBe(409);
      expect((await stored()).verdict).toBe('ISE');
    });
  });

  describe('results Core cannot place', () => {
    it('refuses and logs a job it does not know', async () => {
      const warn = jest.spyOn(TLogger.prototype, 'warn');
      const stranger = {
        ...jobResult(t.judge.last),
        job_id: '11111111-1111-4111-8111-111111111111',
      };
      const response = await t.deliver(stranger);
      expect(response.status).toBe(404);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Judge sent a result for an unknown job' })
      );
      expect((await stored()).status).toBe('queued');
    });

    it('refuses a result that is not a submission job', async () => {
      const response = await t.deliver(jobResult(t.judge.last, { kind: 'verify' }));
      expect(response.status).toBe(422);
      expect((await stored()).status).toBe('queued');
    });

    it('refuses a test that is not part of the problem version', async () => {
      const result = jobResult(t.judge.last);
      result.tests[0] = { ...result.tests[0]!, id: 'not-a-test-of-this-problem' };
      const response = await t.deliver(result);
      expect(response.status).toBe(422);
      expect(response.body.message).toMatch(/not part of this problem version/);
      const row = await stored();
      expect(row.status).toBe('queued');
      expect(row.results).toHaveLength(0);
    });

    it('refuses the same test twice', async () => {
      const result = jobResult(t.judge.last);
      result.tests[1] = { ...result.tests[0]! };
      expect((await t.deliver(result)).status).toBe(422);
    });

    it('refuses a verdict it does not know yet (deploy Core before Judge)', async () => {
      expect((await t.deliver({ ...jobResult(t.judge.last), verdict: 'XYZ' })).status).toBe(422);
    });

    it.each([
      ['a body that is not JSON', '{oops'],
      ['an empty body', ''],
    ])('answers 400 to %s (once the signature is right)', async (_name, rawBody) => {
      const response = await t.deliver(null, { rawBody });
      expect(response.status).toBe(400);
    });

    it('answers 422 to JSON that does not match the contract', async () => {
      expect((await t.deliver({ hello: 'world' })).status).toBe(422);
      expect((await t.deliver({ ...jobResult(t.judge.last), judged_at: 'yesterday' })).status).toBe(
        422
      );
      expect((await t.deliver({ ...jobResult(t.judge.last), job_id: 'nope' })).status).toBe(422);
    });
  });

  describe('system errors (ISE)', () => {
    it('are stored as a system error, not counted as the submitter’s fault, and can be sent for another check', async () => {
      await t.deliver(
        jobResult(t.judge.last, {
          verdict: 'ISE',
          tests: [],
          summary: { passed: 0, total: 2, time_ms: 0, memory_kb: 0 },
          error: { code: 'TEST_FILE_UNAVAILABLE', message: 'object missing' },
        })
      );
      const row = await stored();
      expect(row).toMatchObject({
        verdict: 'ISE',
        status: 'completed',
        error_code: 'TEST_FILE_UNAVAILABLE',
        time_ms: null,
      });
      const detail = (await cast.solver.request('GET', `/api/v1/submissions/${submissionId}`)).body;
      expect(detail.can_rejudge).toBe(true);
      expect(
        (await cast.solver.request('POST', `/api/v1/submissions/${submissionId}/rejudge`)).status
      ).toBe(202);
    });

    it('never stores Judge’s free-text message (it may name internal paths)', async () => {
      await t.deliver(
        jobResult(t.judge.last, {
          verdict: 'ISE',
          tests: [],
          summary: { passed: 0, total: 2, time_ms: 0, memory_kb: 0 },
          error: {
            code: 'SANDBOX_FAILURE',
            message: '/var/lib/verdale-judge/secret-path exploded',
          },
        })
      );
      const text = JSON.stringify(await stored());
      expect(text).not.toContain('secret-path');
    });
  });
});
