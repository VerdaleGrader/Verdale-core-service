import {
  Cast,
  addTest,
  castSpace,
  createDraft,
  createPublishedProblem,
  problemUrl,
} from '@/test/fixtures';
import { createTestApp, describeDb, jobResult, resetDatabase, TestApp } from '@/test/harness';
import type { JobRequest } from '@/libs/judge';

describeDb('The testcases page: one save, previews and Generate (GRD-108)', () => {
  let t: TestApp;
  let cast: Cast;

  async function setup(tuning: Parameters<typeof createTestApp>[1] = {}) {
    t = await createTestApp({}, tuning);
    await resetDatabase(t.prisma);
    cast = await castSpace(t);
  }
  beforeEach(async () => setup());
  afterEach(async () => t.close());

  const url = (suffix = '') => problemUrl(cast.slug, 'sum', suffix);

  async function observerClient() {
    const client = await t.login({
      providerAccountId: 'olga',
      email: 'olga@example.com',
      usernameHint: 'olga',
    });
    const invite = await cast.owner.request('POST', `/api/v1/spaces/${cast.slug}/invites`, {
      role: 'observer',
    });
    await client.request('POST', `/api/v1/invites/${invite.body.token}/accept`);
    return client;
  }

  /** Uploads a text as a staged file and returns its hash. */
  async function stage(text: string, client = cast.editor) {
    const response = await client.request('POST', url('/tests/files'), { text });
    expect(response.status).toBe(201);
    return response.body.sha256 as string;
  }

  async function draftWith(count: number) {
    await createDraft(cast.editor, cast.slug, 'sum');
    for (let i = 1; i <= count; i++) {
      expect(
        (await addTest(cast.editor, cast.slug, 'sum', `${i} ${i}\n`, `${i * 2}\n`, i === 1)).status
      ).toBe(201);
    }
    return (await cast.editor.request('GET', url('/tests'))).body;
  }

  describe('staged files', () => {
    it('stores pasted text and an uploaded file, normalised, and answers their hash and size', async () => {
      await createDraft(cast.editor, cast.slug, 'sum');
      const pasted = await cast.editor.request('POST', url('/tests/files'), {
        text: '1 2\r\n\r\n',
      });
      expect(pasted.status).toBe(201);
      expect(pasted.body).toMatchObject({ size_bytes: 4, total_lines: 1 });
      expect(pasted.body.sha256).toMatch(/^[a-f0-9]{64}$/);

      const uploaded = await cast.editor.upload('POST', url('/tests/files'), [
        { name: 'file', filename: 'x.in', content: '1 2\n' },
      ]);
      expect(uploaded.status).toBe(201);
      expect(uploaded.body.sha256).toBe(pasted.body.sha256);
      expect(t.storage.tests.objects.has(`tests/${pasted.body.sha256}`)).toBe(true);
    });

    it('counts lines, and an empty text is a file with no lines', async () => {
      await createDraft(cast.editor, cast.slug, 'sum');
      expect(
        (await cast.editor.request('POST', url('/tests/files'), { text: 'a\nb\nc' })).body
          .total_lines
      ).toBe(3);
      expect(await cast.editor.request('POST', url('/tests/files'), { text: '' })).toMatchObject({
        status: 201,
        body: { size_bytes: 0, total_lines: 0 },
      });
    });

    it('refuses a binary file, NUL, and anything over the size limit, naming the file', async () => {
      await createDraft(cast.editor, cast.slug, 'sum');
      const binary = await cast.editor.upload('POST', url('/tests/files'), [
        { name: 'file', filename: 'bad.in', content: Buffer.from([0x31, 0x00, 0x32]) },
      ]);
      expect(binary.status).toBe(400);
      expect(binary.body.details[0]).toMatchObject({ field: 'file' });
      expect(binary.body.details[0].message).toContain('bad.in');
      expect(
        (await cast.editor.request('POST', url('/tests/files'), { text: 'a\u0000b' })).status
      ).toBe(400);
      expect(
        (
          await cast.editor.request('POST', url('/tests/files'), {
            text: 'x'.repeat(1024 * 1024 + 1),
          })
        ).status
      ).toBe(413);
    });

    it('is for people who can edit, and only while the draft is open', async () => {
      await createDraft(cast.editor, cast.slug, 'sum');
      const observer = await observerClient();
      for (const client of [cast.solver, observer]) {
        expect((await client.request('POST', url('/tests/files'), { text: '1' })).status).toBe(403);
      }
      expect((await cast.visitor.request('POST', url('/tests/files'), { text: '1' })).status).toBe(
        401
      );
      await createPublishedProblem(cast, 'done');
      const response = await cast.editor.request(
        'POST',
        problemUrl(cast.slug, 'done', '/tests/files'),
        { text: '1' }
      );
      expect(response.status).toBe(409);
      expect(response.body.error_code).toBe('VERSION_PUBLISHED');
    });
  });

  describe('saving the whole page', () => {
    it('reorders, changes visibility, removes, adds and replaces in one request', async () => {
      const before = await draftWith(3);
      const [one, two, three] = before.items;
      const newInput = await stage('9 9');
      const newOutput = await stage('18');
      const replaced = await stage('42');
      const response = await cast.editor.request('PUT', url('/tests'), {
        revision: before.revision,
        tests: [
          { id: three.id, is_sample: true },
          { id: one.id, is_sample: false, output: { sha256: replaced } },
          { is_sample: false, input: { sha256: newInput }, output: { sha256: newOutput } },
          { is_sample: false, input: { sha256: newInput } },
        ],
      });
      expect(response.status).toBe(200);
      const items = response.body.items;
      expect(items.map((item: { id: string }) => item.id).slice(0, 2)).toEqual([three.id, one.id]);
      expect(items.map((item: { position: number }) => item.position)).toEqual([1, 2, 3, 4]);
      expect(items.map((item: { is_sample: boolean }) => item.is_sample)).toEqual([
        true,
        false,
        false,
        false,
      ]);
      expect(items[1].output_sha256).toBe(replaced);
      expect(items[1].input_sha256).toBe(one.input_sha256);
      expect(items[2]).toMatchObject({ input_sha256: newInput, output_sha256: newOutput });
      expect(items[3]).toMatchObject({
        input_sha256: newInput,
        output_sha256: null,
        output_size_bytes: null,
      });
      expect(items.some((item: { id: string }) => item.id === two.id)).toBe(false);
      expect(response.body.summary).toMatchObject({
        count: 4,
        sample_count: 1,
        missing_output_count: 1,
      });
      expect(response.body.revision).not.toBe(before.revision);
      expect((await cast.editor.request('GET', url('/tests'))).body.revision).toBe(
        response.body.revision
      );
    });

    it('saves nothing when any part is wrong', async () => {
      const before = await draftWith(2);
      const response = await cast.editor.request('PUT', url('/tests'), {
        tests: [
          { id: before.items[1].id, is_sample: true },
          { is_sample: false, input: { sha256: 'a'.repeat(64) } },
        ],
      });
      expect(response.status).toBe(400);
      expect(response.body.details[0]).toMatchObject({ field: 'tests[1].input' });
      const after = await cast.editor.request('GET', url('/tests'));
      expect(after.body.revision).toBe(before.revision);
      expect(after.body.items).toHaveLength(2);
    });

    it.each([
      [
        'an id of another problem',
        (ids: string[]) => ({ id: '00000000-0000-4000-8000-000000000000', is_sample: false, ids }),
      ],
      ['a new testcase with no input', () => ({ is_sample: false })],
    ])('refuses %s', async (_label, make) => {
      const before = await draftWith(1);
      const item = make([before.items[0].id]) as { is_sample: boolean };
      const response = await cast.editor.request('PUT', url('/tests'), { tests: [item] });
      expect(response.status).toBe(400);
      expect((await cast.editor.request('GET', url('/tests'))).body.items).toHaveLength(1);
    });

    it('refuses a testcase listed twice', async () => {
      const before = await draftWith(1);
      const id = before.items[0].id;
      const response = await cast.editor.request('PUT', url('/tests'), {
        tests: [
          { id, is_sample: true },
          { id, is_sample: false },
        ],
      });
      expect(response.status).toBe(400);
    });

    it('answers 409 TESTS_CHANGED when someone else saved first', async () => {
      const before = await draftWith(2);
      const ids = before.items.map((item: { id: string }) => item.id);
      const first = await cast.owner.request('PUT', url('/tests'), {
        revision: before.revision,
        tests: [
          { id: ids[1], is_sample: true },
          { id: ids[0], is_sample: false },
        ],
      });
      expect(first.status).toBe(200);
      const second = await cast.editor.request('PUT', url('/tests'), {
        revision: before.revision,
        tests: [
          { id: ids[0], is_sample: true },
          { id: ids[1], is_sample: false },
        ],
      });
      expect(second.status).toBe(409);
      expect(second.body.error_code).toBe('TESTS_CHANGED');
      expect((await cast.editor.request('GET', url('/tests'))).body.revision).toBe(
        first.body.revision
      );
      // without a revision the save goes through (the older endpoints behave the same)
      expect(
        (
          await cast.editor.request('PUT', url('/tests'), {
            tests: [
              { id: ids[0], is_sample: true },
              { id: ids[1], is_sample: false },
            ],
          })
        ).status
      ).toBe(200);
    });

    it('enforces the number, sample and size limits as a whole', async () => {
      const before = await draftWith(1);
      const id = before.items[0].id;
      const many = Array.from({ length: 11 }, async () => stage('1'));
      expect(many.length).toBe(11);
      const sha = await stage('1');
      const tooManySamples = Array.from({ length: 11 }, () => ({
        is_sample: true,
        input: { sha256: sha },
        output: { sha256: sha },
      }));
      const samples = await cast.editor.request('PUT', url('/tests'), { tests: tooManySamples });
      expect(samples.status).toBe(409);
      expect(samples.body.error_code).toBe('SAMPLE_LIMIT_REACHED');

      const tooMany = Array.from({ length: 101 }, () => ({
        is_sample: false,
        input: { sha256: sha },
      }));
      const count = await cast.editor.request('PUT', url('/tests'), { tests: tooMany });
      expect(count.status).toBe(409);
      expect(count.body.error_code).toBe('TEST_LIMIT_REACHED');

      const big = await stage('x'.repeat(70_000));
      const bigSample = await cast.editor.request('PUT', url('/tests'), {
        tests: [{ id, is_sample: true, input: { sha256: big } }],
      });
      expect(bigSample.status).toBe(409);
      expect(bigSample.body.error_code).toBe('SAMPLE_TOO_LARGE');
      const bigHidden = await cast.editor.request('PUT', url('/tests'), {
        tests: [{ id, is_sample: false, input: { sha256: big } }],
      });
      expect(bigHidden.status).toBe(200);
    });

    it('the observer sees the page but cannot save; a solver sees nothing', async () => {
      const before = await draftWith(1);
      const observer = await observerClient();
      expect((await observer.request('GET', url('/tests'))).status).toBe(200);
      expect((await observer.request('GET', url('/editor'))).status).toBe(200);
      const body = { tests: [{ id: before.items[0].id, is_sample: false }] };
      expect((await observer.request('PUT', url('/tests'), body)).status).toBe(403);
      expect((await cast.solver.request('PUT', url('/tests'), body)).status).toBe(403);
      expect((await cast.solver.request('GET', url('/tests'))).status).toBe(403);
    });

    it('is closed once the version is published', async () => {
      await createPublishedProblem(cast, 'done');
      const list = await cast.editor.request('GET', problemUrl(cast.slug, 'done', '/tests'));
      const response = await cast.editor.request('PUT', problemUrl(cast.slug, 'done', '/tests'), {
        tests: list.body.items.map((item: { id: string }) => ({ id: item.id, is_sample: false })),
      });
      expect(response.status).toBe(409);
      expect(response.body.error_code).toBe('VERSION_PUBLISHED');
    });

    it('does not change what earlier submissions saw', async () => {
      await createPublishedProblem(cast, 'done');
      const before = await t.prisma.testCase.findMany({ orderBy: { position: 'asc' } });
      await cast.editor.request('PUT', problemUrl(cast.slug, 'done', '/tests'), { tests: [] });
      expect(await t.prisma.testCase.findMany({ orderBy: { position: 'asc' } })).toEqual(before);
    });
  });

  describe('a testcase without an expected output', () => {
    it('is allowed in a draft, shown as missing, and blocks publishing until it has one', async () => {
      await createDraft(cast.editor, cast.slug, 'sum');
      await cast.editor.request('POST', url('/solutions'), {
        language: 'cpp',
        source: 'int main(){}',
        is_primary: true,
      });
      const input = await stage('1 2');
      const sample = await stage('3');
      const saved = await cast.editor.request('PUT', url('/tests'), {
        tests: [
          { is_sample: true, input: { sha256: input }, output: { sha256: sample } },
          { is_sample: false, input: { sha256: input } },
        ],
      });
      expect(saved.body.summary.missing_output_count).toBe(1);
      const editor = await cast.editor.request('GET', url('/editor'));
      expect(editor.body.can_publish).toBe(false);
      expect(
        editor.body.publish_checks.find((check: { key: string }) => check.key === 'outputs')
      ).toMatchObject({
        ok: false,
        message: expect.stringContaining('1 testcase(s) have no expected output'),
      });
      const blocked = await cast.editor.request('POST', url('/publish'));
      expect(blocked.status).toBe(409);
      expect(blocked.body.details.map((d: { field: string }) => d.field)).toContain('outputs');

      const fixed = await cast.editor.request('PUT', url('/tests'), {
        tests: [
          { id: saved.body.items[0].id, is_sample: true },
          { id: saved.body.items[1].id, is_sample: false, output: { sha256: sample } },
        ],
      });
      expect(fixed.body.summary.missing_output_count).toBe(0);
      expect((await cast.editor.request('POST', url('/publish'))).status).toBe(200);
    });

    it('the database refuses to publish a version with one', async () => {
      await createDraft(cast.editor, cast.slug, 'sum');
      const input = await stage('1 2');
      await cast.editor.request('PUT', url('/tests'), {
        tests: [{ is_sample: true, input: { sha256: input } }],
      });
      const draft = await t.prisma.problemVersion.findFirstOrThrow({ where: { status: 'draft' } });
      await expect(
        t.prisma.problemVersion.update({
          where: { id: draft.id },
          data: { status: 'published', published_at: new Date() },
        })
      ).rejects.toThrow(/without an expected output/);
    });

    it('has no output file to show or download, and a draft preview shows an empty sample output', async () => {
      await createDraft(cast.editor, cast.slug, 'sum');
      const input = await stage('1 2');
      const saved = await cast.editor.request('PUT', url('/tests'), {
        tests: [{ is_sample: true, input: { sha256: input } }],
      });
      const id = saved.body.items[0].id;
      expect((await cast.editor.request('GET', url(`/tests/${id}/output`))).status).toBe(404);
      expect((await cast.editor.request('GET', url(`/tests/${id}/files/output`))).status).toBe(404);
      const preview = await cast.editor.request('GET', url());
      expect(preview.body.samples[0]).toMatchObject({ input: '1 2\n', output: '' });
    });
  });

  describe('previews (GRD-108)', () => {
    async function bigTest() {
      await createDraft(cast.editor, cast.slug, 'sum');
      const lines = Array.from({ length: 2500 }, (_, index) => `row ${index + 1}`).join('\n');
      const input = await stage(lines);
      const output = await stage('42');
      const saved = await cast.editor.request('PUT', url('/tests'), {
        tests: [{ is_sample: false, input: { sha256: input }, output: { sha256: output } }],
      });
      return saved.body.items[0].id as string;
    }

    it('sends the first lines with the total, and the next window on request', async () => {
      const id = await bigTest();
      const first = await cast.editor.request('GET', url(`/tests/${id}/files/input`));
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        from_line: 1,
        to_line: 10,
        total_lines: 2500,
        side: 'input',
        position: 1,
      });
      expect(first.body.lines).toHaveLength(10);
      const window = await cast.editor.request(
        'GET',
        url(`/tests/${id}/files/input?from_line=1001&max_lines=1000`)
      );
      expect(window.body).toMatchObject({ from_line: 1001, to_line: 2000, total_lines: 2500 });
      expect(window.body.lines[0]).toBe('row 1001');
      const output = await cast.editor.request('GET', url(`/tests/${id}/files/output`));
      expect(output.body).toMatchObject({ lines: ['42'], total_lines: 1 });
      expect(
        (await cast.editor.request('GET', url(`/tests/${id}/files/input?max_lines=1001`))).status
      ).toBe(400);
      expect((await cast.editor.request('GET', url(`/tests/${id}/files/other`))).status).toBe(400);
    });

    it('is for staff who can read hidden testcases: observers too, solvers and strangers never', async () => {
      const id = await bigTest();
      const observer = await observerClient();
      expect((await observer.request('GET', url(`/tests/${id}/files/input`))).status).toBe(200);
      expect((await cast.solver.request('GET', url(`/tests/${id}/files/input`))).status).toBe(403);
      expect((await cast.outsider.request('GET', url(`/tests/${id}/files/input`))).status).toBe(
        404
      );
      expect((await cast.visitor.request('GET', url(`/tests/${id}/files/input`))).status).toBe(401);
    });

    it('opens the whole file as plain text in the browser when asked, after the permission check', async () => {
      const id = await bigTest();
      const inline = await cast.editor.text('GET', url(`/tests/${id}/input?inline=true`));
      expect(inline.status).toBe(200);
      expect(inline.headers['content-type']).toContain('text/plain');
      expect(inline.headers['content-disposition']).toMatch(/^inline;/);
      expect(inline.headers['x-content-type-options']).toBe('nosniff');
      const download = await cast.editor.text('GET', url(`/tests/${id}/input`));
      expect(download.headers['content-disposition']).toMatch(/^attachment;/);
      expect((await cast.solver.text('GET', url(`/tests/${id}/input?inline=true`))).status).toBe(
        403
      );
    });
  });

  describe('generating expected outputs from a solution', () => {
    const SOURCE = 'print(sum(map(int, input().split())))';

    async function ready(count = 3) {
      const list = await draftWith(count);
      const solution = await cast.editor.request('POST', url('/solutions'), {
        language: 'python',
        source: SOURCE,
        is_primary: true,
      });
      expect(solution.status).toBe(201);
      return {
        tests: list.items as Array<{ id: string; position: number; output_sha256: string }>,
        solutionId: solution.body.id as string,
      };
    }

    const generated = (job: JobRequest, stdout: string, extra: Record<string, unknown> = {}) =>
      jobResult(job, {
        kind: 'generate',
        verdict: 'AC',
        tests: [
          {
            id: job.tests[0]!.id,
            verdict: 'AC',
            time_ms: 5,
            memory_kb: 900,
            stdout,
            stdout_size_bytes: Buffer.byteLength(stdout),
            ...extra,
          },
        ],
        summary: { passed: 1, total: 1, time_ms: 5, memory_kb: 900 },
      } as never);

    it('sends one Judge job per testcase: the solution and the input only, with the limits and a capture', async () => {
      const { solutionId, tests } = await ready(2);
      const response = await cast.editor.request('POST', url('/generate'), {
        solution_id: solutionId,
      });
      expect(response.status).toBe(202);
      expect(response.body.runs.map((run: { test_id: string }) => run.test_id)).toEqual(
        tests.map((test) => test.id)
      );
      expect(t.judge.jobs).toHaveLength(2);
      const job = t.judge.jobs[0]!;
      expect(job).toMatchObject({ kind: 'generate', language: 'python', source: SOURCE });
      expect(job.tests).toHaveLength(1);
      expect(job.tests[0]!.output).toBeUndefined();
      expect(job.tests[0]!.input.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(job.capture).toMatchObject({ stdout_bytes: 8 * 1024 * 1024 });
      expect(job.limits).toMatchObject({ time_ms: 1000, memory_kb: 262144 });
      expect(response.body.runs.map((run: { status: string }) => run.status)).toEqual([
        'running',
        'running',
      ]);
    });

    it('runs at most three at a time and starts the next as results arrive', async () => {
      const { solutionId } = await ready(5);
      const started = await cast.editor.request('POST', url('/generate'), {
        solution_id: solutionId,
      });
      expect(t.judge.jobs).toHaveLength(3);
      expect(started.body.progress).toEqual({ total: 5, done: 0, failed: 0 });
      expect((await t.deliver(generated(t.judge.jobs[0]!, '2\n'))).status).toBe(204);
      expect(t.judge.jobs).toHaveLength(4);
      for (const job of t.judge.jobs.slice(1)) await t.deliver(generated(job, '4\n'));
      expect(t.judge.jobs).toHaveLength(5);
      await t.deliver(generated(t.judge.jobs[4]!, '10\n'));
      const done = await cast.editor.request('GET', url(`/generate/${started.body.id}`));
      expect(done.body.status).toBe('completed');
      expect(done.body.progress).toEqual({ total: 5, done: 5, failed: 0 });
    });

    it('stores each output as a file, says whether it equals the current one, and changes nothing in the problem', async () => {
      const { solutionId, tests } = await ready(3);
      const revision = (await cast.editor.request('GET', url('/tests'))).body.revision;
      const started = await cast.editor.request('POST', url('/generate'), {
        solution_id: solutionId,
      });
      // test 1 prints what it already has (plus trailing blanks), test 2 something new, test 3 fails
      await t.deliver(generated(t.judge.jobs[0]!, '2   \n\n'));
      await t.deliver(generated(t.judge.jobs[1]!, '5\n'));
      await t.deliver(
        jobResult(t.judge.jobs[2]!, {
          kind: 'generate',
          verdict: 'TLE',
          tests: [
            {
              id: t.judge.jobs[2]!.tests[0]!.id,
              verdict: 'TLE',
              time_ms: 1000,
              memory_kb: 100,
              stderr: 'slow',
            },
          ],
          summary: { passed: 0, total: 1, time_ms: 1000, memory_kb: 100 },
        } as never)
      );
      const status = await cast.editor.request('GET', url(`/generate/${started.body.id}`));
      expect(status.body.status).toBe('completed');
      const [first, second, third] = status.body.runs;
      expect(first).toMatchObject({
        test_id: tests[0]!.id,
        status: 'done',
        same_as_current: true,
        verdict: 'AC',
      });
      expect(first.output.size_bytes).toBe(5);
      expect(second).toMatchObject({ status: 'done', same_as_current: false });
      expect(second.output.size_bytes).toBe(2);
      expect(t.storage.tests.objects.has(`tests/${second.output.sha256}`)).toBe(true);
      expect(third).toMatchObject({
        status: 'failed',
        verdict: 'TLE',
        stderr: 'slow',
        output: null,
      });
      expect(status.body.progress).toEqual({ total: 3, done: 2, failed: 1 });
      // nothing is saved until the page is saved
      expect((await cast.editor.request('GET', url('/tests'))).body.revision).toBe(revision);
    });

    it('feeds the results to the save: the author keeps some and not others', async () => {
      const { solutionId, tests } = await ready(2);
      const started = await cast.editor.request('POST', url('/generate'), {
        solution_id: solutionId,
      });
      await t.deliver(generated(t.judge.jobs[0]!, '77\n'));
      await t.deliver(generated(t.judge.jobs[1]!, '88\n'));
      const done = await cast.editor.request('GET', url(`/generate/${started.body.id}`));
      const saved = await cast.editor.request('PUT', url('/tests'), {
        tests: [
          {
            id: tests[0]!.id,
            is_sample: true,
            output: { sha256: done.body.runs[0].output.sha256 },
          },
          { id: tests[1]!.id, is_sample: false },
        ],
      });
      expect(saved.status).toBe(200);
      expect(saved.body.items[0].output_sha256).toBe(done.body.runs[0].output.sha256);
      expect(saved.body.items[1].output_sha256).toBe(tests[1]!.output_sha256);
    });

    it('runs only the testcases asked for, and the author can ask again for the rest', async () => {
      const { solutionId, tests } = await ready(3);
      const started = await cast.editor.request('POST', url('/generate'), {
        solution_id: solutionId,
        test_ids: [tests[2]!.id, tests[0]!.id],
      });
      expect(started.body.runs.map((run: { position: number }) => run.position)).toEqual([1, 3]);
      expect(t.judge.jobs).toHaveLength(2);
      const unknown = await cast.editor.request('POST', url('/generate'), {
        solution_id: solutionId,
        test_ids: ['00000000-0000-4000-8000-000000000000'],
      });
      expect(unknown.status).toBe(400);
    });

    it('reports a solution that does not compile, with its first error line, and stops the job', async () => {
      const { solutionId } = await ready(3);
      const started = await cast.editor.request('POST', url('/generate'), {
        solution_id: solutionId,
      });
      await t.deliver(
        jobResult(t.judge.jobs[0]!, {
          kind: 'generate',
          verdict: 'CE',
          compile: {
            ok: false,
            message: '\nmain.py:1: SyntaxError: invalid syntax\nmore\n',
            time_ms: 3,
          },
          tests: [],
          summary: { passed: 0, total: 1, time_ms: 0, memory_kb: 0 },
        } as never)
      );
      const status = await cast.editor.request('GET', url(`/generate/${started.body.id}`));
      expect(status.body.status).toBe('failed');
      expect(status.body.error).toEqual({
        code: 'COMPILE_ERROR',
        message: 'main.py:1: SyntaxError: invalid syntax',
      });
      expect(t.judge.jobs).toHaveLength(3); // nothing more was started
    });

    it('stop keeps what finished, refuses late results, and the rest can be run again', async () => {
      const { solutionId, tests } = await ready(4);
      const started = await cast.editor.request('POST', url('/generate'), {
        solution_id: solutionId,
      });
      await t.deliver(generated(t.judge.jobs[0]!, '2\n'));
      const stopped = await cast.editor.request('POST', url(`/generate/${started.body.id}/stop`));
      expect(stopped.status).toBe(200);
      expect(stopped.body.status).toBe('stopped');
      expect(stopped.body.runs.map((run: { status: string }) => run.status)).toEqual([
        'done',
        'queued',
        'queued',
        'queued',
      ]);
      expect(stopped.body.progress.done).toBe(1);

      // a result that was already on its way is refused (Judge treats the 404 as final)
      expect((await t.deliver(generated(t.judge.jobs[1]!, '4\n'))).status).toBe(404);
      expect(
        (await cast.editor.request('GET', url(`/generate/${started.body.id}`))).body.runs[1].status
      ).toBe('queued');

      const again = await cast.editor.request('POST', url('/generate'), {
        solution_id: solutionId,
        test_ids: tests.slice(1).map((test) => test.id),
      });
      expect(again.status).toBe(202);
      expect(again.body.runs).toHaveLength(3);
      // stopping twice is harmless
      expect(
        (await cast.editor.request('POST', url(`/generate/${started.body.id}/stop`))).status
      ).toBe(200);
    });

    it('allows one job at a time per problem', async () => {
      const { solutionId } = await ready(2);
      const first = await cast.editor.request('POST', url('/generate'), {
        solution_id: solutionId,
      });
      const second = await cast.owner.request('POST', url('/generate'), {
        solution_id: solutionId,
      });
      expect(second.status).toBe(409);
      expect(second.body.error_code).toBe('GENERATE_RUNNING');
      await cast.editor.request('POST', url(`/generate/${first.body.id}/stop`));
      expect(
        (await cast.owner.request('POST', url('/generate'), { solution_id: solutionId })).status
      ).toBe(202);
    });

    it('gives up after the time limit and keeps what finished', async () => {
      await afterEachClose();
      await setup({ generateTimeoutMs: 300 });
      const { solutionId } = await ready(2);
      const started = await cast.editor.request('POST', url('/generate'), {
        solution_id: solutionId,
      });
      await t.deliver(generated(t.judge.jobs[0]!, '2\n'));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const status = await cast.editor.request('GET', url(`/generate/${started.body.id}`));
      expect(status.body.status).toBe('timed_out');
      expect(status.body.runs.map((run: { status: string }) => run.status)).toEqual([
        'done',
        'queued',
      ]);
      expect((await t.deliver(generated(t.judge.jobs[1]!, '4\n'))).status).toBe(404);
    });

    it('turns an output that is not text into a failed run, not a broken save', async () => {
      const { solutionId } = await ready(1);
      const started = await cast.editor.request('POST', url('/generate'), {
        solution_id: solutionId,
      });
      await t.deliver(generated(t.judge.jobs[0]!, 'a\u0001b\n'));
      const run = (await cast.editor.request('GET', url(`/generate/${started.body.id}`))).body
        .runs[0];
      expect(run).toMatchObject({ status: 'failed', error_code: 'OUTPUT_NOT_TEXT', output: null });
    });

    it('retries when Judge is away, then fails the job with JUDGE_UNAVAILABLE', async () => {
      const { solutionId } = await ready(1);
      t.judge.mode = 'down';
      const started = await cast.editor.request('POST', url('/generate'), {
        solution_id: solutionId,
      });
      expect(started.status).toBe(202);
      expect(started.body.runs[0]).toMatchObject({ status: 'queued' });
      expect(started.body.status).toBe('running');
      // Judge comes back: the next pass hands it over
      t.judge.mode = 'up';
      await t.prisma.generateRun.updateMany({
        data: { next_dispatch_at: new Date(Date.now() - 1000) },
      });
      await t.app.generator?.tick();
      expect(t.judge.jobs).toHaveLength(1);
      expect(
        (await cast.editor.request('GET', url(`/generate/${started.body.id}`))).body.runs[0].status
      ).toBe('running');
    });

    it('fails the job when Judge refuses to answer after several tries', async () => {
      const { solutionId } = await ready(1);
      t.judge.mode = 'down';
      const started = await cast.editor.request('POST', url('/generate'), {
        solution_id: solutionId,
      });
      for (let attempt = 0; attempt < 6; attempt++) {
        await t.prisma.generateRun.updateMany({
          data: { next_dispatch_at: new Date(Date.now() - 1000) },
        });
        await t.app.generator?.tick();
      }
      const status = await cast.editor.request('GET', url(`/generate/${started.body.id}`));
      expect(status.body.status).toBe('failed');
      expect(status.body.error).toMatchObject({ code: 'JUDGE_UNAVAILABLE' });
    });

    it('is for people who can edit; an observer can look at a job but not start or stop one', async () => {
      const { solutionId } = await ready(1);
      const started = await cast.editor.request('POST', url('/generate'), {
        solution_id: solutionId,
      });
      const observer = await observerClient();
      expect((await observer.request('GET', url(`/generate/${started.body.id}`))).status).toBe(200);
      expect(
        (await observer.request('POST', url('/generate'), { solution_id: solutionId })).status
      ).toBe(403);
      expect(
        (await observer.request('POST', url(`/generate/${started.body.id}/stop`))).status
      ).toBe(403);
      for (const client of [cast.solver, cast.outsider]) {
        expect([403, 404]).toContain(
          (await client.request('GET', url(`/generate/${started.body.id}`))).status
        );
        expect([403, 404]).toContain(
          (await client.request('POST', url('/generate'), { solution_id: solutionId })).status
        );
      }
      expect(
        (await cast.visitor.request('POST', url('/generate'), { solution_id: solutionId })).status
      ).toBe(401);
    });

    it('needs a solution of this problem and a draft, and does not leak across problems', async () => {
      const { solutionId } = await ready(1);
      expect(
        (
          await cast.editor.request('POST', url('/generate'), {
            solution_id: '00000000-0000-4000-8000-000000000000',
          })
        ).status
      ).toBe(404);
      await createPublishedProblem(cast, 'done');
      const published = await cast.editor.request(
        'POST',
        problemUrl(cast.slug, 'done', '/generate'),
        { solution_id: solutionId }
      );
      expect(published.status).toBe(409);
      expect(
        (
          await cast.editor.request(
            'GET',
            problemUrl(cast.slug, 'done', '/generate/00000000-0000-4000-8000-000000000000')
          )
        ).status
      ).toBe(404);
    });

    it('forgets jobs after a day', async () => {
      const { solutionId } = await ready(1);
      const started = await cast.editor.request('POST', url('/generate'), {
        solution_id: solutionId,
      });
      await cast.editor.request('POST', url(`/generate/${started.body.id}/stop`));
      await t.prisma.generateJob.updateMany({
        data: { created_at: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      });
      await t.app.generator?.tick();
      expect((await cast.editor.request('GET', url(`/generate/${started.body.id}`))).status).toBe(
        404
      );
    });
  });

  async function afterEachClose() {
    await t.close();
  }
});
