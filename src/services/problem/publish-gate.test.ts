import { jobResult } from '@/test/harness';
import {
  Cast,
  SOLUTION_SOURCE,
  addTest,
  castSpace,
  createDraft,
  createPublishedProblem,
  joinSpace,
  problemUrl,
  verifyDraft,
} from '@/test/fixtures';
import { createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

describeDb('Publish gate and versions (GRD-50 to GRD-54, GRD-116, GRD-117)', () => {
  let t: TestApp;
  let cast: Cast;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    cast = await castSpace(t);
  });
  afterEach(async () => t.close());

  const url = (suffix = '') => problemUrl(cast.slug, 'sum', suffix);
  const ready = async () => {
    await createDraft(cast.editor, cast.slug);
    await addTest(cast.editor, cast.slug, 'sum', '1 2\n', '3\n', true);
    await addTest(cast.editor, cast.slug, 'sum', '5 6\n', '11\n', false);
    await cast.editor.request('POST', url('/solutions'), {
      language: 'cpp',
      source: SOLUTION_SOURCE,
    });
  };
  const editor = async () => (await cast.editor.request('GET', url('/editor'))).body;
  const update = (body: Record<string, unknown>, client = cast.editor) =>
    client.request('POST', url('/updates'), body);

  describe('verify', () => {
    it('refuses to verify until the cheap checks pass, naming each one', async () => {
      await createDraft(cast.editor, cast.slug);
      const blocked = await cast.editor.request('POST', url('/verify'));
      expect(blocked.status).toBe(409);
      expect(blocked.body.error_code).toBe('VERIFY_BLOCKED');
      const keys = blocked.body.details.map((d: { field: string }) => d.field);
      expect(keys).toEqual(
        expect.arrayContaining(['tests', 'sample_test', 'hidden_tests', 'solution'])
      );
      expect(keys).not.toContain('verified');
    });

    it('sends one verify job with every test, passes on all AC and unlocks publish', async () => {
      await ready();
      const started = await cast.editor.request('POST', url('/verify'));
      expect(started.status).toBe(202);
      expect(started.body).toMatchObject({ status: 'queued', valid: false, tests_total: 2 });
      expect((await editor()).version.status).toBe('verifying');
      expect((await cast.editor.request('POST', url('/verify'))).body.error_code).toBe(
        'VERIFY_IN_PROGRESS'
      );
      await t.settle();
      expect(t.judge.jobs).toHaveLength(1);
      expect(t.judge.last.kind).toBe('verify');
      expect(t.judge.last.tests).toHaveLength(2);
      // Edits are refused while it runs.
      const edit = await cast.editor.request('PATCH', url(), { time_limit_ms: 2000 });
      expect(edit.body.error_code).toBe('VERIFY_IN_PROGRESS');
      expect((await cast.editor.request('POST', url('/publish'))).status).toBe(409);

      const delivered = await t.deliver(jobResult(t.judge.last, { kind: 'verify' }));
      expect(delivered.status).toBe(204);
      expect((await t.deliver(jobResult(t.judge.last, { kind: 'verify' }))).status).toBe(204);
      const view = await editor();
      expect(view.version).toMatchObject({ status: 'verified', label: 'v1.0' });
      expect(view.can_publish).toBe(true);
      const run = (await cast.editor.request('GET', url('/verify'))).body;
      expect(run).toMatchObject({
        status: 'passed',
        valid: true,
        tests_passed: 2,
        max_time_ms: 12,
      });
      expect(run.results).toHaveLength(2);

      const published = await cast.editor.request('POST', url('/publish'));
      expect(published.status).toBe(200);
      expect(published.body.version).toMatchObject({ status: 'published', label: 'v1.0' });
      expect(published.body.open_version.label).toBe('v1.0');
    });

    it('a failed test sends the version back to draft with the reason', async () => {
      await ready();
      await cast.editor.request('POST', url('/verify'));
      await t.settle();
      const result = jobResult(t.judge.last, { kind: 'verify', verdict: 'WA' });
      result.tests[1] = { ...result.tests[1]!, verdict: 'WA' };
      await t.deliver(result);
      const view = await editor();
      expect(view.version.status).toBe('draft');
      expect(view.verification).toMatchObject({
        status: 'failed',
        reason: 'Test 2 is WA',
        valid: false,
      });
      const blocked = await cast.editor.request('POST', url('/publish'));
      expect(blocked.body.details.map((d: { field: string }) => d.field)).toEqual(['verified']);
    });

    it('editing the tests after verify invalidates it', async () => {
      await ready();
      await verifyDraft(cast, 'sum');
      expect((await editor()).version.status).toBe('verified');
      await addTest(cast.editor, cast.slug, 'sum', '7 8\n', '15\n', false);
      const view = await editor();
      expect(view.version.status).toBe('draft');
      expect(view.verification.valid).toBe(false);
      expect(view.can_publish).toBe(false);
      const states = await t.prisma.problemHistory.findMany({
        where: { type: 'state_change' },
        orderBy: { at: 'asc' },
      });
      expect(states.map((row) => `${row.state_from}>${row.state_to}`)).toEqual([
        'draft>verifying',
        'verifying>verified',
        'verified>draft',
      ]);
    });

    it('closes a run Judge never answers at its deadline, so the state never sticks', async () => {
      await ready();
      await cast.editor.request('POST', url('/verify'));
      await t.prisma.verificationRun.updateMany({
        data: { deadline_at: new Date(Date.now() - 1000) },
      });
      await t.app.dispatcher!.dispatchDue();
      const view = await editor();
      expect(view.version.status).toBe('draft');
      expect(view.verification).toMatchObject({
        status: 'error',
        reason: 'Judge did not answer in time',
      });
    });

    it('retries while Judge is down, and an observer cannot start a run', async () => {
      await ready();
      t.judge.mode = 'down';
      await cast.editor.request('POST', url('/verify'));
      await t.settle();
      const run = await t.prisma.verificationRun.findFirstOrThrow();
      expect(run.status).toBe('queued');
      expect(run.next_dispatch_at).not.toBeNull();
      const observer = await joinSpace(t, cast, 'ola', 'observer');
      expect((await observer.request('POST', url('/verify'))).status).toBe(403);
      expect((await observer.request('GET', url('/verify'))).status).toBe(200);
      expect((await cast.solver.request('GET', url('/verify'))).status).toBe(403);
    });
  });

  describe('published versions', () => {
    it('refuses a direct change to a Major field, at the API and the database', async () => {
      await createPublishedProblem(cast);
      const patch = await cast.editor.request('PATCH', problemUrl(cast.slug, 'sum'), {
        time_limit_ms: 2000,
      });
      expect(patch.body.error_code).toBe('MAJOR_FIELD_LOCKED');
      const title = await cast.editor.request('PATCH', problemUrl(cast.slug, 'sum'), {
        title: 'x',
      });
      expect(title.body.error_code).toBe('VERSION_PUBLISHED');
      const row = await t.prisma.problemVersion.findFirstOrThrow({
        where: { status: 'published' },
      });
      await expect(
        t.prisma.problemVersion.update({ where: { id: row.id }, data: { time_limit_ms: 5000 } })
      ).rejects.toThrow(/Major fields/);
      await expect(
        t.prisma.problemVersion.update({ where: { id: row.id }, data: { version_number: 9 } })
      ).rejects.toThrow(/Major fields/);
      // A Minor field passes the trigger.
      await t.prisma.problemVersion.update({ where: { id: row.id }, data: { title: 'Renamed' } });
    });
  });

  describe('Minor update', () => {
    it('edits the open version in place, bumps Minor and keeps the history', async () => {
      await createPublishedProblem(cast);
      const submission = await cast.owner.request('POST', url('/submissions'), {
        language: 'cpp',
        source: SOLUTION_SOURCE,
      });
      expect(submission.body).toMatchObject({ version_major: 1, outdated: false });
      const response = await update({
        expected_version: { major: 1, minor: 0 },
        title: 'Sum of two',
        statement: 'New text',
        time_limit_ms: 1000,
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        kind: 'minor',
        forced: false,
        major_fields: [],
        label: 'v1.1',
      });
      expect(response.body.editor.version).toMatchObject({ label: 'v1.1', status: 'published' });
      const solver = await cast.solver.request('GET', url());
      expect(solver.body).toMatchObject({
        version_label: 'v1.1',
        title: 'Sum of two',
        version_minor: 1,
      });
      const history = await cast.editor.request('GET', url('/history'));
      const entry = history.body.items.find(
        (item: { type: string }) => item.type === 'minor_update'
      );
      expect(entry).toMatchObject({ label: 'v1.1', actor: { username: 'edith' } });
      expect(entry.changes.map((c: { field: string }) => c.field)).toEqual(['title', 'statement']);
      expect(entry.changes[0]).toMatchObject({ old: 'Sum of two numbers', new: 'Sum of two' });
      expect(t.judge.jobs.filter((job) => job.kind === 'verify')).toHaveLength(1);
    });

    it('refuses a stale expected_version, an empty statement and a solver', async () => {
      await createPublishedProblem(cast);
      const stale = await update({ expected_version: { major: 1, minor: 3 }, title: 'x' });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({
        error_code: 'VERSION_CONFLICT',
        details: [{ field: 'label', message: 'v1.0' }],
      });
      const empty = await update({ expected_version: { major: 1, minor: 0 }, statement: '  ' });
      expect(empty.status).toBe(400);
      expect((await editor()).open_version.label).toBe('v1.0');
      const solver = await update(
        { expected_version: { major: 1, minor: 0 }, title: 'x' },
        cast.solver
      );
      expect(solver.status).toBe(403);
      const none = await update({ expected_version: { major: 1, minor: 0 } });
      expect(none.status).toBe(400);
    });
  });

  describe('Major update', () => {
    it('a Major field starts a draft; solvers keep the open version; publishing swaps it', async () => {
      await createPublishedProblem(cast);
      const first = await cast.owner.request('POST', url('/submissions'), {
        language: 'cpp',
        source: SOLUTION_SOURCE,
      });
      const response = await update({
        expected_version: { major: 1, minor: 0 },
        title: 'Sum v2',
        time_limit_ms: 2000,
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        kind: 'major_draft',
        forced: false,
        major_fields: ['time_limit_ms'],
        label: 'v2.0',
      });
      const view = response.body.editor;
      expect(view.version).toMatchObject({
        label: 'v2.0',
        status: 'draft',
        time_limit_ms: 2000,
        title: 'Sum v2',
      });
      expect(view.open_version).toMatchObject({ label: 'v1.0', time_limit_ms: 1000 });
      expect(view.tests.count).toBe(2);
      expect(view.solutions.count).toBe(1);

      const solver = await cast.solver.request('GET', url());
      expect(solver.body).toMatchObject({ version_label: 'v1.0', time_limit_ms: 1000 });
      expect(
        (await update({ expected_version: { major: 1, minor: 0 }, force_major: true })).body
          .error_code
      ).toBe('DRAFT_EXISTS');

      // A Minor update lands on the open version at once and reaches the draft only where it did not change it.
      const minor = await update({
        expected_version: { major: 1, minor: 0 },
        title: 'Sum v1.1',
        statement: 'Edited',
      });
      expect(minor.body.label).toBe('v1.1');
      expect(minor.body.editor.version).toMatchObject({
        label: 'v2.0',
        title: 'Sum v2',
        statement: 'Edited',
      });

      // The draft needs verification and the publish rules before it replaces the open version.
      expect((await cast.editor.request('POST', url('/publish'))).status).toBe(409);
      await verifyDraft(cast, 'sum');
      const published = await cast.editor.request('POST', url('/publish'));
      expect(published.status).toBe(200);
      expect(published.body.version).toMatchObject({ label: 'v2.0', status: 'published' });
      const after = await cast.solver.request('GET', url());
      expect(after.body).toMatchObject({ version_label: 'v2.0', time_limit_ms: 2000 });

      const old = await cast.owner.request('GET', `/api/v1/submissions/${first.body.id}`);
      expect(old.body).toMatchObject({ version_major: 1, outdated: true });
      const rows = await t.prisma.problemVersion.findMany({ orderBy: { version_number: 'asc' } });
      expect(rows.map((row) => [row.version_number, row.minor, row.status])).toEqual([
        [1, 1, 'published'],
        [2, 0, 'published'],
      ]);
      // The database never lets the open version go back.
      const problem = await t.prisma.problem.findFirstOrThrow();
      await expect(
        t.prisma.problem.update({
          where: { id: problem.id },
          data: { current_version_id: rows[0]!.id },
        })
      ).rejects.toThrow(/older Major/);
    });

    it('force_major makes a draft with nothing changed, and POST /draft does the same; discard throws it away', async () => {
      await createPublishedProblem(cast);
      const forced = await update({ expected_version: { major: 1, minor: 0 }, force_major: true });
      expect(forced.body).toMatchObject({
        kind: 'major_draft',
        forced: true,
        major_fields: [],
        label: 'v2.0',
      });
      const discarded = await cast.editor.request('DELETE', url('/draft'));
      expect(discarded.status).toBe(200);
      expect(discarded.body.version.label).toBe('v1.0');
      expect((await cast.editor.request('DELETE', url('/draft'))).body.error_code).toBe('NO_DRAFT');
      const created = await cast.editor.request('POST', url('/draft'));
      expect(created.status).toBe(201);
      expect(created.body.version.label).toBe('v2.0');
      expect((await cast.editor.request('POST', url('/draft'))).body.error_code).toBe(
        'DRAFT_EXISTS'
      );
      const types = (await t.prisma.problemHistory.findMany({ orderBy: { at: 'asc' } })).map(
        (row) => row.type
      );
      expect(types).toEqual(
        expect.arrayContaining(['major_draft_created', 'major_draft_discarded'])
      );
      const never = await createDraft(cast.editor, cast.slug, 'fresh');
      expect(never.slug).toBe('fresh');
      expect(
        (await cast.editor.request('POST', problemUrl(cast.slug, 'fresh', '/draft'))).body
          .error_code
      ).toBe('NOT_PUBLISHED');
    });
  });
});
