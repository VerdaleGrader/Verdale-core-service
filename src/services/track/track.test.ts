import { Cast, castSpace } from '@/test/fixtures';
import { createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

describeDb('Tracks (GRD-77, 78)', () => {
  let t: TestApp;
  let cast: Cast;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    cast = await castSpace(t);
  });
  afterEach(async () => t.close());

  const base = '/api/v1/spaces/team/tracks';
  const slugsOf = (body: { items: Array<{ slug: string }> }) => body.items.map((item) => item.slug);

  describe('the starter Track', () => {
    it('every Space starts with a Track called General', async () => {
      const list = await cast.owner.request('GET', base);
      expect(list.status).toBe(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({
        slug: 'general',
        name: 'General',
        position: 1,
        visibility: 'space',
        archived_at: null,
        collection_count: 0,
        problem_count: 0,
      });
    });

    it('the personal Space made at sign-up has one too', async () => {
      const personal = await cast.owner.request('GET', '/api/v1/spaces/olivia/tracks');
      expect(personal.status).toBe(200);
      expect(slugsOf(personal.body)).toEqual(['general']);
    });

    it('the starter Track can be named when the Space is created', async () => {
      const created = await cast.owner.request('POST', '/api/v1/spaces', {
        name: 'Course',
        slug: 'course',
        track_name: 'Week 1',
      });
      expect(created.status).toBe(201);
      const list = await cast.owner.request('GET', '/api/v1/spaces/course/tracks');
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({ slug: 'general', name: 'Week 1' });
    });

    it('can be renamed', async () => {
      const renamed = await cast.owner.request('PATCH', `${base}/general`, { name: 'Basics' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.name).toBe('Basics');
    });

    it('validates the starter Track name', async () => {
      for (const track_name of ['', '   ', 'x'.repeat(81), 'two\nlines']) {
        const response = await cast.owner.request('POST', '/api/v1/spaces', {
          name: 'Course',
          slug: 'course',
          track_name,
        });
        expect(response.status).toBe(400);
        expect(response.body.details[0].field).toBe('track_name');
      }
    });
  });

  describe('who may manage Tracks', () => {
    const body = { name: 'Week 2', slug: 'week-2' };

    it.each(['owner', 'editor'] as const)(
      'the %s can create, edit, archive and restore',
      async (who) => {
        const client = cast[who];
        const created = await client.request('POST', base, body);
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({ slug: 'week-2', name: 'Week 2', position: 2 });
        expect(
          (await client.request('PATCH', `${base}/week-2`, { description: 'Loops' })).body
            .description
        ).toBe('Loops');
        expect(
          (await client.request('POST', `${base}/week-2/archive`)).body.archived_at
        ).not.toBeNull();
        expect(
          (await client.request('POST', `${base}/week-2/restore`)).body.archived_at
        ).toBeNull();
      }
    );

    it('a solver gets 403, an outsider 404 in a private Space, a visitor 401', async () => {
      expect((await cast.solver.request('POST', base, body)).status).toBe(403);
      expect((await cast.outsider.request('POST', base, body)).status).toBe(404);
      expect((await cast.visitor.request('POST', base, body)).status).toBe(401);
      expect((await cast.solver.request('PATCH', `${base}/general`, { name: 'x' })).status).toBe(
        403
      );
      expect((await cast.solver.request('POST', `${base}/general/archive`)).status).toBe(403);
      expect((await cast.solver.request('POST', `${base}/reorder`, { track_ids: [] })).status).toBe(
        403
      );
    });

    it('an archived Space is read-only for Tracks', async () => {
      await cast.owner.request('POST', '/api/v1/spaces/team/archive');
      expect((await cast.owner.request('POST', base, body)).status).toBe(403);
      expect((await cast.owner.request('PATCH', `${base}/general`, { name: 'x' })).status).toBe(
        403
      );
      expect((await cast.owner.request('GET', base)).status).toBe(200);
    });
  });

  describe('creating and editing', () => {
    it('validates name, slug and visibility', async () => {
      const bad = [
        { slug: 'ok-slug' },
        { name: '', slug: 'ok-slug' },
        { name: 'x'.repeat(81), slug: 'ok-slug' },
        { name: 'A\u0000B', slug: 'ok-slug' },
        { name: 'A', slug: '' },
        { name: 'A', slug: 'ok-slug', visibility: 'friends' },
        { name: 'A', slug: 'ok-slug', description: 'x'.repeat(501) },
      ];
      for (const payload of bad) {
        expect((await cast.owner.request('POST', base, payload)).status).toBe(400);
      }
      for (const slug of ['A', '-ab', 'a b', 'a/b', 'new', 'settings', 'members', 'x'.repeat(65)]) {
        const response = await cast.owner.request('POST', base, { name: 'A', slug });
        expect(response.status).toBe(400);
        expect(response.body.details[0].field).toBe('slug');
      }
    });

    it('slugs are unique inside a Space, not across Spaces, and upper case is folded', async () => {
      expect((await cast.owner.request('POST', base, { name: 'A', slug: 'dup' })).status).toBe(201);
      expect((await cast.owner.request('POST', base, { name: 'B', slug: 'DUP' })).status).toBe(409);
      expect((await cast.owner.request('POST', base, { name: 'B', slug: 'general' })).status).toBe(
        409
      );
      await cast.owner.request('POST', '/api/v1/spaces', { name: 'Other', slug: 'other' });
      expect(
        (
          await cast.owner.request('POST', '/api/v1/spaces/other/tracks', {
            name: 'A',
            slug: 'dup',
          })
        ).status
      ).toBe(201);
    });

    it('changing a slug checks it is free and keeps the Track', async () => {
      await cast.owner.request('POST', base, { name: 'A', slug: 'aaa' });
      expect((await cast.owner.request('PATCH', `${base}/aaa`, { slug: 'general' })).status).toBe(
        409
      );
      const moved = await cast.owner.request('PATCH', `${base}/aaa`, { slug: 'bbb' });
      expect(moved.status).toBe(200);
      expect(moved.body.slug).toBe('bbb');
      expect((await cast.owner.request('GET', `${base}/aaa`)).status).toBe(404);
    });

    it('an empty change is refused', async () => {
      expect((await cast.owner.request('PATCH', `${base}/general`, {})).status).toBe(400);
    });

    it('a Space holds at most 50 Tracks', async () => {
      const space = await t.prisma.space.findUniqueOrThrow({ where: { slug: 'team' } });
      await t.prisma.track.createMany({
        data: Array.from({ length: 49 }, (_, index) => ({
          space_id: space.id,
          name: `T${index}`,
          slug: `t-${index}`,
          position: index + 2,
        })),
      });
      const response = await cast.owner.request('POST', base, {
        name: 'One too many',
        slug: 'last',
      });
      expect(response.status).toBe(409);
      expect(response.body.error_code).toBe('TRACK_LIMIT');
    });
  });

  describe('order', () => {
    beforeEach(async () => {
      for (const slug of ['tb', 'tc', 'td']) {
        await cast.owner.request('POST', base, { name: slug.toUpperCase(), slug });
      }
    });

    it('new Tracks go to the end', async () => {
      expect(slugsOf((await cast.owner.request('GET', base)).body)).toEqual([
        'general',
        'tb',
        'tc',
        'td',
      ]);
    });

    it('takes the whole new order in one request', async () => {
      const list = (await cast.owner.request('GET', base)).body.items as Array<{
        id: string;
        slug: string;
      }>;
      const byslug = Object.fromEntries(list.map((track) => [track.slug, track.id]));
      const reordered = await cast.editor.request('POST', `${base}/reorder`, {
        track_ids: [byslug.td, byslug.general, byslug.tc, byslug.tb],
      });
      expect(reordered.status).toBe(200);
      expect(slugsOf(reordered.body)).toEqual(['td', 'general', 'tc', 'tb']);
      expect(reordered.body.items.map((item: { position: number }) => item.position)).toEqual([
        1, 2, 3, 4,
      ]);
      expect(slugsOf((await cast.solver.request('GET', base)).body)).toEqual([
        'td',
        'general',
        'tc',
        'tb',
      ]);
    });

    it('refuses a missing, repeated or foreign Track and changes nothing', async () => {
      const list = (await cast.owner.request('GET', base)).body.items as Array<{ id: string }>;
      const ids = list.map((track) => track.id);
      const stranger = '11111111-1111-4111-8111-111111111111';
      for (const track_ids of [ids.slice(1), [...ids, ids[0]], [...ids.slice(1), stranger], []]) {
        const response = await cast.owner.request('POST', `${base}/reorder`, { track_ids });
        expect(response.status).toBe(409);
        expect(response.body.error_code).toBe('ORDER_MISMATCH');
      }
      expect(
        (await cast.owner.request('POST', `${base}/reorder`, { track_ids: ['nope'] })).status
      ).toBe(400);
      expect(slugsOf((await cast.owner.request('GET', base)).body)).toEqual([
        'general',
        'tb',
        'tc',
        'td',
      ]);
    });

    it('archiving keeps the order of the others and restoring puts the Track last', async () => {
      await cast.owner.request('POST', `${base}/tb/archive`);
      const afterArchive = (await cast.owner.request('GET', base)).body;
      expect(slugsOf(afterArchive)).toEqual(['general', 'tc', 'td', 'tb']); // archived ones come last for managers
      expect(
        (await cast.solver.request('GET', base)).body.items.map((i: { slug: string }) => i.slug)
      ).toEqual(['general', 'tc', 'td']);
      const restored = await cast.owner.request('POST', `${base}/tb/restore`);
      expect(restored.body.position).toBe(4);
      expect(slugsOf((await cast.owner.request('GET', base)).body)).toEqual([
        'general',
        'tc',
        'td',
        'tb',
      ]);
    });
  });

  describe('privacy (two levels)', () => {
    beforeEach(async () => {
      await cast.owner.request('POST', base, {
        name: 'Secret',
        slug: 'secret',
        visibility: 'members',
      });
    });

    it('a Track open to the Space is seen by every member', async () => {
      for (const who of ['solver', 'editor', 'owner'] as const) {
        expect(slugsOf((await cast[who].request('GET', base)).body)).toContain('general');
      }
    });

    it('a members-only Track is hidden from solvers (404 by URL) but not from owners and editors', async () => {
      expect(slugsOf((await cast.solver.request('GET', base)).body)).toEqual(['general']);
      expect((await cast.solver.request('GET', `${base}/secret`)).status).toBe(404);
      for (const who of ['owner', 'editor'] as const) {
        expect(slugsOf((await cast[who].request('GET', base)).body)).toEqual(['general', 'secret']);
        expect((await cast[who].request('GET', `${base}/secret`)).status).toBe(200);
      }
    });

    it('privacy can be switched in both directions', async () => {
      const opened = await cast.owner.request('PATCH', `${base}/secret`, { visibility: 'space' });
      expect(opened.body.visibility).toBe('space');
      expect((await cast.solver.request('GET', `${base}/secret`)).status).toBe(200);
      await cast.owner.request('PATCH', `${base}/secret`, { visibility: 'members' });
      expect((await cast.solver.request('GET', `${base}/secret`)).status).toBe(404);
    });

    it('an archived Track is invisible to solvers and visible to managers', async () => {
      await cast.owner.request('POST', `${base}/general/archive`);
      expect((await cast.solver.request('GET', `${base}/general`)).status).toBe(404);
      expect((await cast.editor.request('GET', `${base}/general`)).status).toBe(200);
    });

    it('people outside the Space never see Tracks, whatever their privacy', async () => {
      // A private Space does not exist for outsiders and visitors.
      for (const who of ['outsider', 'visitor'] as const) {
        expect((await cast[who].request('GET', base)).status).toBe(404);
        expect((await cast[who].request('GET', `${base}/general`)).status).toBe(404);
      }
    });

    it('in a public Space visitors see Tracks open to the Space, never members-only ones', async () => {
      const open = await castSpace(t, { visibility: 'public', slug: 'open' });
      await open.owner.request('POST', '/api/v1/spaces/open/tracks', {
        name: 'Hidden',
        slug: 'hidden',
        visibility: 'members',
      });
      for (const who of ['outsider', 'visitor'] as const) {
        const list = await open[who].request('GET', '/api/v1/spaces/open/tracks');
        expect(list.status).toBe(200);
        expect(slugsOf(list.body)).toEqual(['general']);
        expect((await open[who].request('GET', '/api/v1/spaces/open/tracks/hidden')).status).toBe(
          404
        );
      }
    });
  });

  describe('data model rules in the database', () => {
    it('refuses a duplicate slug, a malformed slug and a position below 1', async () => {
      const space = await t.prisma.space.findUniqueOrThrow({ where: { slug: 'team' } });
      const make = (data: object) =>
        t.prisma.track.create({
          data: { space_id: space.id, name: 'X', slug: 'x-1', position: 9, ...data },
        });
      await make({});
      await expect(make({})).rejects.toThrow();
      await expect(make({ slug: 'Bad Slug' })).rejects.toThrow();
      await expect(make({ slug: 'ok-2', position: 0 })).rejects.toThrow();
    });

    it('deleting a Space removes its Tracks and Collections', async () => {
      const space = await t.prisma.space.findUniqueOrThrow({ where: { slug: 'team' } });
      expect(await t.prisma.track.count({ where: { space_id: space.id } })).toBe(1);
      await t.prisma.space.delete({ where: { id: space.id } });
      expect(await t.prisma.track.count({ where: { space_id: space.id } })).toBe(0);
    });
  });
});
