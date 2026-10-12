import {
  Cast,
  castSpace,
  createDraft,
  createPublishedProblem,
  placeInTrack,
  submitCode,
} from '@/test/fixtures';
import {
  Client,
  createTestApp,
  describeDb,
  jobResult,
  resetDatabase,
  TestApp,
} from '@/test/harness';

describeDb('Progression (GRD-82)', () => {
  let t: TestApp;
  let cast: Cast;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    cast = await castSpace(t, { visibility: 'public' });
    for (const slug of ['pa', 'pb', 'pc']) await createPublishedProblem(cast, slug);
    await createDraft(cast.editor, 'team', 'pd');
    await cast.editor.request('POST', '/api/v1/spaces/team/collections/general-set/problems', {
      problem_slugs: ['pd'],
    });
  });
  afterEach(async () => t.close());

  const track = '/api/v1/spaces/team/tracks/general';

  /** A submission that Judge answers with the given verdict. */
  async function attempt(client: Client, problem: string, verdict: 'AC' | 'WA' = 'AC') {
    const response = await submitCode(client, 'team', problem);
    expect(response.status).toBe(202);
    await t.settle();
    const job = t.judge.last;
    const result = jobResult(job);
    const delivered = await t.deliver(
      verdict === 'AC'
        ? result
        : {
            ...result,
            verdict: 'WA',
            tests: result.tests.map((test) => ({ ...test, verdict: 'WA' })),
            summary: { ...result.summary, passed: 0 },
          }
    );
    expect(delivered.status).toBe(204);
    return response.body.id as string;
  }

  const mine = async (client: Client) => (await client.request('GET', `${track}/progress`)).body;

  it('counts a problem as passed after at least one AC, out of the published problems', async () => {
    expect((await mine(cast.solver)).progress).toEqual({ solved: 0, total: 3 });
    await attempt(cast.solver, 'pa');
    await attempt(cast.solver, 'pb', 'WA');
    const progress = await mine(cast.solver);
    expect(progress.progress).toEqual({ solved: 1, total: 3 });
    expect(progress.collections[0].progress).toEqual({ solved: 1, total: 3 });
    expect(
      progress.collections[0].problems.map((p: { slug: string; solved: boolean }) => [
        p.slug,
        p.solved,
      ])
    ).toEqual([
      ['pa', true],
      ['pb', false],
      ['pc', false],
    ]);
  });

  it('a later wrong answer does not take a solved problem away; several ACs count once', async () => {
    await attempt(cast.solver, 'pa');
    await attempt(cast.solver, 'pa', 'WA');
    await attempt(cast.solver, 'pa');
    expect((await mine(cast.solver)).progress.solved).toBe(1);
  });

  it('is shown on the Track page with the verdict of the last attempt', async () => {
    await attempt(cast.solver, 'pa');
    await attempt(cast.solver, 'pb', 'WA');
    const detail = await cast.solver.request('GET', track);
    expect(detail.body.progress).toEqual({ solved: 1, total: 3 });
    const problems = detail.body.collections[0].problems;
    expect(
      problems.map((p: { slug: string; my_verdict: string | null; solved: boolean }) => [
        p.slug,
        p.my_verdict,
        p.solved,
      ])
    ).toEqual([
      ['pa', 'AC', true],
      ['pb', 'WA', false],
      ['pc', null, false],
    ]);
    expect(detail.body.collections[0].progress).toEqual({ solved: 1, total: 3 });
    const list = await cast.solver.request('GET', '/api/v1/spaces/team/tracks');
    expect(list.body.items[0].progress).toEqual({ solved: 1, total: 3 });
  });

  it('drafts and archived problems do not count', async () => {
    expect((await mine(cast.solver)).progress.total).toBe(3); // pd is a draft
    await cast.editor.request('POST', '/api/v1/spaces/team/problems/pc/archive');
    expect((await mine(cast.solver)).progress.total).toBe(2);
  });

  it('a problem taken out of a Collection or Track leaves the denominator, and solved ones leave the numerator', async () => {
    await attempt(cast.solver, 'pa');
    await cast.editor.request(
      'POST',
      '/api/v1/spaces/team/collections/general-set/problems/remove',
      {
        problem_slugs: ['pa', 'pb'],
      }
    );
    expect((await mine(cast.solver)).progress).toEqual({ solved: 0, total: 1 });
    await cast.editor.request('POST', '/api/v1/spaces/team/collections/general-set/problems', {
      problem_slugs: ['pa'],
    });
    expect((await mine(cast.solver)).progress).toEqual({ solved: 1, total: 2 }); // the AC was never lost
  });

  it('a problem in two Collections counts once for the Track and once in each Collection', async () => {
    await placeInTrack(cast, 'pa', { collection: 'second-set' });
    await attempt(cast.solver, 'pa');
    const progress = await mine(cast.solver);
    expect(progress.progress).toEqual({ solved: 1, total: 3 });
    const bySlug = Object.fromEntries(
      progress.collections.map((c: { slug: string; progress: object }) => [c.slug, c.progress])
    );
    expect(bySlug['general-set']).toEqual({ solved: 1, total: 3 });
    expect(bySlug['second-set']).toEqual({ solved: 1, total: 1 });
  });

  it('progress is kept when the problem gets a new version', async () => {
    await attempt(cast.solver, 'pa');
    const problem = await t.prisma.problem.findFirstOrThrow({
      where: { slug: 'pa' },
      include: { current_version: true },
    });
    const old = problem.current_version!;
    const next = await t.prisma.problemVersion.create({
      data: {
        problem_id: problem.id,
        version_number: 2,
        title: old.title,
        time_limit_ms: old.time_limit_ms,
        memory_limit_kb: old.memory_limit_kb,
        allowed_languages: old.allowed_languages,
      },
    });
    await t.prisma.problemVersion.update({
      where: { id: next.id },
      data: { status: 'published', published_at: new Date() },
    });
    await t.prisma.problem.update({
      where: { id: problem.id },
      data: { current_version_id: next.id },
    });
    expect((await mine(cast.solver)).progress).toEqual({ solved: 1, total: 3 });
  });

  it('visitors have no progress; the Track page still opens', async () => {
    expect((await cast.visitor.request('GET', `${track}/progress`)).status).toBe(401);
    expect((await cast.visitor.request('GET', track)).body.progress).toBeNull();
  });

  describe('other people’s progress', () => {
    beforeEach(async () => {
      await attempt(cast.solver, 'pa');
      await attempt(cast.solver, 'pb');
    });

    it('owners and editors can see one member’s progress', async () => {
      for (const who of ['owner', 'editor'] as const) {
        const response = await cast[who].request('GET', `${track}/progress?username=sol`);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          user: { username: 'sol' },
          progress: { solved: 2, total: 3 },
        });
      }
    });

    it('a solver can name only themselves', async () => {
      expect((await cast.solver.request('GET', `${track}/progress?username=sol`)).status).toBe(200);
      expect((await cast.solver.request('GET', `${track}/progress?username=olivia`)).status).toBe(
        403
      );
      expect((await cast.outsider.request('GET', `${track}/progress?username=sol`)).status).toBe(
        403
      );
    });

    it('asking about someone who is not a member is 404', async () => {
      expect((await cast.owner.request('GET', `${track}/progress?username=otto`)).status).toBe(404);
      expect((await cast.owner.request('GET', `${track}/progress?username=ghost`)).status).toBe(
        404
      );
    });

    it('owners and editors get a table of the solvers', async () => {
      const response = await cast.editor.request('GET', `${track}/progress/members`);
      expect(response.status).toBe(200);
      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({
        user: { username: 'sol' },
        role: 'solver',
        progress: { solved: 2, total: 3 },
      });
      expect((await cast.solver.request('GET', `${track}/progress/members`)).status).toBe(403);
      expect((await cast.visitor.request('GET', `${track}/progress/members`)).status).toBe(401);
    });

    it('a members-only Track lists only its members', async () => {
      await cast.owner.request('PATCH', `${track}`, { visibility: 'members' });
      expect((await cast.owner.request('GET', `${track}/progress/members`)).body.items).toEqual([]);
    });
  });
});
