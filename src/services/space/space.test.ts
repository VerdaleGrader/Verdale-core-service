import { createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

describeDb('Spaces (GRD-14, 16, 17, 19)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
  });
  afterEach(async () => t.close());

  const signUp = (name: string) =>
    t.login({ providerAccountId: name, email: `${name}@example.com`, usernameHint: name });

  describe('personal Space (GRD-16)', () => {
    it('exists the moment the account does, owned by the user', async () => {
      const ada = await signUp('ada');
      const { body } = await ada.request('GET', '/api/v1/spaces/ada');
      expect(body).toMatchObject({
        name: 'ada',
        slug: 'ada',
        is_personal: true,
        my_role: 'owner',
        archived_at: null,
        member_count: 1,
      });
    });

    it('is created in the signup transaction: if it fails, no user is left behind', async () => {
      // Block the personal Space from being created, then try to sign up.
      await t.prisma.$executeRawUnsafe(
        `CREATE FUNCTION fail_space() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END; $$ LANGUAGE plpgsql`
      );
      await t.prisma.$executeRawUnsafe(
        `CREATE TRIGGER fail_space BEFORE INSERT ON spaces FOR EACH ROW EXECUTE FUNCTION fail_space()`
      );
      try {
        await expect(signUp('ada')).rejects.toThrow();
        expect(await t.prisma.user.count()).toBe(0);
        expect(await t.prisma.oAuthAccount.count()).toBe(0);
        expect(await t.prisma.session.count()).toBe(0);
      } finally {
        await t.prisma.$executeRawUnsafe('DROP TRIGGER fail_space ON spaces');
        await t.prisma.$executeRawUnsafe('DROP FUNCTION fail_space()');
      }
    });

    it('cannot be archived', async () => {
      const ada = await signUp('ada');
      const response = await ada.request('POST', '/api/v1/spaces/ada/archive');
      expect(response.status).toBe(409);
      expect((await ada.request('GET', '/api/v1/spaces/ada')).body.archived_at).toBeNull();
    });

    it('cannot be deleted: there is no endpoint, and the database refuses too', async () => {
      const ada = await signUp('ada');
      expect((await ada.request('DELETE', '/api/v1/spaces/ada')).status).toBe(404);
      await expect(t.prisma.space.deleteMany({ where: { slug: 'ada' } })).rejects.toThrow(
        /personal Space cannot be deleted/
      );
      expect(await t.prisma.space.count()).toBe(1);
    });

    it('a user can have only one', async () => {
      await signUp('ada');
      const user = await t.prisma.user.findFirstOrThrow();
      await expect(
        t.prisma.space.create({
          data: { created_by_id: user.id, name: 'two', slug: 'two-personal', is_personal: true },
        })
      ).rejects.toThrow();
    });
  });

  describe('create (GRD-17)', () => {
    it('creates a Space with the creator as owner', async () => {
      const ada = await signUp('ada');
      const response = await ada.request('POST', '/api/v1/spaces', {
        name: ' Graph theory ',
        slug: 'Graph-Theory',
        description: 'BFS, DFS, shortest paths',
        visibility: 'public',
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        name: 'Graph theory',
        slug: 'graph-theory',
        description: 'BFS, DFS, shortest paths',
        visibility: 'public',
        is_personal: false,
        my_role: 'owner',
      });
      const membership = await t.prisma.membership.findFirstOrThrow({
        where: { space: { slug: 'graph-theory' } },
      });
      expect(membership.role).toBe('owner');
    });

    it('defaults to a private Space with an empty description', async () => {
      const ada = await signUp('ada');
      const response = await ada.request('POST', '/api/v1/spaces', {
        name: 'Notes',
        slug: 'notes',
      });
      expect(response.body).toMatchObject({ visibility: 'private', description: '' });
    });

    it('needs a login', async () => {
      const response = await t
        .anonymous()
        .request('POST', '/api/v1/spaces', { name: 'A', slug: 'abc' });
      expect(response.status).toBe(401);
    });

    it('rejects a duplicate slug (any letter case) and a slug that is a username', async () => {
      const ada = await signUp('ada');
      const grace = await signUp('grace');
      await ada.request('POST', '/api/v1/spaces', { name: 'Chess', slug: 'chess' });
      expect(
        (await grace.request('POST', '/api/v1/spaces', { name: 'X', slug: 'CHESS' })).status
      ).toBe(409);
      expect(
        (await grace.request('POST', '/api/v1/spaces', { name: 'X', slug: 'ada' })).status
      ).toBe(409);
      expect(await t.prisma.space.count({ where: { slug: 'chess' } })).toBe(1);
    });

    it.each([
      [{ name: '', slug: 'abc' }, 'name'],
      [{ name: 'x'.repeat(81), slug: 'abc' }, 'name'],
      [{ name: 'ok', slug: 'ab' }, 'slug'],
      [{ name: 'ok', slug: 'has space' }, 'slug'],
      [{ name: 'ok', slug: 'admin' }, 'slug'],
      [{ name: 'ok', slug: 'abc', visibility: 'secret' }, 'visibility'],
      [{ name: 'ok', slug: 'abc', description: 'x'.repeat(501) }, 'description'],
    ])('rejects %j with a clear error on %s', async (body, field) => {
      const ada = await signUp('ada');
      const response = await ada.request('POST', '/api/v1/spaces', body);
      expect(response.status).toBe(400);
      expect(response.body.error_code).toBe('VALIDATION_FAILED');
      expect(response.body.details.map((detail: { field: string }) => detail.field)).toContain(
        field
      );
    });
  });

  describe('read and edit', () => {
    it('only owners edit; editors and solvers get 403, outsiders get 404 on a private Space', async () => {
      const ada = await signUp('ada');
      const grace = await signUp('grace');
      const eve = await signUp('eve');
      await ada.request('POST', '/api/v1/spaces', { name: 'Team', slug: 'team' });
      const invite = await ada.request('POST', '/api/v1/spaces/team/invites', { role: 'editor' });
      await grace.request('POST', `/api/v1/invites/${invite.body.token}/accept`);

      expect((await grace.request('PATCH', '/api/v1/spaces/team', { name: 'Hijack' })).status).toBe(
        403
      );
      expect((await eve.request('PATCH', '/api/v1/spaces/team', { name: 'Hijack' })).status).toBe(
        404
      );
      expect(
        (await t.anonymous().request('PATCH', '/api/v1/spaces/team', { name: 'x' })).status
      ).toBe(401);

      const ok = await ada.request('PATCH', '/api/v1/spaces/team', {
        name: 'Team A',
        description: 'new',
      });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ name: 'Team A', description: 'new', slug: 'team' });
    });

    it('the slug cannot be changed', async () => {
      const ada = await signUp('ada');
      await ada.request('POST', '/api/v1/spaces', { name: 'Team', slug: 'team' });
      const response = await ada.request('PATCH', '/api/v1/spaces/team', {
        slug: 'other',
        name: 'T',
      });
      expect(response.status).toBe(200);
      expect(response.body.slug).toBe('team');
    });

    it('rejects an empty or invalid edit', async () => {
      const ada = await signUp('ada');
      await ada.request('POST', '/api/v1/spaces', { name: 'Team', slug: 'team' });
      expect((await ada.request('PATCH', '/api/v1/spaces/team', {})).status).toBe(400);
      expect((await ada.request('PATCH', '/api/v1/spaces/team', { name: '' })).status).toBe(400);
      expect((await ada.request('PATCH', '/api/v1/spaces/team', { visibility: 'x' })).status).toBe(
        400
      );
    });

    it('a public Space is readable by a visitor; a private one is not even acknowledged', async () => {
      const ada = await signUp('ada');
      await ada.request('POST', '/api/v1/spaces', {
        name: 'Open',
        slug: 'open',
        visibility: 'public',
      });
      await ada.request('POST', '/api/v1/spaces', { name: 'Closed', slug: 'closed' });
      const visitor = t.anonymous();
      const open = await visitor.request('GET', '/api/v1/spaces/open');
      expect(open.status).toBe(200);
      expect(open.body.my_role).toBeNull();
      expect(open.body.member_count).toBeUndefined();
      const closed = await visitor.request('GET', '/api/v1/spaces/closed');
      const missing = await visitor.request('GET', '/api/v1/spaces/does-not-exist');
      expect(closed.status).toBe(404);
      expect(closed.body.message).toBe(missing.body.message);
    });

    it('is case-insensitive in the URL', async () => {
      const ada = await signUp('ada');
      await ada.request('POST', '/api/v1/spaces', {
        name: 'Open',
        slug: 'open',
        visibility: 'public',
      });
      expect((await t.anonymous().request('GET', '/api/v1/spaces/OPEN')).status).toBe(200);
    });
  });

  describe('visibility change takes effect immediately', () => {
    it('public -> private hides it from visitors, other users and search', async () => {
      const ada = await signUp('ada');
      const grace = await signUp('grace');
      await ada.request('POST', '/api/v1/spaces', {
        name: 'Open',
        slug: 'open',
        visibility: 'public',
      });
      expect((await grace.request('GET', '/api/v1/spaces/open')).status).toBe(200);
      expect((await grace.request('GET', '/api/v1/spaces?q=open')).body.total).toBe(1);

      await ada.request('PATCH', '/api/v1/spaces/open', { visibility: 'private' });

      expect((await grace.request('GET', '/api/v1/spaces/open')).status).toBe(404);
      expect((await t.anonymous().request('GET', '/api/v1/spaces/open')).status).toBe(404);
      expect((await grace.request('GET', '/api/v1/spaces?q=open')).body.total).toBe(0);
      expect((await ada.request('GET', '/api/v1/spaces/open')).status).toBe(200);
    });

    it('members keep access after it goes private', async () => {
      const ada = await signUp('ada');
      const grace = await signUp('grace');
      await ada.request('POST', '/api/v1/spaces', {
        name: 'Open',
        slug: 'open',
        visibility: 'public',
      });
      const invite = await ada.request('POST', '/api/v1/spaces/open/invites', { role: 'solver' });
      await grace.request('POST', `/api/v1/invites/${invite.body.token}/accept`);
      await ada.request('PATCH', '/api/v1/spaces/open', { visibility: 'private' });
      expect((await grace.request('GET', '/api/v1/spaces/open')).body.my_role).toBe('solver');
    });
  });

  describe('archive', () => {
    it('owner only; keeps the Space readable, freezes it, and separates it from the main list', async () => {
      const ada = await signUp('ada');
      const grace = await signUp('grace');
      await ada.request('POST', '/api/v1/spaces', {
        name: 'Old',
        slug: 'old',
        visibility: 'public',
      });
      const invite = await ada.request('POST', '/api/v1/spaces/old/invites', { role: 'editor' });
      await grace.request('POST', `/api/v1/invites/${invite.body.token}/accept`);

      expect((await grace.request('POST', '/api/v1/spaces/old/archive')).status).toBe(403);
      expect((await t.anonymous().request('POST', '/api/v1/spaces/old/archive')).status).toBe(401);

      const archived = await ada.request('POST', '/api/v1/spaces/old/archive');
      expect(archived.status).toBe(200);
      expect(archived.body.archived_at).not.toBeNull();

      // still there for reading
      expect((await t.anonymous().request('GET', '/api/v1/spaces/old')).status).toBe(200);
      // settings and members are frozen
      expect((await ada.request('PATCH', '/api/v1/spaces/old', { name: 'x' })).status).toBe(403);
      expect(
        (await ada.request('POST', '/api/v1/spaces/old/invites', { role: 'solver' })).status
      ).toBe(403);

      const main = await ada.request('GET', '/api/v1/me/spaces');
      expect(main.body.items.map((space: { slug: string }) => space.slug)).toEqual(['ada']);
      const separate = await ada.request('GET', '/api/v1/me/spaces?archived=true');
      expect(separate.body.items.map((space: { slug: string }) => space.slug)).toEqual(['old']);
      expect((await t.anonymous().request('GET', '/api/v1/spaces')).body.total).toBe(0);
    });
  });

  describe('lists (GRD-19)', () => {
    it('shows my Spaces with my role, personal first', async () => {
      const ada = await signUp('ada');
      const grace = await signUp('grace');
      await grace.request('POST', '/api/v1/spaces', {
        name: 'Zed',
        slug: 'zed',
        visibility: 'public',
      });
      await ada.request('POST', '/api/v1/spaces', { name: 'Alpha', slug: 'alpha' });
      const invite = await grace.request('POST', '/api/v1/spaces/zed/invites', { role: 'solver' });
      await ada.request('POST', `/api/v1/invites/${invite.body.token}/accept`);

      const mine = await ada.request('GET', '/api/v1/me/spaces');
      expect(
        mine.body.items.map((space: { slug: string; my_role: string }) => [
          space.slug,
          space.my_role,
        ])
      ).toEqual([
        ['ada', 'owner'],
        ['alpha', 'owner'],
        ['zed', 'solver'],
      ]);
      expect((await t.anonymous().request('GET', '/api/v1/me/spaces')).status).toBe(401);
    });

    it('searches public Spaces by name, paginated, and never lists private ones', async () => {
      const ada = await signUp('ada');
      for (let index = 1; index <= 5; index++) {
        await ada.request('POST', '/api/v1/spaces', {
          name: `Algorithms ${index}`,
          slug: `algo-${index}`,
          visibility: 'public',
        });
      }
      await ada.request('POST', '/api/v1/spaces', {
        name: 'Algorithms secret',
        slug: 'algo-secret',
      });
      await ada.request('POST', '/api/v1/spaces', {
        name: 'Geometry',
        slug: 'geometry',
        visibility: 'public',
      });

      const visitor = t.anonymous();
      const firstPage = await visitor.request(
        'GET',
        '/api/v1/spaces?q=ALGORITHMS&page_size=2&page=1'
      );
      expect(firstPage.body).toMatchObject({ page: 1, page_size: 2, total: 5 });
      expect(firstPage.body.items.map((space: { name: string }) => space.name)).toEqual([
        'Algorithms 1',
        'Algorithms 2',
      ]);
      const lastPage = await visitor.request(
        'GET',
        '/api/v1/spaces?q=algorithms&page_size=2&page=3'
      );
      expect(lastPage.body.items.map((space: { name: string }) => space.name)).toEqual([
        'Algorithms 5',
      ]);

      const everything = await visitor.request('GET', '/api/v1/spaces?page_size=50');
      const slugs = everything.body.items.map((space: { slug: string }) => space.slug);
      expect(slugs).not.toContain('algo-secret');
      expect(slugs).not.toContain('ada');
      expect(everything.body.total).toBe(6);
    });

    it('a private Space does not leak through search by its slug either', async () => {
      const ada = await signUp('ada');
      await ada.request('POST', '/api/v1/spaces', { name: 'Hidden', slug: 'topsecret' });
      const grace = await signUp('grace');
      expect((await grace.request('GET', '/api/v1/spaces?q=topsecret')).body.total).toBe(0);
      expect((await grace.request('GET', '/api/v1/spaces?q=hidden')).body.total).toBe(0);
    });

    it('validates paging parameters', async () => {
      const visitor = t.anonymous();
      for (const query of ['page=0', 'page_size=0', 'page_size=51', 'page=abc']) {
        expect((await visitor.request('GET', `/api/v1/spaces?${query}`)).status).toBe(400);
      }
    });
  });
});
