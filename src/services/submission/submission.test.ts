import {
  Cast,
  castSpace,
  createDraft,
  createPublishedProblem,
  problemUrl,
  submitCode,
} from '@/test/fixtures';
import { jobResult, createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

describeDb('Submissions (GRD-43, 44, 46)', () => {
  let t: TestApp;
  let cast: Cast;
  let problem: Awaited<ReturnType<typeof createPublishedProblem>>;

  async function setup(tuning: Parameters<typeof createTestApp>[1] = {}) {
    t = await createTestApp({}, tuning);
    await resetDatabase(t.prisma);
    cast = await castSpace(t, { visibility: 'public' });
    problem = await createPublishedProblem(cast);
  }
  beforeEach(async () => setup());
  afterEach(async () => t.close());

  const submissionsUrl = (suffix = '') => problemUrl(cast.slug, 'sum', `/submissions${suffix}`);

  describe('data model (GRD-43)', () => {
    it('keeps who sent what, in which language, against which version, with status queued', async () => {
      const response = await submitCode(cast.solver, cast.slug, 'sum', {
        language: 'python',
        source: 'print(3)\n',
      });
      expect(response.status).toBe(202);
      const row = await t.prisma.submission.findFirstOrThrow({
        include: { user: true, version: true },
      });
      expect(row).toMatchObject({
        id: response.body.id,
        language: 'python',
        source: 'print(3)\n',
        source_bytes: 9,
        status: 'queued',
        verdict: null,
        tests_total: 2,
      });
      expect(row.user.username).toBe('sol');
      expect(row.problem_version_id).toBe(row.version.id);
      expect(row.version.status).toBe('published');
      expect(row.created_at).toBeInstanceOf(Date);
    });

    it('has the indexes for "by user and problem" and "by time" (and the job id is unique)', async () => {
      const indexes = await t.prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'submissions'`;
      const defs = indexes.map((index) => index.indexdef).join('\n');
      expect(defs).toMatch(/\(user_id, problem_id, created_at DESC\)/);
      expect(defs).toMatch(/\(problem_id, created_at DESC\)/);
      expect(defs).toMatch(/UNIQUE INDEX submissions_judge_job_id_key/);
    });

    it('the database refuses a verdict on an unfinished submission and a finished one without a verdict', async () => {
      const { body } = await submitCode(cast.solver, cast.slug, 'sum');
      await expect(
        t.prisma.submission.update({ where: { id: body.id }, data: { verdict: 'AC' } })
      ).rejects.toThrow();
      await expect(
        t.prisma.submission.update({ where: { id: body.id }, data: { status: 'completed' } })
      ).rejects.toThrow();
    });

    it('stores a source of at most 64 KiB (bytes) and the database enforces it too', async () => {
      const { body } = await submitCode(cast.solver, cast.slug, 'sum');
      await expect(
        t.prisma.submission.update({ where: { id: body.id }, data: { source_bytes: 70_000 } })
      ).rejects.toThrow();
    });

    it('a submission points at the exact version, which a published problem never changes', async () => {
      const first = await submitCode(cast.solver, cast.slug, 'sum');
      const row = await t.prisma.submission.findUniqueOrThrow({ where: { id: first.body.id } });
      const current = await t.prisma.problem.findFirstOrThrow();
      expect(row.problem_version_id).toBe(current.current_version_id);
      // The version a result refers to cannot be edited afterwards.
      await expect(
        t.prisma.problemVersion.update({
          where: { id: row.problem_version_id },
          data: { time_limit_ms: 2000 },
        })
      ).rejects.toThrow(/cannot be changed/);
    });
  });

  describe('submitting (GRD-44)', () => {
    it('answers 202 at once with the id and status queued', async () => {
      const response = await submitCode(cast.solver, cast.slug, 'sum');
      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({
        status: 'queued',
        verdict: null,
        language: 'cpp',
        problem: { slug: 'sum', title: 'Sum of two numbers' },
        space: { slug: 'team' },
        author: { username: 'sol' },
        tests_total: 2,
        tests_passed: null,
        judged_at: null,
      });
      expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.body).not.toHaveProperty('source');
    });

    it('hands Judge a job with the problem version limits, the tests in order and a callback URL', async () => {
      const response = await submitCode(cast.solver, cast.slug, 'sum', {
        language: 'python',
        source: 'print(1)',
      });
      await t.settle();
      expect(t.judge.jobs).toHaveLength(1);
      const job = t.judge.last;
      expect(job).toMatchObject({
        kind: 'submission',
        language: 'python',
        source: 'print(1)',
        checker: 'line',
        limits: { time_ms: 1000, memory_kb: 262144, output_kb: 65536 },
        callback_url: 'http://core.test/internal/judge/result',
      });
      expect(job.tests).toEqual([
        {
          id: problem.sample.id,
          input: { sha256: problem.sample.input_sha256, size_bytes: 4 },
          output: { sha256: problem.sample.output_sha256, size_bytes: 2 },
          sample: true,
        },
        {
          id: problem.hidden.id,
          input: {
            sha256: problem.hidden.input_sha256,
            size_bytes: problem.hidden.input_size_bytes,
          },
          output: {
            sha256: problem.hidden.output_sha256,
            size_bytes: problem.hidden.output_size_bytes,
          },
          sample: false,
        },
      ]);
      const row = await t.prisma.submission.findUniqueOrThrow({ where: { id: response.body.id } });
      expect(row.judge_job_id).toBe(job.job_id);
      expect(row.dispatched_at).not.toBeNull();
      expect(row.next_dispatch_at).toBeNull();
      expect(row.status).toBe('queued');
    });

    it('uses the limits of the problem, not defaults', async () => {
      await createPublishedProblem(cast, 'tight', { time_limit_ms: 250, memory_limit_kb: 32768 });
      await submitCode(cast.solver, cast.slug, 'tight');
      await t.settle();
      expect(t.judge.last.limits).toMatchObject({ time_ms: 250, memory_kb: 32768 });
    });

    it('sends the job once even if the dispatcher is asked twice', async () => {
      const { body } = await submitCode(cast.solver, cast.slug, 'sum');
      await t.settle();
      await t.app.dispatcher!.dispatch(body.id);
      await t.app.dispatcher!.dispatchDue();
      expect(t.judge.jobs).toHaveLength(1);
    });

    describe('who can submit', () => {
      it('any logged-in user in a public Space; never a visitor', async () => {
        for (const client of [cast.owner, cast.editor, cast.solver, cast.outsider]) {
          expect((await submitCode(client, cast.slug, 'sum')).status).toBe(202);
        }
        expect((await submitCode(cast.visitor, cast.slug, 'sum')).status).toBe(401);
        expect(await t.prisma.submission.count()).toBe(4);
      });

      it('only members in a private Space; others get 404', async () => {
        const secret = await castSpace(t, { visibility: 'private', slug: 'secret' });
        await createPublishedProblem(secret, 'sum');
        expect((await submitCode(secret.solver, 'secret', 'sum')).status).toBe(202);
        expect((await submitCode(secret.outsider, 'secret', 'sum')).status).toBe(404);
        expect((await submitCode(secret.visitor, 'secret', 'sum')).status).toBe(401);
      });

      it('nobody in an archived Space', async () => {
        await cast.owner.request('POST', `/api/v1/spaces/${cast.slug}/archive`);
        expect((await submitCode(cast.solver, cast.slug, 'sum')).status).toBe(403);
        expect(await t.prisma.submission.count()).toBe(0);
      });
    });

    describe('only a published problem', () => {
      it('a draft is 404 for solvers (they must not learn it exists) and 409 for its authors', async () => {
        await createDraft(cast.editor, cast.slug, 'wip');
        expect((await submitCode(cast.solver, cast.slug, 'wip')).status).toBe(404);
        const author = await submitCode(cast.editor, cast.slug, 'wip');
        expect(author.status).toBe(409);
        expect(author.body.error_code).toBe('PROBLEM_NOT_PUBLISHED');
        expect((await submitCode(cast.solver, cast.slug, 'missing')).status).toBe(404);
        expect(await t.prisma.submission.count()).toBe(0);
      });

      it('an archived problem is closed', async () => {
        await cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/archive'));
        const response = await submitCode(cast.solver, cast.slug, 'sum');
        expect(response.status).toBe(409);
        expect(response.body.error_code).toBe('PROBLEM_NOT_OPEN');
      });
    });

    describe('the code', () => {
      it('must be in a language the problem allows', async () => {
        await createPublishedProblem(cast, 'py-only', { allowed_languages: ['python'] });
        const refused = await submitCode(cast.solver, cast.slug, 'py-only', { language: 'cpp' });
        expect(refused.status).toBe(400);
        expect(refused.body.details).toEqual([
          { field: 'language', message: 'This problem accepts: python.' },
        ]);
        expect(
          (
            await submitCode(cast.solver, cast.slug, 'py-only', {
              language: 'python',
              source: 'print(3)',
            })
          ).status
        ).toBe(202);
      });

      it.each([
        [{ language: 'rust' }, 'language'],
        [{ language: 'cpp', source: '' }, 'source'],
        [{ language: 'cpp', source: 'a\u0000b' }, 'source'],
        [{ language: 'cpp', source: 'a'.repeat(65_537) }, 'source'],
        [{ language: 'cpp', source: 'ก'.repeat(21_846) }, 'source'], // 65 538 bytes
      ])('rejects %j', async (body, field) => {
        const response = await submitCode(cast.solver, cast.slug, 'sum', body as never);
        expect(response.status).toBe(400);
        expect(response.body.details.map((detail: { field: string }) => detail.field)).toContain(
          field
        );
        expect(await t.prisma.submission.count()).toBe(0);
        expect(t.judge.jobs).toHaveLength(0);
      });

      it('accepts exactly 64 KiB', async () => {
        const response = await submitCode(cast.solver, cast.slug, 'sum', {
          source: 'a'.repeat(65_536),
        });
        expect(response.status).toBe(202);
      });
    });

    describe('when Judge is not available (nothing is lost)', () => {
      beforeEach(() => {
        t.judge.mode = 'down';
      });

      it('still answers 202 and keeps the submission queued, due to be handed over again', async () => {
        const response = await submitCode(cast.solver, cast.slug, 'sum');
        expect(response.status).toBe(202);
        await t.settle();
        const row = await t.prisma.submission.findUniqueOrThrow({
          where: { id: response.body.id },
        });
        expect(row).toMatchObject({ status: 'queued', dispatched_at: null, dispatch_attempts: 1 });
        expect(row.next_dispatch_at!.getTime()).toBeGreaterThan(Date.now());
        const detail = await cast.solver.request('GET', `/api/v1/submissions/${response.body.id}`);
        expect(detail.body).toMatchObject({ status: 'queued', verdict: null, can_rejudge: false });
      });

      it('hands it over once Judge is back, without the user doing anything', async () => {
        const { body } = await submitCode(cast.solver, cast.slug, 'sum');
        await t.settle();
        t.judge.mode = 'up';
        await t.prisma
          .$executeRaw`UPDATE submissions SET next_dispatch_at = now() - interval '1 second'`;
        expect(await t.app.dispatcher!.dispatchDue()).toBe(1);
        expect(t.judge.jobs).toHaveLength(1);
        const row = await t.prisma.submission.findUniqueOrThrow({ where: { id: body.id } });
        expect(row.dispatched_at).not.toBeNull();
        expect(row.judge_job_id).toBe(t.judge.last.job_id);
      });

      it('ticks never overlap, and stop() waits for the one that is running', async () => {
        const dispatcher = t.app.dispatcher!;
        const real = dispatcher.dispatchDue.bind(dispatcher);
        let running = 0;
        let overlapped = false;
        let finished = 0;
        jest.spyOn(dispatcher, 'dispatchDue').mockImplementation(async (limit) => {
          running += 1;
          if (running > 1) overlapped = true;
          await new Promise((resolve) => setTimeout(resolve, 120));
          try {
            return await real(limit);
          } finally {
            running -= 1;
            finished += 1;
          }
        });
        dispatcher.start(10);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await dispatcher.stop();
        // Nothing is still running once stop() has returned, and no tick ran beside another.
        expect(running).toBe(0);
        expect(overlapped).toBe(false);
        expect(finished).toBeGreaterThanOrEqual(1);
        jest.restoreAllMocks();
      });

      it('backs off between tries: a submission that is not yet due is left alone', async () => {
        await submitCode(cast.solver, cast.slug, 'sum');
        await t.settle();
        t.judge.mode = 'up';
        expect(await t.app.dispatcher!.dispatchDue()).toBe(0);
        expect(t.judge.jobs).toHaveLength(0);
      });

      it('the background loop does the retrying', async () => {
        const { body } = await submitCode(cast.solver, cast.slug, 'sum');
        await t.settle();
        t.judge.mode = 'up';
        await t.prisma
          .$executeRaw`UPDATE submissions SET next_dispatch_at = now() - interval '1 second'`;
        t.app.dispatcher!.start(20);
        try {
          for (let i = 0; i < 300 && t.judge.jobs.length === 0; i++)
            await new Promise((r) => setTimeout(r, 20));
        } finally {
          await t.app.dispatcher!.stop();
        }
        expect(t.judge.jobs).toHaveLength(1);
        expect(
          (await t.prisma.submission.findUniqueOrThrow({ where: { id: body.id } })).dispatched_at
        ).not.toBeNull();
      });

      it('keeps the same job id across tries, so a late callback still finds its submission', async () => {
        const { body } = await submitCode(cast.solver, cast.slug, 'sum');
        await t.settle();
        const first = (await t.prisma.submission.findUniqueOrThrow({ where: { id: body.id } }))
          .judge_job_id;
        t.judge.mode = 'up';
        await t.prisma
          .$executeRaw`UPDATE submissions SET next_dispatch_at = now() - interval '1 second'`;
        await t.app.dispatcher!.dispatchDue();
        expect(t.judge.last.job_id).toBe(first);
      });
    });

    describe('when Judge stays away', () => {
      beforeEach(async () => {
        await t.close();
        await setup({ dispatchGiveUpMs: 0 });
        t.judge.mode = 'down';
      });

      it('ends as a system error (ISE), which is not the submitter’s fault and can be checked again', async () => {
        const { body } = await submitCode(cast.solver, cast.slug, 'sum');
        await t.settle();
        const detail = (await cast.solver.request('GET', `/api/v1/submissions/${body.id}`)).body;
        expect(detail).toMatchObject({
          status: 'completed',
          verdict: 'ISE',
          error_code: 'JUDGE_UNAVAILABLE',
          can_rejudge: true,
        });
      });
    });

    describe('when Judge refuses the job for good', () => {
      it('ends as ISE with JUDGE_REJECTED instead of retrying forever', async () => {
        t.judge.mode = 'reject';
        const { body } = await submitCode(cast.solver, cast.slug, 'sum');
        await t.settle();
        const row = await t.prisma.submission.findUniqueOrThrow({ where: { id: body.id } });
        expect(row).toMatchObject({
          status: 'completed',
          verdict: 'ISE',
          error_code: 'JUDGE_REJECTED',
        });
        expect(await t.app.dispatcher!.dispatchDue()).toBe(0);
      });
    });

    describe('rate limit', () => {
      it('allows 10 submissions a minute per user, then answers 429', async () => {
        for (let n = 0; n < 10; n++)
          expect((await submitCode(cast.solver, cast.slug, 'sum')).status).toBe(202);
        const limited = await submitCode(cast.solver, cast.slug, 'sum');
        expect(limited.status).toBe(429);
        expect(limited.body.error_code).toBe('RATE_LIMITED');
        expect(await t.prisma.submission.count()).toBe(10);
        // someone else is not affected
        expect((await submitCode(cast.editor, cast.slug, 'sum')).status).toBe(202);
      });

      it('counts per user, not per address: two sessions of one user share the budget', async () => {
        const again = await t.login({
          providerAccountId: 'sol',
          email: 'sol@example.com',
          usernameHint: 'sol',
        });
        for (let n = 0; n < 5; n++) await submitCode(cast.solver, cast.slug, 'sum');
        for (let n = 0; n < 5; n++) await submitCode(again, cast.slug, 'sum');
        expect((await submitCode(cast.solver, cast.slug, 'sum')).status).toBe(429);
      });
    });
  });

  describe('status and visibility (GRD-46)', () => {
    it('shows the author the code, the status and per-test results once judged', async () => {
      const { body } = await submitCode(cast.solver, cast.slug, 'sum');
      await t.settle();
      await t.deliver(jobResult(t.judge.last));
      const detail = (await cast.solver.request('GET', `/api/v1/submissions/${body.id}`)).body;
      expect(detail).toMatchObject({
        id: body.id,
        status: 'completed',
        verdict: 'AC',
        time_ms: 12,
        memory_kb: 2048,
        tests_passed: 2,
        tests_total: 2,
        source: expect.stringContaining('std::cin'),
        compile_message: null,
        error_code: null,
        can_rejudge: false,
        results: [
          {
            position: 1,
            is_sample: true,
            verdict: 'AC',
            time_ms: 12,
            memory_kb: 2048,
            stdout_preview: '3\n',
            checker_message: '',
          },
          { position: 2, is_sample: false, verdict: 'AC', time_ms: 12, memory_kb: 2048 },
        ],
      });
      expect(detail.results[1]).not.toHaveProperty('stdout_preview');
      expect(detail.results[1]).not.toHaveProperty('checker_message');
    });

    it('the author, and the Space’s owners and editors, can read it; everyone else gets 404', async () => {
      const { body } = await submitCode(cast.solver, cast.slug, 'sum');
      const url = `/api/v1/submissions/${body.id}`;
      expect((await cast.solver.request('GET', url)).status).toBe(200);
      expect((await cast.editor.request('GET', url)).status).toBe(200);
      expect((await cast.owner.request('GET', url)).status).toBe(200);
      expect((await cast.outsider.request('GET', url)).status).toBe(404); // another logged-in user
      expect((await cast.visitor.request('GET', url)).status).toBe(401);
      expect(
        (
          await cast.solver.request(
            'GET',
            '/api/v1/submissions/00000000-0000-4000-8000-000000000000'
          )
        ).status
      ).toBe(404);
      expect((await cast.solver.request('GET', '/api/v1/submissions/not-a-uuid')).status).toBe(400);
    });

    it('a member cannot read another user’s submission in the same Space', async () => {
      const { body } = await submitCode(cast.outsider, cast.slug, 'sum'); // otto, in a public Space
      expect((await cast.solver.request('GET', `/api/v1/submissions/${body.id}`)).status).toBe(404);
      expect((await cast.outsider.request('GET', `/api/v1/submissions/${body.id}`)).status).toBe(
        200
      );
    });

    it('a member removed from a private Space loses access to their own old submissions', async () => {
      const secret = await castSpace(t, { visibility: 'private', slug: 'vault' });
      await createPublishedProblem(secret, 'sum');
      const { body } = await submitCode(secret.solver, 'vault', 'sum');
      expect((await secret.solver.request('GET', `/api/v1/submissions/${body.id}`)).status).toBe(
        200
      );
      await secret.owner.request('DELETE', '/api/v1/spaces/vault/members/sol');
      expect((await secret.solver.request('GET', `/api/v1/submissions/${body.id}`)).status).toBe(
        404
      );
    });

    it('lists my submissions of a problem, newest first, with pages', async () => {
      const ids: string[] = [];
      for (let n = 0; n < 3; n++)
        ids.push((await submitCode(cast.solver, cast.slug, 'sum')).body.id);
      await submitCode(cast.outsider, cast.slug, 'sum');
      const page = await cast.solver.request('GET', submissionsUrl());
      expect(page.status).toBe(200);
      expect(page.body.items.map((item: { id: string }) => item.id)).toEqual([...ids].reverse());
      expect(page.body).toMatchObject({ page: 1, page_size: 20, total: 3 });
      const second = await cast.solver.request('GET', submissionsUrl('?page=2&page_size=2'));
      expect(second.body.items.map((item: { id: string }) => item.id)).toEqual([ids[0]]);
      expect(page.body.items[0]).not.toHaveProperty('source');
      expect((await cast.solver.request('GET', submissionsUrl('?page_size=51'))).status).toBe(400);
    });

    describe('previous submissions: test runs and the best one (GRD-113)', () => {
      /** Sends a submission and marks it finished with the numbers given, without going through Judge. */
      async function finished(
        client: Cast['solver'],
        outcome: { passed: number; verdict?: 'AC' | 'WA' | 'ISE'; status?: 'completed' | 'running' }
      ) {
        const { body } = await submitCode(client, cast.slug, 'sum');
        await t.prisma.submission.update({
          where: { id: body.id },
          data: {
            status: outcome.status ?? 'completed',
            verdict:
              (outcome.status ?? 'completed') === 'completed' ? (outcome.verdict ?? 'WA') : null,
            tests_passed: outcome.passed,
          },
        });
        return body.id as string;
      }

      it('gives every item its tests as runs, and nothing for one that is not judged', async () => {
        const waiting = (await submitCode(cast.solver, cast.slug, 'sum')).body;
        expect(waiting.test_runs).toEqual([]);
        await t.settle();
        await t.deliver(
          jobResult(t.judge.last, {
            verdict: 'WA',
            tests: jobResult(t.judge.last).tests.map((test, index) => ({
              ...test,
              verdict: index === 0 ? ('AC' as const) : ('WA' as const),
            })),
            summary: { passed: 1, total: 2, time_ms: 12, memory_kb: 2048 },
          })
        );
        const page = (await cast.solver.request('GET', submissionsUrl())).body;
        expect(page.items[0].test_runs).toEqual([
          { verdict: 'AC', count: 1 },
          { verdict: 'WA', count: 1 },
        ]);
        const detail = (await cast.solver.request('GET', `/api/v1/submissions/${waiting.id}`)).body;
        expect(detail.test_runs).toEqual(page.items[0].test_runs);
        // Runs hold verdicts only: no time, no preview, no test content.
        expect(JSON.stringify(page.items[0].test_runs)).not.toMatch(/stdout|input|expected/);
      });

      it('picks the most tests passed, then the earliest, and shows it apart from the list', async () => {
        const first = await finished(cast.solver, { passed: 1 });
        const second = await finished(cast.solver, { passed: 2, verdict: 'AC' });
        const third = await finished(cast.solver, { passed: 2, verdict: 'AC' });
        const page = (await cast.solver.request('GET', submissionsUrl())).body;
        expect(page.best.id).toBe(second);
        expect(page.best.id).not.toBe(third);
        expect(page.items.map((item: { id: string }) => item.id)).toEqual([third, second, first]);
        // The best stays the same on every page, even when it is not on that page.
        const lastPage = (await cast.solver.request('GET', submissionsUrl('?page=3&page_size=1')))
          .body;
        expect(lastPage.items[0].id).toBe(first);
        expect(lastPage.best.id).toBe(second);
      });

      it('never counts a submission that is unfinished, ended in ISE or passed nothing', async () => {
        await finished(cast.solver, { passed: 2, status: 'running' });
        await finished(cast.solver, { passed: 2, verdict: 'ISE' });
        await finished(cast.solver, { passed: 0 });
        expect((await cast.solver.request('GET', submissionsUrl())).body.best).toBeNull();
        const kept = await finished(cast.solver, { passed: 1 });
        expect((await cast.solver.request('GET', submissionsUrl())).body.best.id).toBe(kept);
      });

      it('is about the caller only: other people’s work is not their best, and scope=all has none', async () => {
        await finished(cast.outsider, { passed: 2, verdict: 'AC' });
        expect((await cast.solver.request('GET', submissionsUrl())).body.best).toBeNull();
        const own = await finished(cast.solver, { passed: 1 });
        expect((await cast.solver.request('GET', submissionsUrl())).body.best.id).toBe(own);
        const all = (await cast.editor.request('GET', submissionsUrl('?scope=all'))).body;
        expect(all.best).toBeNull();
      });

      it('numbers each submission among its author’s own, whatever page or reader', async () => {
        const first = await finished(cast.solver, { passed: 1 });
        const other = await finished(cast.outsider, { passed: 1 });
        const second = await finished(cast.solver, { passed: 2, verdict: 'AC' });
        const third = await finished(cast.solver, { passed: 0 });
        const page = (await cast.solver.request('GET', submissionsUrl())).body;
        expect(page.items.map((item: { number: number }) => item.number)).toEqual([3, 2, 1]);
        expect(page.best).toMatchObject({ id: second, number: 2 });
        // A later page and the detail agree; so does the Space's staff reading everyone's.
        const secondPage = (await cast.solver.request('GET', submissionsUrl('?page=2&page_size=2')))
          .body;
        expect(secondPage.items[0]).toMatchObject({ id: first, number: 1 });
        expect((await cast.solver.request('GET', `/api/v1/submissions/${third}`)).body.number).toBe(
          3
        );
        const all = (await cast.editor.request('GET', submissionsUrl('?scope=all'))).body;
        expect(all.items.find((item: { id: string }) => item.id === other).number).toBe(1);
        const created = await submitCode(cast.solver, cast.slug, 'sum');
        expect(created.body.number).toBe(4);
      });

      it('has the index the best query reads', async () => {
        const indexes = await t.prisma.$queryRaw<Array<{ indexdef: string }>>`
          SELECT indexdef FROM pg_indexes WHERE tablename = 'submissions'`;
        expect(indexes.map((index) => index.indexdef).join('\n')).toMatch(
          /\(user_id, problem_id, status, tests_passed DESC, created_at\)/
        );
      });
    });

    it('owners and editors can list everyone’s; solvers cannot ask for it', async () => {
      await submitCode(cast.solver, cast.slug, 'sum');
      await submitCode(cast.outsider, cast.slug, 'sum');
      const all = await cast.editor.request('GET', submissionsUrl('?scope=all'));
      expect(all.status).toBe(200);
      expect(all.body.total).toBe(2);
      expect(
        all.body.items.map((item: { author: { username: string } }) => item.author.username).sort()
      ).toEqual(['otto', 'sol']);
      expect((await cast.editor.request('GET', submissionsUrl())).body.total).toBe(0); // mine = none
      const forbidden = await cast.solver.request('GET', submissionsUrl('?scope=all'));
      expect(forbidden.status).toBe(403);
      expect((await cast.visitor.request('GET', submissionsUrl())).status).toBe(401);
    });

    it('lists nothing for a problem in a private Space that the caller cannot see', async () => {
      const secret = await castSpace(t, { visibility: 'private', slug: 'vault' });
      await createPublishedProblem(secret, 'sum');
      expect(
        (await secret.outsider.request('GET', problemUrl('vault', 'sum', '/submissions'))).status
      ).toBe(404);
    });

    it('never exposes the content of a hidden test, even if Judge sends it', async () => {
      const { body } = await submitCode(cast.solver, cast.slug, 'sum');
      await t.settle();
      const result = jobResult(t.judge.last, { verdict: 'WA' });
      result.tests[1] = {
        ...result.tests[1]!,
        verdict: 'WA',
        stdout_preview: 'HIDDEN-OUTPUT-LEAK',
        checker_message: 'HIDDEN-EXPECTED-LEAK',
      };
      result.summary.passed = 1;
      expect((await t.deliver(result)).status).toBe(204);
      for (const client of [cast.solver, cast.editor]) {
        const detail = await client.request('GET', `/api/v1/submissions/${body.id}`);
        const text = JSON.stringify(detail.body);
        expect(text).not.toContain('HIDDEN-OUTPUT-LEAK');
        expect(text).not.toContain('HIDDEN-EXPECTED-LEAK');
        expect(detail.body.results[1]).toEqual({
          position: 2,
          is_sample: false,
          verdict: 'WA',
          time_ms: 12,
          memory_kb: 2048,
        });
      }
      const stored = await t.prisma.submissionTestResult.findMany();
      expect(JSON.stringify(stored)).not.toContain('LEAK');
    });

    it('answers every endpoint with no hidden test content, for any caller', async () => {
      const { body } = await submitCode(cast.solver, cast.slug, 'sum');
      await t.settle();
      await t.deliver(jobResult(t.judge.last));
      const responses = [
        await cast.solver.request('GET', `/api/v1/submissions/${body.id}`),
        await cast.solver.request('GET', submissionsUrl()),
        await cast.solver.text('GET', `/api/v1/submissions/${body.id}/events`),
        await cast.editor.request('GET', `/api/v1/submissions/${body.id}`),
      ];
      for (const response of responses) {
        const text = 'text' in response ? response.text : JSON.stringify(response.body);
        expect(text).not.toContain('987654321');
        expect(text).not.toContain('1111111110');
        expect(text).not.toContain(problem.hidden.input_sha256);
        expect(text).not.toContain(problem.hidden.output_sha256);
      }
    });
  });

  describe('live updates (Server-Sent Events)', () => {
    const parse = (text: string) =>
      text
        .split('\n\n')
        .filter((block) => block.startsWith('event: submission'))
        .map((block) => JSON.parse(block.split('\ndata: ')[1]!));

    it('starts with the current state and ends after the final one', async () => {
      const { body } = await submitCode(cast.solver, cast.slug, 'sum');
      await t.settle();
      const stream = cast.solver.text('GET', `/api/v1/submissions/${body.id}/events`);
      await new Promise((resolve) => setTimeout(resolve, 60));
      await t.deliver(jobResult(t.judge.last));
      const response = await stream;
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/event-stream/);
      expect(response.headers['cache-control']).toBe('no-cache, no-transform');
      expect(response.text.startsWith('retry: 3000\n\n')).toBe(true);
      const events = parse(response.text);
      expect(events[0]).toMatchObject({ id: body.id, status: 'queued', verdict: null });
      expect(events[events.length - 1]).toMatchObject({
        id: body.id,
        status: 'completed',
        verdict: 'AC',
      });
      expect(events.every((event) => !('source' in event))).toBe(true);
    });

    it('reports "running" when Judge says the job has started', async () => {
      const { body } = await submitCode(cast.solver, cast.slug, 'sum');
      await t.settle();
      t.judge.running.add(t.judge.last.job_id);
      const stream = cast.solver.text('GET', `/api/v1/submissions/${body.id}/events`);
      // Wait until the stream has noticed the job running, then let it finish.
      for (let i = 0; i < 300; i++) {
        const row = await t.prisma.submission.findUniqueOrThrow({ where: { id: body.id } });
        if (row.status === 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await t.deliver(jobResult(t.judge.last));
      const events = parse((await stream).text);
      // A repeated "running" (another field changed) is not a different state.
      const states = events
        .map((event) => event.status)
        .filter((status, index, all) => status !== all[index - 1]);
      expect(states).toEqual(['queued', 'running', 'completed']);
    });

    it('a connection to a finished submission gets that one event and closes (a reconnect loses nothing)', async () => {
      const { body } = await submitCode(cast.solver, cast.slug, 'sum');
      await t.settle();
      await t.deliver(jobResult(t.judge.last, { verdict: 'WA' }));
      const response = await cast.solver.text('GET', `/api/v1/submissions/${body.id}/events`);
      const events = parse(response.text);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: 'completed', verdict: 'WA' });
    });

    it('is refused as an ordinary error before the stream starts', async () => {
      const { body } = await submitCode(cast.solver, cast.slug, 'sum');
      const outsider = await cast.outsider.text('GET', `/api/v1/submissions/${body.id}/events`);
      expect(outsider.status).toBe(404);
      expect(outsider.headers['content-type']).toMatch(/json/);
      const visitor = await cast.visitor.text('GET', `/api/v1/submissions/${body.id}/events`);
      expect(visitor.status).toBe(401);
      expect(
        (
          await cast.solver.text(
            'GET',
            '/api/v1/submissions/00000000-0000-4000-8000-000000000000/events'
          )
        ).status
      ).toBe(404);
    });
  });

  describe('checking again after a system error (GRD-45)', () => {
    async function iseSubmission() {
      const { body } = await submitCode(cast.solver, cast.slug, 'sum');
      await t.settle();
      const oldJob = t.judge.last;
      await t.deliver(
        jobResult(oldJob, {
          verdict: 'ISE',
          tests: [],
          summary: { passed: 0, total: 2, time_ms: 0, memory_kb: 0 },
          error: { code: 'SANDBOX_FAILURE', message: 'box failed' },
        })
      );
      return { id: body.id as string, oldJob };
    }

    it('an ISE is stored as a system error with its code, and the author may ask for another check', async () => {
      const { id } = await iseSubmission();
      const detail = (await cast.solver.request('GET', `/api/v1/submissions/${id}`)).body;
      expect(detail).toMatchObject({
        status: 'completed',
        verdict: 'ISE',
        error_code: 'SANDBOX_FAILURE',
        results: [],
        time_ms: null,
        memory_kb: null,
        can_rejudge: true,
      });
    });

    it('queues it again under a new job, and the old job’s late result cannot overwrite anything', async () => {
      const { id, oldJob } = await iseSubmission();
      const again = await cast.solver.request('POST', `/api/v1/submissions/${id}/rejudge`);
      expect(again.status).toBe(202);
      expect(again.body).toMatchObject({
        status: 'queued',
        verdict: null,
        error_code: null,
        results: [],
        can_rejudge: false,
      });
      await t.settle();
      expect(t.judge.jobs).toHaveLength(2);
      const newJob = t.judge.last;
      expect(newJob.job_id).not.toBe(oldJob.job_id);

      // The old job’s result arrives late (or again): refused, state untouched.
      const stale = await t.deliver(jobResult(oldJob, { verdict: 'WA' }));
      expect(stale.status).toBe(404);
      expect((await cast.solver.request('GET', `/api/v1/submissions/${id}`)).body.status).toBe(
        'queued'
      );

      expect((await t.deliver(jobResult(newJob))).status).toBe(204);
      expect((await cast.solver.request('GET', `/api/v1/submissions/${id}`)).body).toMatchObject({
        status: 'completed',
        verdict: 'AC',
        error_code: null,
      });
    });

    it('owners and editors can do it too; other solvers cannot', async () => {
      const { id } = await iseSubmission();
      expect(
        (await cast.outsider.request('POST', `/api/v1/submissions/${id}/rejudge`)).status
      ).toBe(404);
      expect((await cast.visitor.request('POST', `/api/v1/submissions/${id}/rejudge`)).status).toBe(
        401
      );
      const byEditor = await cast.editor.request('POST', `/api/v1/submissions/${id}/rejudge`);
      expect(byEditor.status).toBe(202);
    });

    it('is only for a submission that ended in ISE', async () => {
      const { body } = await submitCode(cast.solver, cast.slug, 'sum');
      await t.settle();
      const queued = await cast.solver.request('POST', `/api/v1/submissions/${body.id}/rejudge`);
      expect(queued.status).toBe(403);
      await t.deliver(jobResult(t.judge.last));
      const accepted = await cast.solver.request('POST', `/api/v1/submissions/${body.id}/rejudge`);
      expect(accepted.status).toBe(403);
      expect(t.judge.jobs).toHaveLength(1);
    });

    it('asking twice at once re-queues once', async () => {
      const { id } = await iseSubmission();
      const [one, two] = await Promise.all([
        cast.solver.request('POST', `/api/v1/submissions/${id}/rejudge`),
        cast.solver.request('POST', `/api/v1/submissions/${id}/rejudge`),
      ]);
      expect([one.status, two.status].sort()).toEqual([202, 409]);
      await t.settle();
      expect(t.judge.jobs).toHaveLength(2);
    });

    it('is not possible in an archived Space', async () => {
      const { id } = await iseSubmission();
      await cast.owner.request('POST', `/api/v1/spaces/${cast.slug}/archive`);
      expect((await cast.solver.request('POST', `/api/v1/submissions/${id}/rejudge`)).status).toBe(
        403
      );
    });
  });
});
