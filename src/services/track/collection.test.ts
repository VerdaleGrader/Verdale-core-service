import {
  Cast,
  HIDDEN,
  addTest,
  castSpace,
  createDraft,
  createPublishedProblem,
  problemUrl,
} from '@/test/fixtures';
import { createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

describeDb('Collections (GRD-77, 79)', () => {
  let t: TestApp;
  let cast: Cast;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    cast = await castSpace(t);
  });
  afterEach(async () => t.close());

  const space = '/api/v1/spaces/team';
  const collections = `${space}/collections`;
  const tracks = `${space}/tracks`;
  const slugs = (items: Array<{ slug: string }>) => items.map((item) => item.slug);

  const newCollection = (slug: string, track_slugs: string[] = []) =>
    cast.editor.request('POST', collections, { name: slug.toUpperCase(), slug, track_slugs });

  describe('creating and editing', () => {
    it('owners and editors create a Collection with a name, slug and description', async () => {
      for (const who of ['owner', 'editor'] as const) {
        const created = await cast[who].request('POST', collections, {
          name: `By ${who}`,
          slug: `by-${who}`,
          description: 'Warm-up',
        });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({
          slug: `by-${who}`,
          name: `By ${who}`,
          description: 'Warm-up',
          archived_at: null,
          problems: [],
          tracks: [],
        });
      }
    });

    it('may sit in no Track, and may be put in Tracks when created', async () => {
      const loose = await newCollection('loose');
      expect(loose.body.tracks).toEqual([]);
      const placed = await newCollection('placed', ['general']);
      expect(placed.body.tracks).toMatchObject([{ slug: 'general', position: 1 }]);
      const track = await cast.owner.request('GET', `${tracks}/general`);
      expect(slugs(track.body.collections)).toEqual(['placed']);
    });

    it('refuses a Track that does not exist and creates nothing', async () => {
      const response = await newCollection('x1', ['nope']);
      expect(response.status).toBe(400);
      expect(response.body.details[0].field).toBe('track_slugs');
      expect((await cast.owner.request('GET', `${collections}/x1`)).status).toBe(404);
    });

    it('slugs are unique inside the Space and validated', async () => {
      await newCollection('dup');
      expect((await newCollection('DUP')).status).toBe(409);
      for (const slug of ['A', 'a', 'new', 'problems', 'a b']) {
        expect((await newCollection(slug)).status).toBe(400);
      }
      expect((await cast.owner.request('POST', collections, { slug: 'abc' })).status).toBe(400);
    });

    it('can be edited and its slug changed', async () => {
      await newCollection('first');
      await newCollection('second');
      const edited = await cast.owner.request('PATCH', `${collections}/first`, {
        name: 'New name',
        description: 'New text',
      });
      expect(edited.body).toMatchObject({ name: 'New name', description: 'New text' });
      expect(
        (await cast.owner.request('PATCH', `${collections}/first`, { slug: 'second' })).status
      ).toBe(409);
      expect(
        (await cast.owner.request('PATCH', `${collections}/first`, { slug: 'renamed' })).body.slug
      ).toBe('renamed');
      expect((await cast.owner.request('PATCH', `${collections}/renamed`, {})).status).toBe(400);
    });

    it('archive and restore keep everything inside', async () => {
      await newCollection('keep', ['general']);
      await createDraft(cast.editor, 'team', 'dr1');
      await cast.editor.request('POST', `${collections}/keep/problems`, { problem_slugs: ['dr1'] });
      const archived = await cast.owner.request('POST', `${collections}/keep/archive`);
      expect(archived.body.archived_at).not.toBeNull();
      expect(slugs(archived.body.problems)).toEqual(['dr1']);
      const restored = await cast.owner.request('POST', `${collections}/keep/restore`);
      expect(restored.body.archived_at).toBeNull();
      expect(slugs(restored.body.problems)).toEqual(['dr1']);
    });
  });

  describe('permissions', () => {
    beforeEach(async () => {
      await newCollection('c-one', ['general']);
    });

    it('a solver cannot create, change, archive or list all Collections', async () => {
      expect(
        (await cast.solver.request('POST', collections, { name: 'x', slug: 'xx' })).status
      ).toBe(403);
      expect(
        (await cast.solver.request('PATCH', `${collections}/c-one`, { name: 'y' })).status
      ).toBe(403);
      expect((await cast.solver.request('POST', `${collections}/c-one/archive`)).status).toBe(403);
      expect(
        (
          await cast.solver.request('POST', `${collections}/c-one/problems`, {
            problem_slugs: ['a1'],
          })
        ).status
      ).toBe(403);
      expect((await cast.solver.request('GET', collections)).status).toBe(403);
    });

    it('outsiders and visitors get 404 for a private Space and 401 when they must log in', async () => {
      expect(
        (await cast.outsider.request('POST', collections, { name: 'x', slug: 'xx' })).status
      ).toBe(404);
      expect(
        (await cast.visitor.request('POST', collections, { name: 'x', slug: 'xx' })).status
      ).toBe(401);
      expect((await cast.outsider.request('GET', `${collections}/c-one`)).status).toBe(404);
    });

    it('an archived Space is read-only', async () => {
      await cast.owner.request('POST', `${space}/archive`);
      expect(
        (await cast.owner.request('POST', collections, { name: 'x', slug: 'xx' })).status
      ).toBe(403);
      expect(
        (await cast.owner.request('PATCH', `${collections}/c-one`, { name: 'y' })).status
      ).toBe(403);
    });

    it('owners and editors list every Collection, in a Track or not', async () => {
      await newCollection('c-two');
      const list = await cast.editor.request('GET', collections);
      expect(list.status).toBe(200);
      expect(slugs(list.body.items).sort()).toEqual(['c-one', 'c-two']);
    });
  });

  describe('problems in a Collection', () => {
    beforeEach(async () => {
      await newCollection('set', ['general']);
      for (const slug of ['p1', 'p2', 'p3']) await createDraft(cast.editor, 'team', slug);
    });

    const add = (problem_slugs: string[], collection = 'set') =>
      cast.editor.request('POST', `${collections}/${collection}/problems`, { problem_slugs });
    const remove = (problem_slugs: string[], collection = 'set') =>
      cast.editor.request('POST', `${collections}/${collection}/problems/remove`, {
        problem_slugs,
      });
    const content = async (collection = 'set') =>
      slugs((await cast.owner.request('GET', `${collections}/${collection}`)).body.problems);

    it('adds several problems in one request, in the order given, at the end', async () => {
      expect((await add(['p3', 'p1'])).status).toBe(200);
      expect(await content()).toEqual(['p3', 'p1']);
      await add(['p2']);
      expect(await content()).toEqual(['p3', 'p1', 'p2']);
    });

    it('adding a problem that is already there changes nothing', async () => {
      await add(['p1', 'p2']);
      expect((await add(['p2', 'p1', 'p3'])).status).toBe(200);
      expect(await content()).toEqual(['p1', 'p2', 'p3']);
    });

    it('an unknown problem refuses the whole request', async () => {
      const response = await add(['p1', 'ghost']);
      expect(response.status).toBe(400);
      expect(response.body.details).toEqual([
        { field: 'problem_slugs', message: expect.stringContaining('ghost') },
      ]);
      expect(await content()).toEqual([]);
    });

    it('removes several problems in one request without deleting them, and closes the gap', async () => {
      await add(['p1', 'p2', 'p3']);
      expect((await remove(['p1', 'p3'])).status).toBe(200);
      expect(await content()).toEqual(['p2']);
      const link = await t.prisma.collectionProblem.findFirstOrThrow();
      expect(link.position).toBe(1);
      expect(await t.prisma.problem.count()).toBe(3);
      expect((await remove(['p1'])).status).toBe(200); // absent: ignored
    });

    it('takes the whole new order in one request', async () => {
      await add(['p1', 'p2', 'p3']);
      const items = (await cast.owner.request('GET', `${collections}/set`)).body.problems as Array<{
        id: string;
        slug: string;
      }>;
      const id = Object.fromEntries(items.map((item) => [item.slug, item.id]));
      const reordered = await cast.editor.request('POST', `${collections}/set/problems/reorder`, {
        problem_ids: [id.p3, id.p1, id.p2],
      });
      expect(reordered.status).toBe(200);
      expect(slugs(reordered.body.problems)).toEqual(['p3', 'p1', 'p2']);
      expect(reordered.body.problems.map((p: { position: number }) => p.position)).toEqual([
        1, 2, 3,
      ]);
    });

    it('refuses an order that misses, repeats or invents a problem', async () => {
      await add(['p1', 'p2']);
      const items = (await cast.owner.request('GET', `${collections}/set`)).body.problems as Array<{
        id: string;
      }>;
      const [a, b] = items.map((item) => item.id);
      for (const problem_ids of [[a], [a, a], [a, b, '11111111-1111-4111-8111-111111111111'], []]) {
        const response = await cast.editor.request('POST', `${collections}/set/problems/reorder`, {
          problem_ids,
        });
        expect(response.status).toBe(409);
        expect(response.body.error_code).toBe('ORDER_MISMATCH');
      }
      expect(await content()).toEqual(['p1', 'p2']);
    });

    it('a problem can be in many Collections', async () => {
      await newCollection('other');
      await add(['p1', 'p2']);
      await add(['p2', 'p3'], 'other');
      expect(await content()).toEqual(['p1', 'p2']);
      expect(await content('other')).toEqual(['p2', 'p3']);
      await remove(['p2'], 'other');
      expect(await content()).toEqual(['p1', 'p2']);
    });

    it('drafts can be added and carry a status mark for the managers', async () => {
      await add(['p1']);
      const detail = await cast.owner.request('GET', `${collections}/set`);
      expect(detail.body.problems[0]).toMatchObject({
        slug: 'p1',
        status: 'draft',
        title: 'Sum of two numbers',
      });
    });

    it('a Collection holds at most 200 problems', async () => {
      const spaceRow = await t.prisma.space.findUniqueOrThrow({ where: { slug: 'team' } });
      const set = await t.prisma.collection.findFirstOrThrow({ where: { slug: 'set' } });
      const base = await t.prisma.problem.findFirstOrThrow({ where: { slug: 'p1' } });
      const version = await t.prisma.problemVersion.findFirstOrThrow({
        where: { problem_id: base.id },
      });
      const user = await t.prisma.user.findFirstOrThrow({ where: { username: 'edith' } });
      const created = [];
      for (let index = 0; index < 200; index++) {
        created.push({
          space_id: spaceRow.id,
          created_by_id: user.id,
          slug: `bulk-${index}`,
        });
      }
      await t.prisma.problem.createMany({ data: created });
      const bulk = await t.prisma.problem.findMany({ where: { slug: { startsWith: 'bulk-' } } });
      await t.prisma.collectionProblem.createMany({
        data: bulk.map((problem, index) => ({
          collection_id: set.id,
          problem_id: problem.id,
          position: index + 1,
        })),
      });
      expect(version).toBeTruthy();
      const response = await add(['p1']);
      expect(response.status).toBe(409);
      expect(response.body.error_code).toBe('COLLECTION_FULL');
    });
  });

  describe('Collections in Tracks', () => {
    beforeEach(async () => {
      await cast.owner.request('POST', tracks, { name: 'Second', slug: 'second' });
      for (const slug of ['ca', 'cb', 'cc']) await newCollection(slug);
    });

    const addTo = (track: string, collection_slugs: string[]) =>
      cast.editor.request('POST', `${tracks}/${track}/collections`, { collection_slugs });
    const inTrack = async (track: string) =>
      slugs((await cast.owner.request('GET', `${tracks}/${track}`)).body.collections);

    it('adds and removes several at once, in order', async () => {
      expect((await addTo('general', ['cc', 'ca'])).status).toBe(200);
      expect(await inTrack('general')).toEqual(['cc', 'ca']);
      await addTo('general', ['cb', 'cc']);
      expect(await inTrack('general')).toEqual(['cc', 'ca', 'cb']);
      const removed = await cast.editor.request('POST', `${tracks}/general/collections/remove`, {
        collection_slugs: ['cc', 'cb'],
      });
      expect(removed.status).toBe(200);
      expect(await inTrack('general')).toEqual(['ca']);
    });

    it('one Collection can be in several Tracks, each with its own order', async () => {
      await addTo('general', ['ca', 'cb']);
      await addTo('second', ['cb', 'ca']);
      expect(await inTrack('general')).toEqual(['ca', 'cb']);
      expect(await inTrack('second')).toEqual(['cb', 'ca']);
      const detail = await cast.owner.request('GET', `${collections}/ca`);
      expect(detail.body.tracks.map((track: { slug: string }) => track.slug).sort()).toEqual([
        'general',
        'second',
      ]);
    });

    it('removing a Collection from a Track leaves it in the others and in the Space', async () => {
      await addTo('general', ['ca']);
      await addTo('second', ['ca']);
      await cast.editor.request('POST', `${tracks}/general/collections/remove`, {
        collection_slugs: ['ca'],
      });
      expect(await inTrack('second')).toEqual(['ca']);
      expect((await cast.owner.request('GET', `${collections}/ca`)).status).toBe(200);
    });

    it('takes the whole new order in one request', async () => {
      await addTo('general', ['ca', 'cb', 'cc']);
      const items = (await cast.owner.request('GET', `${tracks}/general`)).body
        .collections as Array<{
        id: string;
        slug: string;
      }>;
      const id = Object.fromEntries(items.map((item) => [item.slug, item.id]));
      const response = await cast.editor.request('POST', `${tracks}/general/collections/reorder`, {
        collection_ids: [id.cc, id.ca, id.cb],
      });
      expect(response.status).toBe(200);
      expect(slugs(response.body.collections)).toEqual(['cc', 'ca', 'cb']);
      const bad = await cast.editor.request('POST', `${tracks}/general/collections/reorder`, {
        collection_ids: [id.cc, id.ca],
      });
      expect(bad.status).toBe(409);
    });

    it('an unknown Collection or Track is refused', async () => {
      expect((await addTo('general', ['ghost'])).status).toBe(400);
      expect((await addTo('ghost', ['ca'])).status).toBe(404);
    });

    it('only owners and editors may change a Track’s Collections', async () => {
      expect(
        (
          await cast.solver.request('POST', `${tracks}/general/collections`, {
            collection_slugs: ['ca'],
          })
        ).status
      ).toBe(403);
      expect(
        (
          await cast.solver.request('POST', `${tracks}/general/collections/reorder`, {
            collection_ids: [],
          })
        ).status
      ).toBe(403);
    });
  });

  describe('database rules', () => {
    it('a Track and a Collection from different Spaces cannot be linked', async () => {
      await cast.owner.request('POST', '/api/v1/spaces', { name: 'Other', slug: 'other' });
      const other = await t.prisma.collection.create({
        data: {
          space_id: (await t.prisma.space.findUniqueOrThrow({ where: { slug: 'other' } })).id,
          name: 'Foreign',
          slug: 'foreign',
        },
      });
      const track = await t.prisma.track.findFirstOrThrow({
        where: { space: { slug: 'team' }, slug: 'general' },
      });
      await expect(
        t.prisma.trackCollection.create({
          data: { track_id: track.id, collection_id: other.id, position: 1 },
        })
      ).rejects.toThrow();
    });

    it('a problem from another Space cannot be put in a Collection', async () => {
      await cast.owner.request('POST', '/api/v1/spaces', { name: 'Other', slug: 'other' });
      await createDraft(cast.owner, 'other', 'alien');
      await newCollection('mine');
      const collection = await t.prisma.collection.findFirstOrThrow({ where: { slug: 'mine' } });
      const alien = await t.prisma.problem.findFirstOrThrow({ where: { slug: 'alien' } });
      await expect(
        t.prisma.collectionProblem.create({
          data: { collection_id: collection.id, problem_id: alien.id, position: 1 },
        })
      ).rejects.toThrow();
      const response = await cast.editor.request('POST', `${collections}/mine/problems`, {
        problem_slugs: ['alien'],
      });
      expect(response.status).toBe(400); // not a problem of this Space
    });

    it('a link cannot appear twice and positions start at 1', async () => {
      await newCollection('dupes');
      await createDraft(cast.editor, 'team', 'pp');
      await cast.editor.request('POST', `${collections}/dupes/problems`, { problem_slugs: ['pp'] });
      const link = await t.prisma.collectionProblem.findFirstOrThrow();
      await expect(
        t.prisma.collectionProblem.create({
          data: { collection_id: link.collection_id, problem_id: link.problem_id, position: 2 },
        })
      ).rejects.toThrow();
      await expect(
        t.prisma.collectionProblem.update({
          where: {
            collection_id_problem_id: {
              collection_id: link.collection_id,
              problem_id: link.problem_id,
            },
          },
          data: { position: 0 },
        })
      ).rejects.toThrow();
    });

    it('deleting a Collection or a Track never deletes problems; deleting a problem drops its links', async () => {
      await newCollection('gone', ['general']);
      await createDraft(cast.editor, 'team', 'stays');
      await cast.editor.request('POST', `${collections}/gone/problems`, {
        problem_slugs: ['stays'],
      });
      await t.prisma.collection.deleteMany({ where: { slug: 'gone' } });
      expect(await t.prisma.problem.count({ where: { slug: 'stays' } })).toBe(1);
      expect(await t.prisma.collectionProblem.count()).toBe(0);
      await newCollection('again', ['general']);
      await cast.editor.request('POST', `${collections}/again/problems`, {
        problem_slugs: ['stays'],
      });
      const del = await cast.editor.request('DELETE', problemUrl('team', 'stays'));
      expect(del.status).toBe(204);
      expect(await t.prisma.collectionProblem.count()).toBe(0);
      expect(await t.prisma.collection.count({ where: { slug: 'again' } })).toBe(1);
    });
  });

  describe('what solvers see of a Collection (GRD-79)', () => {
    beforeEach(async () => {
      await createPublishedProblem(cast, 'live', {}, { placed: false });
      await createDraft(cast.editor, 'team', 'wip');
      await addTest(cast.editor, 'team', 'wip', HIDDEN.input, HIDDEN.output);
    });

    it('a Collection in no Track does not exist for solvers', async () => {
      await newCollection('loose');
      await cast.editor.request('POST', `${collections}/loose/problems`, {
        problem_slugs: ['live'],
      });
      expect((await cast.solver.request('GET', `${collections}/loose`)).status).toBe(404);
      expect((await cast.editor.request('GET', `${collections}/loose`)).status).toBe(200);
    });

    it('a Collection in a Track shows solvers its published problems only', async () => {
      await newCollection('shown', ['general']);
      await cast.editor.request('POST', `${collections}/shown/problems`, {
        problem_slugs: ['live', 'wip'],
      });
      const solver = await cast.solver.request('GET', `${collections}/shown`);
      expect(solver.status).toBe(200);
      expect(slugs(solver.body.problems)).toEqual(['live']);
      expect(solver.body.problem_count).toBe(1);
      expect(solver.body.tracks).toBeNull(); // not for solvers
      const editor = await cast.editor.request('GET', `${collections}/shown`);
      expect(slugs(editor.body.problems)).toEqual(['live', 'wip']);
      expect(editor.body.problems[1].status).toBe('draft');
    });

    it('an archived Collection is hidden from solvers', async () => {
      await newCollection('old', ['general']);
      await cast.owner.request('POST', `${collections}/old/archive`);
      expect((await cast.solver.request('GET', `${collections}/old`)).status).toBe(404);
      const track = await cast.solver.request('GET', `${tracks}/general`);
      expect(slugs(track.body.collections)).toEqual([]);
      const manager = await cast.editor.request('GET', `${tracks}/general`);
      expect(slugs(manager.body.collections)).toEqual(['old']);
    });

    it('a Collection in a members-only Track only is hidden from solvers who are not in it', async () => {
      await cast.owner.request('POST', tracks, {
        name: 'Closed',
        slug: 'closed',
        visibility: 'members',
      });
      await newCollection('closed-set', ['closed']);
      expect((await cast.solver.request('GET', `${collections}/closed-set`)).status).toBe(404);
      await newCollection('both', ['closed', 'general']); // also in an open Track
      expect((await cast.solver.request('GET', `${collections}/both`)).status).toBe(200);
    });

    it('no response to a solver carries a hidden test or a solution', async () => {
      await newCollection('shown', ['general']);
      await cast.editor.request('POST', `${collections}/shown/problems`, {
        problem_slugs: ['live', 'wip'],
      });
      for (const url of [`${collections}/shown`, `${tracks}/general`, tracks]) {
        const text = JSON.stringify((await cast.solver.request('GET', url)).body);
        expect(text).not.toContain(HIDDEN.input.trim());
        expect(text).not.toContain('sha256');
        expect(text).not.toContain('source');
      }
    });
  });
});
