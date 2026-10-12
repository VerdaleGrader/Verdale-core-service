import {
  Cast,
  castSpace,
  createDraft,
  createPublishedProblem,
  exposeProblem,
  problemUrl,
  submitCode,
} from '@/test/fixtures';
import { createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

describeDb('Tracks, Collections and what solvers can reach (GRD-77 to GRD-82)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
  });
  afterEach(async () => t.close());

  const base = (cast: Cast) => `/api/v1/spaces/${cast.slug}`;

  /** A member with the given role in the cast's Space. */
  async function addMember(
    cast: Cast,
    name: string,
    role: 'administrator' | 'editor' | 'observer' | 'solver'
  ) {
    const client = await t.login({
      providerAccountId: name,
      email: `${name}@example.com`,
      usernameHint: name,
    });
    const invite = await cast.owner.request('POST', `${base(cast)}/invites`, { role });
    const accepted = await client.request('POST', `/api/v1/invites/${invite.body.token}/accept`);
    expect(accepted.status).toBe(200);
    return client;
  }

  /** A finished submission, without going through Judge. */
  async function record(username: string, problemSlug: string, verdict = 'AC') {
    const user = await t.prisma.user.findUniqueOrThrow({ where: { username } });
    const problem = await t.prisma.problem.findFirstOrThrow({ where: { slug: problemSlug } });
    await t.prisma.submission.create({
      data: {
        user_id: user.id,
        problem_id: problem.id,
        problem_version_id: problem.current_version_id!,
        language: 'cpp',
        source: 'x',
        source_bytes: 1,
        status: 'completed',
        verdict: verdict as 'AC',
        tests_total: 2,
        tests_passed: verdict === 'AC' ? 2 : 0,
      },
    });
  }

  const slugsOf = (items: { slug: string }[]) => items.map((item) => item.slug);

  describe('the data model and the starting Track (GRD-77, GRD-78)', () => {
    it('every new Space starts with an empty "General" Track open to the Space', async () => {
      const cast = await castSpace(t);
      const tracks = await cast.owner.request('GET', `${base(cast)}/tracks`);
      expect(tracks.status).toBe(200);
      expect(tracks.body.items).toHaveLength(1);
      expect(tracks.body.items[0]).toMatchObject({
        name: 'General',
        slug: 'general',
        privacy: 'space',
        position: 1,
        archived: false,
        collection_count: 0,
        problem_count: 0,
      });
    });

    it('the starting Track can be named when the Space is created', async () => {
      const owner = await t.login({
        providerAccountId: 'o',
        email: 'o@example.com',
        usernameHint: 'olivia',
      });
      const created = await owner.request('POST', '/api/v1/spaces', {
        name: 'Algorithms',
        slug: 'algo',
        track_name: 'Week 1',
      });
      expect(created.status).toBe(201);
      const tracks = await owner.request('GET', '/api/v1/spaces/algo/tracks');
      expect(tracks.body.items.map((track: { name: string }) => track.name)).toEqual(['Week 1']);
      expect(tracks.body.items[0].slug).toBe('week-1');
    });

    it('a personal Space gets a "General" Track too, and it can be renamed', async () => {
      const owner = await t.login({
        providerAccountId: 'o',
        email: 'o@example.com',
        usernameHint: 'olivia',
      });
      const tracks = await owner.request('GET', '/api/v1/spaces/olivia/tracks');
      expect(tracks.body.items.map((track: { name: string }) => track.name)).toEqual(['General']);
      const renamed = await owner.request('PATCH', '/api/v1/spaces/olivia/tracks/general', {
        name: 'Practice',
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body.name).toBe('Practice');
      expect(renamed.body.slug).toBe('general');
    });

    it('slugs are unique inside a Space for Tracks and for Collections, also when archived', async () => {
      const cast = await castSpace(t);
      const track = { name: 'Basics', slug: 'basics' };
      expect((await cast.owner.request('POST', `${base(cast)}/tracks`, track)).status).toBe(201);
      expect((await cast.owner.request('POST', `${base(cast)}/tracks`, track)).status).toBe(409);
      await cast.owner.request('DELETE', `${base(cast)}/tracks/basics`);
      expect((await cast.owner.request('POST', `${base(cast)}/tracks`, track)).status).toBe(409);

      const collection = { name: 'Basics', slug: 'basics' };
      expect(
        (await cast.owner.request('POST', `${base(cast)}/collections`, collection)).status
      ).toBe(201);
      expect(
        (await cast.owner.request('POST', `${base(cast)}/collections`, collection)).status
      ).toBe(409);
      // a Track and a Collection may share a slug: they live under different paths
    });

    it('two Spaces can use the same slugs', async () => {
      const first = await castSpace(t, { slug: 'one' });
      const other = await t.login({
        providerAccountId: 'x',
        email: 'x@example.com',
        usernameHint: 'xavier',
      });
      await other.request('POST', '/api/v1/spaces', { name: 'Two', slug: 'two' });
      expect(
        (await other.request('POST', '/api/v1/spaces/two/tracks', { name: 'General', slug: 'g2' }))
          .status
      ).toBe(201);
      expect(
        (await first.owner.request('POST', `${base(first)}/tracks`, { name: 'x', slug: 'g2' }))
          .status
      ).toBe(201);
    });

    it('validates names and slugs', async () => {
      const cast = await castSpace(t);
      const url = `${base(cast)}/tracks`;
      const bad = [
        { name: '', slug: 'ok' },
        { name: 'x'.repeat(81), slug: 'ok' },
        { name: 'Fine', slug: 'a' },
        { name: 'Fine', slug: 'Has Space' },
        { name: 'Fine', slug: 'order' },
        { name: 'Fine', slug: 'members' },
        { name: 'Fine', slug: 'ok', description: 'x'.repeat(501) },
        { name: 'Fine', slug: 'ok', privacy: 'secret' },
        { name: 'Nul\u0000', slug: 'ok' },
      ];
      for (const body of bad) {
        const response = await cast.owner.request('POST', url, body);
        expect({ body, status: response.status }).toEqual({ body, status: 400 });
      }
    });

    it('derives the slug from the name, and asks for one when the name has no latin letters', async () => {
      const cast = await castSpace(t);
      const derived = await cast.owner.request('POST', `${base(cast)}/tracks`, {
        name: 'Intro to Graphs!',
      });
      expect(derived.status).toBe(201);
      expect(derived.body.slug).toBe('intro-to-graphs');
      const thai = await cast.owner.request('POST', `${base(cast)}/tracks`, { name: 'บทที่ 1' });
      expect(thai.status).toBe(400);
      expect(thai.body.details[0].field).toBe('slug');
      const withSlug = await cast.owner.request('POST', `${base(cast)}/tracks`, {
        name: 'บทที่ 1',
        slug: 'chapter-1',
      });
      expect(withSlug.status).toBe(201);
    });

    it('the database refuses a Track invitation that grants more than solver', async () => {
      const cast = await castSpace(t);
      const space = await t.prisma.space.findUniqueOrThrow({ where: { slug: cast.slug } });
      const track = await t.prisma.track.findFirstOrThrow({ where: { space_id: space.id } });
      const owner = await t.prisma.user.findUniqueOrThrow({ where: { username: 'olivia' } });
      await expect(
        t.prisma.invite.create({
          data: {
            space_id: space.id,
            track_id: track.id,
            created_by_id: owner.id,
            token_hash: 'a'.repeat(64),
            role: 'editor',
            expires_at: new Date(Date.now() + 1000),
          },
        })
      ).rejects.toThrow();
    });
  });

  describe('who can manage (GRD-78, GRD-79)', () => {
    it.each(['owner', 'editor'] as const)(
      'the %s creates, edits and archives Tracks and Collections',
      async (who) => {
        const cast = await castSpace(t);
        const client = cast[who];
        const created = await client.request('POST', `${base(cast)}/tracks`, {
          name: 'Basics',
          slug: 'basics',
        });
        expect(created.status).toBe(201);
        expect(
          (
            await client.request('PATCH', `${base(cast)}/tracks/basics`, {
              description: 'Start here',
            })
          ).body.description
        ).toBe('Start here');
        expect((await client.request('DELETE', `${base(cast)}/tracks/basics`)).status).toBe(204);

        expect(
          (await client.request('POST', `${base(cast)}/collections`, { name: 'Set', slug: 'set' }))
            .status
        ).toBe(201);
        expect((await client.request('DELETE', `${base(cast)}/collections/set`)).status).toBe(204);
      }
    );

    it('administrators can too; observers, solvers, outsiders and visitors cannot', async () => {
      const cast = await castSpace(t, { visibility: 'public' });
      const admin = await addMember(cast, 'ada', 'administrator');
      const observer = await addMember(cast, 'olga', 'observer');
      expect(
        (await admin.request('POST', `${base(cast)}/tracks`, { name: 'A', slug: 'aa' })).status
      ).toBe(201);
      for (const client of [observer, cast.solver, cast.outsider]) {
        const response = await client.request('POST', `${base(cast)}/tracks`, {
          name: 'B',
          slug: 'bb',
        });
        expect(response.status).toBe(403);
        expect(
          (await client.request('POST', `${base(cast)}/collections`, { name: 'B', slug: 'bb' }))
            .status
        ).toBe(403);
        expect((await client.request('DELETE', `${base(cast)}/tracks/general`)).status).toBe(403);
        expect(
          (
            await client.request('PUT', `${base(cast)}/tracks/order`, {
              track_slugs: ['general', 'aa'],
            })
          ).status
        ).toBe(403);
      }
      expect(
        (await cast.visitor.request('POST', `${base(cast)}/tracks`, { name: 'C', slug: 'cc' }))
          .status
      ).toBe(401);
    });

    it('nothing can be changed in an archived Space', async () => {
      const cast = await castSpace(t);
      await cast.owner.request('POST', `${base(cast)}/archive`);
      const response = await cast.owner.request('POST', `${base(cast)}/tracks`, {
        name: 'X',
        slug: 'xx',
      });
      expect(response.status).toBe(403);
    });

    it('a private Space does not reveal its Tracks to outsiders', async () => {
      const cast = await castSpace(t);
      expect((await cast.outsider.request('GET', `${base(cast)}/tracks`)).status).toBe(404);
      expect((await cast.visitor.request('GET', `${base(cast)}/tracks/general`)).status).toBe(404);
      expect((await cast.outsider.request('GET', `${base(cast)}/collections`)).status).toBe(404);
    });
  });

  describe('ordering (GRD-78, GRD-79)', () => {
    it('Tracks are listed in the order the owner set, sent as the whole list', async () => {
      const cast = await castSpace(t);
      for (const slug of ['alpha', 'beta', 'gamma']) {
        await cast.owner.request('POST', `${base(cast)}/tracks`, { name: slug, slug });
      }
      const before = await cast.owner.request('GET', `${base(cast)}/tracks`);
      expect(slugsOf(before.body.items)).toEqual(['general', 'alpha', 'beta', 'gamma']);
      const reordered = await cast.editor.request('PUT', `${base(cast)}/tracks/order`, {
        track_slugs: ['gamma', 'general', 'beta', 'alpha'],
      });
      expect(reordered.status).toBe(200);
      expect(slugsOf(reordered.body.items)).toEqual(['gamma', 'general', 'beta', 'alpha']);
      const after = await cast.solver.request('GET', `${base(cast)}/tracks`);
      expect(slugsOf(after.body.items)).toEqual(['gamma', 'general', 'beta', 'alpha']);
      expect(after.body.items.map((track: { position: number }) => track.position)).toEqual([
        1, 2, 3, 4,
      ]);
    });

    it('refuses a list that is missing a Track, repeats one, or names an unknown one', async () => {
      const cast = await castSpace(t);
      await cast.owner.request('POST', `${base(cast)}/tracks`, { name: 'alpha', slug: 'alpha' });
      for (const track_slugs of [['general'], ['general', 'general'], ['general', 'nope']]) {
        const response = await cast.owner.request('PUT', `${base(cast)}/tracks/order`, {
          track_slugs,
        });
        expect(response.status).toBe(409);
        expect(response.body.error_code).toBe('ORDER_OUT_OF_DATE');
      }
      const unchanged = await cast.owner.request('GET', `${base(cast)}/tracks`);
      expect(slugsOf(unchanged.body.items)).toEqual(['general', 'alpha']);
    });

    it('Collections are ordered inside a Track and problems inside a Collection', async () => {
      const cast = await castSpace(t);
      for (const slug of ['p1', 'p2', 'p3']) await createDraft(cast.editor, cast.slug, slug);
      for (const slug of ['one', 'two']) {
        await cast.owner.request('POST', `${base(cast)}/collections`, { name: slug, slug });
      }
      await cast.owner.request('PUT', `${base(cast)}/collections/one/problems`, {
        problem_slugs: ['p3', 'p1', 'p2'],
      });
      const track = await cast.owner.request('PUT', `${base(cast)}/tracks/general/collections`, {
        collection_slugs: ['two', 'one'],
      });
      expect(track.status).toBe(200);
      expect(slugsOf(track.body.collections)).toEqual(['two', 'one']);
      expect(slugsOf(track.body.collections[1].problems)).toEqual(['p3', 'p1', 'p2']);

      const reordered = await cast.owner.request('PUT', `${base(cast)}/collections/one/problems`, {
        problem_slugs: ['p2', 'p3'],
      });
      expect(slugsOf(reordered.body.problems)).toEqual(['p2', 'p3']);
    });
  });

  describe('Collections and their problems (GRD-79)', () => {
    it('adds and removes several problems in one request, drafts included', async () => {
      const cast = await castSpace(t);
      for (const slug of ['p1', 'p2', 'p3', 'p4']) await createDraft(cast.editor, cast.slug, slug);
      await cast.owner.request('POST', `${base(cast)}/collections`, { name: 'Set', slug: 'set' });
      const added = await cast.editor.request('PATCH', `${base(cast)}/collections/set/problems`, {
        add: ['p1', 'p2', 'p3'],
      });
      expect(added.status).toBe(200);
      expect(slugsOf(added.body.problems)).toEqual(['p1', 'p2', 'p3']);
      expect(added.body.problems[0].status).toBe('draft');

      const changed = await cast.editor.request('PATCH', `${base(cast)}/collections/set/problems`, {
        add: ['p4', 'p1'],
        remove: ['p2'],
      });
      expect(slugsOf(changed.body.problems)).toEqual(['p1', 'p3', 'p4']);
    });

    it('refuses unknown problems and repeats, and changes nothing then', async () => {
      const cast = await castSpace(t);
      await createDraft(cast.editor, cast.slug, 'p1');
      await cast.owner.request('POST', `${base(cast)}/collections`, { name: 'Set', slug: 'set' });
      const unknown = await cast.owner.request('PUT', `${base(cast)}/collections/set/problems`, {
        problem_slugs: ['p1', 'ghost'],
      });
      expect(unknown.status).toBe(400);
      expect(unknown.body.details[0].message).toContain('ghost');
      const repeated = await cast.owner.request('PUT', `${base(cast)}/collections/set/problems`, {
        problem_slugs: ['p1', 'p1'],
      });
      expect(repeated.status).toBe(400);
      const empty = await cast.owner.request('PATCH', `${base(cast)}/collections/set/problems`, {});
      expect(empty.status).toBe(400);
      const collection = await cast.owner.request('GET', `${base(cast)}/collections/set`);
      expect(collection.body.problems).toHaveLength(0);
    });

    it('cannot add a problem of another Space', async () => {
      const cast = await castSpace(t);
      const other = await t.login({
        providerAccountId: 'x',
        email: 'x@example.com',
        usernameHint: 'xavier',
      });
      await other.request('POST', '/api/v1/spaces', { name: 'Other', slug: 'other' });
      await createDraft(other, 'other', 'foreign');
      await cast.owner.request('POST', `${base(cast)}/collections`, { name: 'Set', slug: 'set' });
      const response = await cast.owner.request('PATCH', `${base(cast)}/collections/set/problems`, {
        add: ['foreign'],
      });
      expect(response.status).toBe(400);
    });

    it('a problem can be in several Collections, and a Collection in several Tracks or none', async () => {
      const cast = await castSpace(t);
      await createPublishedProblem(cast, 'p1', {}, { expose: false });
      for (const slug of ['c1', 'c2']) {
        await cast.owner.request('POST', `${base(cast)}/collections`, { name: slug, slug });
        await cast.owner.request('PATCH', `${base(cast)}/collections/${slug}/problems`, {
          add: ['p1'],
        });
      }
      await cast.owner.request('POST', `${base(cast)}/tracks`, { name: 'Two', slug: 'two' });
      for (const track of ['general', 'two']) {
        await cast.owner.request('PUT', `${base(cast)}/tracks/${track}/collections`, {
          collection_slugs: ['c1'],
        });
      }
      const c1 = await cast.owner.request('GET', `${base(cast)}/collections/c1`);
      expect(c1.body.tracks.map((track: { slug: string }) => track.slug)).toEqual([
        'general',
        'two',
      ]);
      const c2 = await cast.owner.request('GET', `${base(cast)}/collections/c2`);
      expect(c2.body.tracks).toEqual([]);
      const list = await cast.owner.request('GET', `${base(cast)}/collections`);
      expect(slugsOf(list.body.items)).toEqual(['c1', 'c2']);
    });

    it('an archived Collection leaves the lists but its problems stay in the Space', async () => {
      const cast = await castSpace(t);
      await createPublishedProblem(cast, 'p1');
      await cast.owner.request('DELETE', `${base(cast)}/collections/main`);
      expect(
        slugsOf((await cast.owner.request('GET', `${base(cast)}/collections`)).body.items)
      ).toEqual([]);
      expect(
        slugsOf(
          (await cast.owner.request('GET', `${base(cast)}/collections?include_archived=true`)).body
            .items
        )
      ).toEqual(['main']);
      expect((await cast.owner.request('GET', problemUrl(cast.slug, 'p1'))).status).toBe(200);
      // ... but solvers lose the way to it
      expect((await cast.solver.request('GET', problemUrl(cast.slug, 'p1'))).status).toBe(404);
      const restored = await cast.owner.request('PATCH', `${base(cast)}/collections/main`, {
        archived: false,
      });
      expect(restored.body.archived).toBe(false);
      expect((await cast.solver.request('GET', problemUrl(cast.slug, 'p1'))).status).toBe(200);
    });
  });

  describe('what a solver can reach (GRD-81)', () => {
    it('sees Tracks, and in them Collections and published problems, in order', async () => {
      const cast = await castSpace(t);
      await createPublishedProblem(cast, 'p1');
      await createPublishedProblem(cast, 'p2');
      await createDraft(cast.editor, cast.slug, 'wip');
      await cast.owner.request('PATCH', `${base(cast)}/collections/main/problems`, {
        add: ['wip'],
      });
      const track = await cast.solver.request('GET', `${base(cast)}/tracks/general`);
      expect(track.status).toBe(200);
      expect(track.body.collections).toHaveLength(1);
      expect(slugsOf(track.body.collections[0].problems)).toEqual(['p1', 'p2']);
      // staff see the draft, with its status
      const staff = await cast.editor.request('GET', `${base(cast)}/tracks/general`);
      expect(staff.body.collections[0].problems.map((p: { status: string }) => p.status)).toEqual([
        'published',
        'published',
        'draft',
      ]);
    });

    it('does not see problems that sit in no Collection, or only in a Collection outside every Track', async () => {
      const cast = await castSpace(t);
      await createPublishedProblem(cast, 'loose', {}, { expose: false });
      await createPublishedProblem(cast, 'orphan', {}, { expose: false });
      await cast.owner.request('POST', `${base(cast)}/collections`, { name: 'Lost', slug: 'lost' });
      await cast.owner.request('PATCH', `${base(cast)}/collections/lost/problems`, {
        add: ['orphan'],
      });

      for (const slug of ['loose', 'orphan']) {
        expect((await cast.solver.request('GET', problemUrl(cast.slug, slug))).status).toBe(404);
        expect((await cast.owner.request('GET', problemUrl(cast.slug, slug))).status).toBe(200);
      }
      const solverList = await cast.solver.request('GET', `${base(cast)}/problems`);
      expect(solverList.body.items).toEqual([]);
      expect(solverList.body.total).toBe(0);
      const ownerList = await cast.owner.request('GET', `${base(cast)}/problems`);
      expect(slugsOf(ownerList.body.items).sort()).toEqual(['loose', 'orphan']);

      // not in the solver's Collection list either
      expect((await cast.solver.request('GET', `${base(cast)}/collections`)).body.items).toEqual(
        []
      );
      expect((await cast.solver.request('GET', `${base(cast)}/collections/lost`)).status).toBe(404);
      expect(
        slugsOf((await cast.owner.request('GET', `${base(cast)}/collections`)).body.items)
      ).toEqual(['lost']);
    });

    it('cannot submit to a problem outside a Track: it is a 404, as for a private Space', async () => {
      const cast = await castSpace(t);
      await createPublishedProblem(cast, 'loose', {}, { expose: false });
      const response = await submitCode(cast.solver, cast.slug, 'loose');
      expect(response.status).toBe(404);
      expect((await submitCode(cast.owner, cast.slug, 'loose')).status).toBe(202);
    });

    it('cannot see a draft problem even when it sits in a Collection', async () => {
      const cast = await castSpace(t);
      await createDraft(cast.editor, cast.slug, 'wip');
      await exposeProblem(cast.owner, cast.slug, 'wip');
      expect((await cast.solver.request('GET', problemUrl(cast.slug, 'wip'))).status).toBe(404);
      expect((await cast.solver.request('GET', `${base(cast)}/problems`)).body.items).toEqual([]);
    });

    it('a visitor of a public Space sees what a solver sees, and must log in to submit', async () => {
      const cast = await castSpace(t, { visibility: 'public' });
      await createPublishedProblem(cast, 'p1');
      await createPublishedProblem(cast, 'loose', {}, { expose: false });
      expect((await cast.visitor.request('GET', problemUrl(cast.slug, 'p1'))).status).toBe(200);
      expect((await cast.visitor.request('GET', problemUrl(cast.slug, 'loose'))).status).toBe(404);
      const list = await cast.visitor.request('GET', `${base(cast)}/problems`);
      expect(slugsOf(list.body.items)).toEqual(['p1']);
      const track = await cast.visitor.request('GET', `${base(cast)}/tracks/general`);
      expect(track.status).toBe(200);
      expect(track.body.progress).toBeNull();
      expect(track.body.collections[0].problems[0].my_result).toBeNull();
      expect((await submitCode(cast.visitor, cast.slug, 'p1')).status).toBe(401);
    });

    it('a signed-in outsider of a public Space can solve what the Tracks show', async () => {
      const cast = await castSpace(t, { visibility: 'public' });
      await createPublishedProblem(cast, 'p1');
      await createPublishedProblem(cast, 'loose', {}, { expose: false });
      expect((await submitCode(cast.outsider, cast.slug, 'p1')).status).toBe(202);
      expect((await submitCode(cast.outsider, cast.slug, 'loose')).status).toBe(404);
    });

    it('owners, administrators, editors and observers see every Track, Collection and problem', async () => {
      const cast = await castSpace(t);
      await createPublishedProblem(cast, 'loose', {}, { expose: false });
      await createDraft(cast.editor, cast.slug, 'wip');
      await cast.owner.request('POST', `${base(cast)}/tracks`, {
        name: 'Secret',
        slug: 'secret',
        privacy: 'members',
      });
      const admin = await addMember(cast, 'ada', 'administrator');
      const observer = await addMember(cast, 'olga', 'observer');
      for (const client of [cast.owner, admin, cast.editor, observer]) {
        expect((await client.request('GET', problemUrl(cast.slug, 'loose'))).status).toBe(200);
        expect((await client.request('GET', problemUrl(cast.slug, 'wip'))).status).toBe(200);
        expect((await client.request('GET', `${base(cast)}/tracks/secret`)).status).toBe(200);
        const problems = await client.request('GET', `${base(cast)}/problems?status=all`);
        expect(slugsOf(problems.body.items).sort()).toEqual(['loose', 'wip']);
      }
    });

    it('a Collection in several Tracks is reachable when any one of them is', async () => {
      const cast = await castSpace(t);
      await createPublishedProblem(cast, 'p1');
      await cast.owner.request('POST', `${base(cast)}/tracks`, {
        name: 'Private',
        slug: 'private',
        privacy: 'members',
      });
      await cast.owner.request('PUT', `${base(cast)}/tracks/private/collections`, {
        collection_slugs: ['main'],
      });
      // visible through "general" even though "private" is closed to the solver
      expect((await cast.solver.request('GET', problemUrl(cast.slug, 'p1'))).status).toBe(200);
      expect((await cast.solver.request('GET', `${base(cast)}/collections/main`)).status).toBe(200);
      // closing "general" too closes the way
      await cast.owner.request('PATCH', `${base(cast)}/tracks/general`, { privacy: 'members' });
      expect((await cast.solver.request('GET', problemUrl(cast.slug, 'p1'))).status).toBe(404);
    });

    it('taking a problem out of its last Track keeps the solver’s history but closes submitting', async () => {
      const cast = await castSpace(t);
      await createPublishedProblem(cast, 'p1');
      const first = await submitCode(cast.solver, cast.slug, 'p1');
      expect(first.status).toBe(202);
      await t.settle();

      await cast.owner.request('PATCH', `${base(cast)}/collections/main/problems`, {
        remove: ['p1'],
      });
      expect((await cast.solver.request('GET', problemUrl(cast.slug, 'p1'))).status).toBe(404);
      expect((await submitCode(cast.solver, cast.slug, 'p1')).status).toBe(404);

      const history = await cast.solver.request(
        'GET',
        problemUrl(cast.slug, 'p1', '/submissions?scope=mine')
      );
      expect(history.status).toBe(200);
      expect(history.body.items).toHaveLength(1);
      expect(
        (await cast.solver.request('GET', `/api/v1/submissions/${first.body.id}`)).status
      ).toBe(200);
      // someone who never submitted learns nothing
      expect(
        (await cast.outsider.request('GET', problemUrl(cast.slug, 'p1', '/submissions'))).status
      ).toBe(404);
      // and a solver cannot ask for everybody's
      expect(
        (await cast.solver.request('GET', problemUrl(cast.slug, 'p1', '/submissions?scope=all')))
          .status
      ).toBe(404);
    });
  });

  describe('Track privacy and archiving (GRD-78, GRD-81)', () => {
    it('a members-only Track is hidden from everyone who was not added, but not from the staff', async () => {
      const cast = await castSpace(t, { visibility: 'public' });
      await createPublishedProblem(cast, 'p1');
      await cast.owner.request('POST', `${base(cast)}/tracks`, {
        name: 'Class A',
        slug: 'class-a',
        privacy: 'members',
      });
      await cast.owner.request('PUT', `${base(cast)}/tracks/class-a/collections`, {
        collection_slugs: ['main'],
      });
      await cast.owner.request('PUT', `${base(cast)}/tracks/general/collections`, {
        collection_slugs: [],
      });

      for (const client of [cast.solver, cast.outsider, cast.visitor]) {
        expect(slugsOf((await client.request('GET', `${base(cast)}/tracks`)).body.items)).toEqual([
          'general',
        ]);
        expect((await client.request('GET', `${base(cast)}/tracks/class-a`)).status).toBe(404);
        expect((await client.request('GET', problemUrl(cast.slug, 'p1'))).status).toBe(404);
      }
      for (const client of [cast.owner, cast.editor]) {
        expect(slugsOf((await client.request('GET', `${base(cast)}/tracks`)).body.items)).toEqual([
          'general',
          'class-a',
        ]);
      }
    });

    it('archiving a Track hides it and everything that is only reachable through it', async () => {
      const cast = await castSpace(t);
      await createPublishedProblem(cast, 'p1');
      expect((await cast.owner.request('DELETE', `${base(cast)}/tracks/general`)).status).toBe(204);
      expect((await cast.solver.request('GET', `${base(cast)}/tracks`)).body.items).toEqual([]);
      expect((await cast.solver.request('GET', `${base(cast)}/tracks/general`)).status).toBe(404);
      expect((await cast.solver.request('GET', problemUrl(cast.slug, 'p1'))).status).toBe(404);
      // nothing is lost
      const staff = await cast.owner.request('GET', `${base(cast)}/tracks?include_archived=true`);
      expect(staff.body.items[0]).toMatchObject({ slug: 'general', archived: true });
      expect((await cast.owner.request('GET', problemUrl(cast.slug, 'p1'))).status).toBe(200);
      await cast.owner.request('PATCH', `${base(cast)}/tracks/general`, { archived: false });
      expect((await cast.solver.request('GET', problemUrl(cast.slug, 'p1'))).status).toBe(200);
    });

    it('a Track cannot be given the Collections of another Space or archived ones', async () => {
      const cast = await castSpace(t);
      await cast.owner.request('POST', `${base(cast)}/collections`, { name: 'Old', slug: 'old' });
      await cast.owner.request('DELETE', `${base(cast)}/collections/old`);
      const response = await cast.owner.request('PUT', `${base(cast)}/tracks/general/collections`, {
        collection_slugs: ['old'],
      });
      expect(response.status).toBe(400);
      const unknown = await cast.owner.request('PUT', `${base(cast)}/tracks/general/collections`, {
        collection_slugs: ['ghost'],
      });
      expect(unknown.status).toBe(400);
      const repeated = await cast.owner.request('PUT', `${base(cast)}/tracks/general/collections`, {
        collection_slugs: ['ghost', 'ghost'],
      });
      expect(repeated.status).toBe(400);
    });
  });

  describe('members and invitations of a Track (GRD-80)', () => {
    async function closedTrack(cast: Cast) {
      await createPublishedProblem(cast, 'p1', {}, { expose: false });
      await cast.owner.request('POST', `${base(cast)}/collections`, { name: 'Set', slug: 'set' });
      await cast.owner.request('PATCH', `${base(cast)}/collections/set/problems`, { add: ['p1'] });
      await cast.owner.request('POST', `${base(cast)}/tracks`, {
        name: 'Class A',
        slug: 'class-a',
        privacy: 'members',
      });
      await cast.owner.request('PUT', `${base(cast)}/tracks/class-a/collections`, {
        collection_slugs: ['set'],
      });
    }

    const inviteTo = (cast: Cast, client: Cast['owner'], body: object = {}) =>
      client.request('POST', `${base(cast)}/tracks/class-a/invites`, body);

    it('a link invitation brings a newcomer into the Space as a solver and into the Track', async () => {
      const cast = await castSpace(t, { visibility: 'public' });
      await closedTrack(cast);
      const invite = await inviteTo(cast, cast.editor, { expires_in_days: 3 });
      expect(invite.status).toBe(201);
      expect(invite.body).toMatchObject({
        role: 'solver',
        track: { name: 'Class A', slug: 'class-a' },
        status: 'pending',
      });
      expect(invite.body.link).toBe(`/invites/${invite.body.token}`);

      // the preview shows which Track it is for
      const preview = await cast.visitor.request('GET', `/api/v1/invites/${invite.body.token}`);
      expect(preview.body.track).toMatchObject({ slug: 'class-a' });

      // before accepting, the outsider reaches nothing
      expect((await cast.outsider.request('GET', problemUrl(cast.slug, 'p1'))).status).toBe(404);
      const accepted = await cast.outsider.request(
        'POST',
        `/api/v1/invites/${invite.body.token}/accept`
      );
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({ role: 'solver', track: { slug: 'class-a' } });

      const space = await cast.outsider.request('GET', base(cast));
      expect(space.body.my_role).toBe('solver');
      expect(
        slugsOf((await cast.outsider.request('GET', `${base(cast)}/tracks`)).body.items)
      ).toEqual(['general', 'class-a']);
      expect((await cast.outsider.request('GET', problemUrl(cast.slug, 'p1'))).status).toBe(200);
      expect((await submitCode(cast.outsider, cast.slug, 'p1')).status).toBe(202);
      // other members still do not see it
      expect((await cast.solver.request('GET', `${base(cast)}/tracks/class-a`)).status).toBe(404);
    });

    it('in a private Space the invited person sees only their Track when every other Track is members-only', async () => {
      const cast = await castSpace(t);
      await closedTrack(cast);
      await cast.owner.request('PATCH', `${base(cast)}/tracks/general`, { privacy: 'members' });
      const invite = await inviteTo(cast, cast.owner);
      await cast.outsider.request('POST', `/api/v1/invites/${invite.body.token}/accept`);
      const tracks = await cast.outsider.request('GET', `${base(cast)}/tracks`);
      expect(slugsOf(tracks.body.items)).toEqual(['class-a']);
      expect(tracks.body.items[0].is_member).toBe(true);
    });

    it('an invitation to one person can only be answered by them', async () => {
      const cast = await castSpace(t);
      await closedTrack(cast);
      const invite = await inviteTo(cast, cast.owner, { username: 'otto' });
      expect(invite.status).toBe(201);
      expect(invite.body.invited_user.username).toBe('otto');
      expect(invite.body.link).toBeUndefined();
      expect(
        (await cast.solver.request('POST', `/api/v1/invites/${invite.body.token}/accept`)).status
      ).toBe(404);
      const mine = await cast.outsider.request('GET', '/api/v1/me/invites');
      expect(mine.body.items[0].track.slug).toBe('class-a');
      expect(
        (await cast.outsider.request('POST', `/api/v1/me/invites/${mine.body.items[0].id}/accept`))
          .status
      ).toBe(200);
      // asking twice, or inviting a member, is a conflict
      expect((await inviteTo(cast, cast.owner, { username: 'otto' })).status).toBe(409);
      expect((await inviteTo(cast, cast.owner, { username: 'nobody' })).status).toBe(404);
    });

    it('does not change the role of someone who is already in the Space', async () => {
      const cast = await castSpace(t);
      await closedTrack(cast);
      const invite = await inviteTo(cast, cast.owner);
      expect(
        (await cast.editor.request('POST', `/api/v1/invites/${invite.body.token}/accept`)).status
      ).toBe(200);
      expect((await cast.editor.request('GET', base(cast))).body.my_role).toBe('editor');
      const members = await cast.owner.request('GET', `${base(cast)}/tracks/class-a/members`);
      expect(members.body.items.map((m: { username: string }) => m.username)).toEqual(['edith']);
      expect(members.body.items[0].space_role).toBe('editor');
    });

    it('expiry, revoking and using a link twice', async () => {
      const cast = await castSpace(t);
      await closedTrack(cast);
      const revoked = await inviteTo(cast, cast.owner);
      expect(
        (
          await cast.editor.request(
            'DELETE',
            `${base(cast)}/tracks/class-a/invites/${revoked.body.id}`
          )
        ).status
      ).toBe(204);
      expect(
        (await cast.outsider.request('POST', `/api/v1/invites/${revoked.body.token}/accept`)).status
      ).toBe(410);

      const expiring = await inviteTo(cast, cast.owner);
      await t.prisma.invite.update({
        where: { id: expiring.body.id },
        data: { expires_at: new Date(Date.now() - 1000) },
      });
      expect(
        (await cast.outsider.request('POST', `/api/v1/invites/${expiring.body.token}/accept`))
          .status
      ).toBe(410);
      const listed = await cast.owner.request('GET', `${base(cast)}/tracks/class-a/invites`);
      expect(listed.body.items).toEqual([]);

      const once = await inviteTo(cast, cast.owner);
      expect(
        (await cast.outsider.request('POST', `/api/v1/invites/${once.body.token}/accept`)).status
      ).toBe(200);
      expect(
        (await cast.solver.request('POST', `/api/v1/invites/${once.body.token}/accept`)).status
      ).toBe(410);
      // revoking one that was already used
      expect(
        (await cast.owner.request('DELETE', `${base(cast)}/tracks/class-a/invites/${once.body.id}`))
          .status
      ).toBe(409);
    });

    it('a member who is already in the Track gets a conflict, not a second membership', async () => {
      const cast = await castSpace(t);
      await closedTrack(cast);
      const first = await inviteTo(cast, cast.owner);
      await cast.outsider.request('POST', `/api/v1/invites/${first.body.token}/accept`);
      const second = await inviteTo(cast, cast.owner);
      const again = await cast.outsider.request(
        'POST',
        `/api/v1/invites/${second.body.token}/accept`
      );
      expect(again.status).toBe(409);
    });

    it('a Track invitation to an archived Track is gone, and none can be made', async () => {
      const cast = await castSpace(t);
      await closedTrack(cast);
      const invite = await inviteTo(cast, cast.owner);
      await cast.owner.request('DELETE', `${base(cast)}/tracks/class-a`);
      expect(
        (await cast.outsider.request('POST', `/api/v1/invites/${invite.body.token}/accept`)).status
      ).toBe(410);
      expect((await inviteTo(cast, cast.owner)).status).toBe(409);
    });

    it('lists and removes members; the person stays in the Space', async () => {
      const cast = await castSpace(t);
      await closedTrack(cast);
      const invite = await inviteTo(cast, cast.owner);
      await cast.outsider.request('POST', `/api/v1/invites/${invite.body.token}/accept`);

      const members = await cast.editor.request('GET', `${base(cast)}/tracks/class-a/members`);
      expect(members.body.items).toHaveLength(1);
      expect(members.body.items[0]).toMatchObject({
        username: 'otto',
        space_role: 'solver',
        added_by: { username: 'olivia' },
      });
      expect(
        (await cast.owner.request('DELETE', `${base(cast)}/tracks/class-a/members/otto`)).status
      ).toBe(204);
      expect(
        (await cast.owner.request('DELETE', `${base(cast)}/tracks/class-a/members/otto`)).status
      ).toBe(404);
      expect((await cast.outsider.request('GET', base(cast))).body.my_role).toBe('solver');
      expect((await cast.outsider.request('GET', `${base(cast)}/tracks/class-a`)).status).toBe(404);
      expect((await cast.outsider.request('GET', problemUrl(cast.slug, 'p1'))).status).toBe(404);
    });

    it('only the staff manage members: solvers and non-members are refused', async () => {
      const cast = await castSpace(t, { visibility: 'public' });
      await closedTrack(cast);
      const observer = await addMember(cast, 'olga', 'observer');
      for (const client of [cast.solver, cast.outsider, observer]) {
        expect((await inviteTo(cast, client)).status).toBe(403);
        expect(
          (await client.request('DELETE', `${base(cast)}/tracks/class-a/members/otto`)).status
        ).toBe(403);
      }
      // an observer may look
      expect((await observer.request('GET', `${base(cast)}/tracks/class-a/members`)).status).toBe(
        200
      );
      expect((await observer.request('GET', `${base(cast)}/tracks/class-a/invites`)).status).toBe(
        200
      );
      for (const client of [cast.solver, cast.outsider]) {
        expect((await client.request('GET', `${base(cast)}/tracks/class-a/members`)).status).toBe(
          403
        );
      }
      expect((await inviteTo(cast, cast.visitor)).status).toBe(401);
    });

    it('invitations to a Track and to the Space are kept apart', async () => {
      const cast = await castSpace(t);
      await closedTrack(cast);
      const trackInvite = await inviteTo(cast, cast.owner);
      const spaceInvite = await cast.owner.request('POST', `${base(cast)}/invites`, {
        role: 'solver',
      });
      const spaceList = await cast.owner.request('GET', `${base(cast)}/invites`);
      expect(spaceList.body.items.map((item: { id: string }) => item.id)).toEqual([
        spaceInvite.body.id,
      ]);
      // the Space's list cannot revoke a Track invitation, nor the Track's a Space one
      expect(
        (await cast.owner.request('DELETE', `${base(cast)}/invites/${trackInvite.body.id}`)).status
      ).toBe(404);
      expect(
        (
          await cast.owner.request(
            'DELETE',
            `${base(cast)}/tracks/class-a/invites/${spaceInvite.body.id}`
          )
        ).status
      ).toBe(404);
      // a pending invitation to the Space does not block one to the Track
      const person = await t.login({
        providerAccountId: 'z',
        email: 'z@example.com',
        usernameHint: 'zed',
      });
      await cast.owner.request('POST', `${base(cast)}/invites`, {
        role: 'solver',
        username: 'zed',
      });
      expect((await inviteTo(cast, cast.owner, { username: 'zed' })).status).toBe(201);
      expect(person).toBeTruthy();
    });

    it('records who invited, revoked and removed whom', async () => {
      const cast = await castSpace(t);
      await closedTrack(cast);
      const invite = await inviteTo(cast, cast.editor, { username: 'otto' });
      await cast.editor.request('DELETE', `${base(cast)}/tracks/class-a/invites/${invite.body.id}`);
      const second = await inviteTo(cast, cast.owner, { username: 'otto' });
      await cast.outsider.request('POST', `/api/v1/invites/${second.body.token}/accept`);
      await cast.owner.request('DELETE', `${base(cast)}/tracks/class-a/members/otto`);

      const events = await t.prisma.auditEvent.findMany({
        orderBy: { created_at: 'asc' },
        include: { actor: true, target_user: true },
      });
      expect(
        events.map((event) => [event.action, event.actor.username, event.target_user?.username])
      ).toEqual([
        ['track.invite_created', 'edith', 'otto'],
        ['track.invite_revoked', 'edith', 'otto'],
        ['track.invite_created', 'olivia', 'otto'],
        ['track.member_joined', 'otto', 'otto'],
        ['track.member_removed', 'olivia', 'otto'],
      ]);
      // the secret token never reaches the log
      expect(JSON.stringify(events)).not.toContain(second.body.token);
    });
  });

  describe('progression (GRD-82)', () => {
    async function twoProblems() {
      const cast = await castSpace(t);
      await createPublishedProblem(cast, 'p1');
      await createPublishedProblem(cast, 'p2');
      await createPublishedProblem(cast, 'p3');
      return cast;
    }

    it('counts a problem as passed after one accepted submission, in the Track and its Collections', async () => {
      const cast = await twoProblems();
      await record('sol', 'p1', 'WA');
      await record('sol', 'p1', 'AC');
      await record('sol', 'p1', 'WA'); // later failures do not undo it
      await record('sol', 'p2', 'WA');
      const track = await cast.solver.request('GET', `${base(cast)}/tracks/general`);
      expect(track.body.progress).toEqual({ solved: 1, total: 3 });
      expect(track.body.collections[0].progress).toEqual({ solved: 1, total: 3 });
      const problems = track.body.collections[0].problems;
      expect(problems[0].my_result).toEqual({ solved: true, last_verdict: 'WA' });
      expect(problems[1].my_result).toEqual({ solved: false, last_verdict: 'WA' });
      expect(problems[2].my_result).toEqual({ solved: false, last_verdict: null });

      const list = await cast.solver.request('GET', `${base(cast)}/tracks`);
      expect(list.body.items[0]).toMatchObject({ progress: { solved: 1, total: 3 } });
      const collection = await cast.solver.request('GET', `${base(cast)}/collections/main`);
      expect(collection.body.progress).toEqual({ solved: 1, total: 3 });
    });

    it('counts only published problems in the total', async () => {
      const cast = await twoProblems();
      await createDraft(cast.editor, cast.slug, 'wip');
      await cast.owner.request('PATCH', `${base(cast)}/collections/main/problems`, {
        add: ['wip'],
      });
      await cast.owner.request('POST', problemUrl(cast.slug, 'p3', '/archive'));
      const track = await cast.solver.request('GET', `${base(cast)}/tracks/general`);
      expect(track.body.progress).toEqual({ solved: 0, total: 2 });
    });

    it('counts a problem once even when it is in two Collections of the Track', async () => {
      const cast = await twoProblems();
      await cast.owner.request('POST', `${base(cast)}/collections`, {
        name: 'Again',
        slug: 'again',
      });
      await cast.owner.request('PATCH', `${base(cast)}/collections/again/problems`, {
        add: ['p1'],
      });
      await cast.owner.request('PUT', `${base(cast)}/tracks/general/collections`, {
        collection_slugs: ['main', 'again'],
      });
      await record('sol', 'p1');
      const track = await cast.solver.request('GET', `${base(cast)}/tracks/general`);
      expect(track.body.progress).toEqual({ solved: 1, total: 3 });
      expect(track.body.collections.map((c: { progress: object }) => c.progress)).toEqual([
        { solved: 1, total: 3 },
        { solved: 1, total: 1 },
      ]);
    });

    it('a problem taken out of the Collection leaves the divisor, and an archived Collection leaves the Track’s count', async () => {
      const cast = await twoProblems();
      await record('sol', 'p1');
      await cast.owner.request('PATCH', `${base(cast)}/collections/main/problems`, {
        remove: ['p3'],
      });
      expect(
        (await cast.solver.request('GET', `${base(cast)}/tracks/general`)).body.progress
      ).toEqual({ solved: 1, total: 2 });
      await cast.owner.request('DELETE', `${base(cast)}/collections/main`);
      expect(
        (await cast.solver.request('GET', `${base(cast)}/tracks/general`)).body.progress
      ).toEqual({ solved: 0, total: 0 });
    });

    it('keeps what was earned when the problem gets a newer version', async () => {
      const cast = await twoProblems();
      await record('sol', 'p1');
      const problem = await t.prisma.problem.findFirstOrThrow({ where: { slug: 'p1' } });
      const version = await t.prisma.problemVersion.findUniqueOrThrow({
        where: { id: problem.current_version_id! },
      });
      const next = await t.prisma.problemVersion.create({
        data: {
          problem_id: problem.id,
          version_number: version.version_number + 1,
          status: 'published',
          published_at: new Date(),
          title: version.title,
          statement: version.statement,
          time_limit_ms: version.time_limit_ms,
          memory_limit_kb: version.memory_limit_kb,
          allowed_languages: version.allowed_languages,
        },
      });
      await t.prisma.problem.update({
        where: { id: problem.id },
        data: { current_version_id: next.id },
      });
      const track = await cast.solver.request('GET', `${base(cast)}/tracks/general`);
      expect(track.body.progress).toEqual({ solved: 1, total: 3 });
    });

    it('is personal: another solver’s result does not count for me', async () => {
      const cast = await twoProblems();
      const lena = await addMember(cast, 'lena', 'solver');
      await record('lena', 'p1');
      await record('lena', 'p2');
      expect(
        (await cast.solver.request('GET', `${base(cast)}/tracks/general`)).body.progress
      ).toEqual({ solved: 0, total: 3 });
      expect((await lena.request('GET', `${base(cast)}/tracks/general`)).body.progress).toEqual({
        solved: 2,
        total: 3,
      });
    });

    it('lets the staff see everybody’s progression, and nobody else', async () => {
      const cast = await twoProblems();
      const lena = await addMember(cast, 'lena', 'solver');
      const observer = await addMember(cast, 'olga', 'observer');
      await record('lena', 'p1');
      await record('lena', 'p2');
      await record('sol', 'p1');
      for (const client of [cast.owner, cast.editor, observer]) {
        const response = await client.request('GET', `${base(cast)}/tracks/general/progress`);
        expect(response.status).toBe(200);
        expect(response.body.total).toBe(3);
        expect(
          response.body.items.map((item: { user: { username: string }; solved: number }) => [
            item.user.username,
            item.solved,
          ])
        ).toEqual([
          ['lena', 2],
          ['sol', 1],
        ]);
      }
      for (const client of [cast.solver, lena, cast.outsider]) {
        expect([403, 404]).toContain(
          (await client.request('GET', `${base(cast)}/tracks/general/progress`)).status
        );
      }
      expect(
        (await cast.visitor.request('GET', `${base(cast)}/tracks/general/progress`)).status
      ).toBe(401);
    });

    it('for a members-only Track the list is its members', async () => {
      const cast = await twoProblems();
      await cast.owner.request('POST', `${base(cast)}/tracks`, {
        name: 'Class A',
        slug: 'class-a',
        privacy: 'members',
      });
      await cast.owner.request('PUT', `${base(cast)}/tracks/class-a/collections`, {
        collection_slugs: ['main'],
      });
      const invite = await cast.owner.request('POST', `${base(cast)}/tracks/class-a/invites`, {});
      await cast.outsider.request('POST', `/api/v1/invites/${invite.body.token}/accept`);
      await record('otto', 'p1');
      const response = await cast.owner.request('GET', `${base(cast)}/tracks/class-a/progress`);
      expect(
        response.body.items.map((item: { user: { username: string }; solved: number }) => [
          item.user.username,
          item.solved,
        ])
      ).toEqual([['otto', 1]]);
    });
  });
});
