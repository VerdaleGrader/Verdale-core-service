import {
  Cast,
  HIDDEN,
  castSpace,
  createDraft,
  createPublishedProblem,
  placeInTrack,
  problemUrl,
  submitCode,
} from '@/test/fixtures';
import { createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

/** GRD-81: solvers reach problems only through a Track they can see. */
describeDb('what solvers can reach (GRD-81)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
  });
  afterEach(async () => t.close());

  const tracks = (slug: string) => `/api/v1/spaces/${slug}/tracks`;
  const collections = (slug: string) => `/api/v1/spaces/${slug}/collections`;
  const listSlugs = async (client: Cast['solver'], slug = 'team') =>
    (await client.request('GET', `/api/v1/spaces/${slug}/problems`)).body.items.map(
      (item: { slug: string }) => item.slug
    );

  describe.each(['private', 'public'] as const)('in a %s Space', (visibility) => {
    let cast: Cast;
    beforeEach(async () => {
      cast = await castSpace(t, { visibility });
      await createPublishedProblem(cast, 'in-track');
      await createPublishedProblem(cast, 'loose', {}, { placed: false });
    });

    it('the problem list holds the problems of visible Tracks only', async () => {
      expect(await listSlugs(cast.solver)).toEqual(['in-track']);
      expect((await listSlugs(cast.editor)).sort()).toEqual(['in-track', 'loose']);
      expect((await listSlugs(cast.owner)).sort()).toEqual(['in-track', 'loose']);
    });

    it('a direct URL to a problem outside every Track is 404 for solvers, like a missing problem', async () => {
      const hidden = await cast.solver.request('GET', problemUrl('team', 'loose'));
      const missing = await cast.solver.request('GET', problemUrl('team', 'does-not-exist'));
      expect(hidden.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(hidden.body.message).toBe(missing.body.message);
      expect((await cast.solver.request('GET', problemUrl('team', 'in-track'))).status).toBe(200);
    });

    it('owners and editors read every problem, in a Track or not', async () => {
      for (const who of ['owner', 'editor'] as const) {
        expect((await cast[who].request('GET', problemUrl('team', 'loose'))).status).toBe(200);
      }
    });

    it('code can be submitted only to problems in a Track the solver can see', async () => {
      const inside = await submitCode(cast.solver, 'team', 'in-track');
      expect(inside.status).toBe(202);
      const outside = await submitCode(cast.solver, 'team', 'loose');
      expect(outside.status).toBe(404);
      // Owners and editors may try any published problem.
      expect((await submitCode(cast.editor, 'team', 'loose')).status).toBe(202);
      await t.settle();
    });

    it('the Track pages show Tracks, never problems directly in the Space', async () => {
      const list = await cast.solver.request('GET', tracks('team'));
      expect(list.body.items.map((item: { slug: string }) => item.slug)).toEqual(['general']);
      expect(list.body.items[0].problem_count).toBe(1);
      const detail = await cast.solver.request('GET', `${tracks('team')}/general`);
      expect(detail.body.collections[0].problems.map((p: { slug: string }) => p.slug)).toEqual([
        'in-track',
      ]);
      expect(JSON.stringify(detail.body)).not.toContain('loose');
    });

    it('a draft in a Collection is invisible to solvers', async () => {
      await createDraft(cast.editor, 'team', 'wip');
      await cast.editor.request('POST', `${collections('team')}/general-set/problems`, {
        problem_slugs: ['wip'],
      });
      expect(await listSlugs(cast.solver)).toEqual(['in-track']);
      expect((await cast.solver.request('GET', problemUrl('team', 'wip'))).status).toBe(404);
      expect(
        (await cast.solver.request('GET', `${collections('team')}/general-set`)).body.problems.map(
          (p: { slug: string }) => p.slug
        )
      ).toEqual(['in-track']);
      expect((await submitCode(cast.solver, 'team', 'wip')).status).toBe(404);
    });

    it('an archived Track or Collection takes its problems away from solvers', async () => {
      await cast.owner.request('POST', `${collections('team')}/general-set/archive`);
      expect(await listSlugs(cast.solver)).toEqual([]);
      expect((await cast.solver.request('GET', problemUrl('team', 'in-track'))).status).toBe(404);
      await cast.owner.request('POST', `${collections('team')}/general-set/restore`);
      expect(await listSlugs(cast.solver)).toEqual(['in-track']);
      await cast.owner.request('POST', `${tracks('team')}/general/archive`);
      expect(await listSlugs(cast.solver)).toEqual([]);
      expect((await submitCode(cast.solver, 'team', 'in-track')).status).toBe(404);
    });

    it('a problem in two Tracks is reachable while any of them is open to the person', async () => {
      await cast.owner.request('POST', tracks('team'), {
        name: 'Closed',
        slug: 'closed',
        visibility: 'members',
      });
      await placeInTrack(cast, 'loose', { track: 'closed', collection: 'closed-set' });
      // Only in a closed Track: still hidden.
      expect(await listSlugs(cast.solver)).toEqual(['in-track']);
      // Add the closed Collection to the open Track as well.
      await cast.editor.request('POST', `${tracks('team')}/general/collections`, {
        collection_slugs: ['closed-set'],
      });
      expect((await listSlugs(cast.solver)).sort()).toEqual(['in-track', 'loose']);
      expect((await submitCode(cast.solver, 'team', 'loose')).status).toBe(202);
      await t.settle();
      // Switching the open Track off hides it again.
      await cast.owner.request('PATCH', `${tracks('team')}/general`, { visibility: 'members' });
      expect(await listSlugs(cast.solver)).toEqual([]);
    });

    it('a problem leaves a Collection: solvers lose it but keep their history', async () => {
      const first = await submitCode(cast.solver, 'team', 'in-track');
      expect(first.status).toBe(202);
      await t.settle();
      await cast.editor.request('POST', `${collections('team')}/general-set/problems/remove`, {
        problem_slugs: ['in-track'],
      });
      expect((await cast.solver.request('GET', problemUrl('team', 'in-track'))).status).toBe(404);
      expect((await submitCode(cast.solver, 'team', 'in-track')).status).toBe(404);
      const history = await cast.solver.request(
        'GET',
        problemUrl('team', 'in-track', '/submissions')
      );
      expect(history.status).toBe(200);
      expect(history.body.items).toHaveLength(1);
      expect(
        (await cast.solver.request('GET', `/api/v1/submissions/${first.body.id}`)).status
      ).toBe(200);
      // Someone who never submitted cannot even tell the problem exists.
      const stranger = await t.login({ providerAccountId: 'sam', email: 'sam@example.com' });
      if (visibility === 'public') {
        expect(
          (await stranger.request('GET', problemUrl('team', 'in-track', '/submissions'))).status
        ).toBe(404);
      }
    });

    it('hidden tests never leak through the Track or Collection views', async () => {
      for (const who of ['solver', 'visitor'] as const) {
        if (visibility === 'private' && who === 'visitor') continue;
        for (const url of [
          tracks('team'),
          `${tracks('team')}/general`,
          collections('team') + '/general-set',
        ]) {
          const response = await cast[who].request('GET', url);
          expect(JSON.stringify(response.body)).not.toContain(HIDDEN.input.trim());
        }
      }
    });
  });

  describe('visitors and people outside the Space', () => {
    let cast: Cast;
    beforeEach(async () => {
      cast = await castSpace(t, { visibility: 'public' });
      await createPublishedProblem(cast, 'in-track');
      await createPublishedProblem(cast, 'loose', {}, { placed: false });
    });

    it('a visitor sees what a solver sees, and is asked to log in to submit', async () => {
      expect(await listSlugs(cast.visitor)).toEqual(['in-track']);
      expect((await cast.visitor.request('GET', problemUrl('team', 'loose'))).status).toBe(404);
      expect((await cast.visitor.request('GET', problemUrl('team', 'in-track'))).status).toBe(200);
      const detail = await cast.visitor.request('GET', `${tracks('team')}/general`);
      expect(detail.status).toBe(200);
      expect(detail.body.progress).toBeNull();
      expect(detail.body.collections[0].problems[0].solved).toBeNull();
      expect((await submitCode(cast.visitor, 'team', 'in-track')).status).toBe(401);
    });

    it('a logged-in outsider of a public Space is treated like a solver', async () => {
      expect(await listSlugs(cast.outsider)).toEqual(['in-track']);
      expect((await cast.outsider.request('GET', problemUrl('team', 'loose'))).status).toBe(404);
      expect((await submitCode(cast.outsider, 'team', 'in-track')).status).toBe(202);
      expect((await submitCode(cast.outsider, 'team', 'loose')).status).toBe(404);
      await t.settle();
    });

    it('a members-only Track hides its problems from visitors and outsiders as well', async () => {
      await cast.owner.request('PATCH', `${tracks('team')}/general`, { visibility: 'members' });
      expect(await listSlugs(cast.visitor)).toEqual([]);
      expect(await listSlugs(cast.outsider)).toEqual([]);
      expect((await cast.visitor.request('GET', problemUrl('team', 'in-track'))).status).toBe(404);
    });
  });

  it('a private Space stays closed to outsiders and visitors whatever the Tracks say', async () => {
    const cast = await castSpace(t, { visibility: 'private' });
    await createPublishedProblem(cast, 'in-track');
    for (const who of ['outsider', 'visitor'] as const) {
      expect((await cast[who].request('GET', problemUrl('team', 'in-track'))).status).toBe(404);
      expect((await cast[who].request('GET', `/api/v1/spaces/team/problems`)).status).toBe(404);
    }
  });

  it('PDF and image views follow the same rule', async () => {
    const cast = await castSpace(t, { visibility: 'public' });
    await createPublishedProblem(cast, 'loose', {}, { placed: false });
    expect(
      (await cast.solver.request('GET', problemUrl('team', 'loose', '/statement/pdf'))).status
    ).toBe(404);
  });
});
