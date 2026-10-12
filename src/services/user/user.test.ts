import { createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

describeDb('profile (GRD-12)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
  });
  afterEach(async () => t.close());

  const signUp = (name: string) =>
    t.login({ providerAccountId: name, email: `${name}@example.com`, usernameHint: name });

  it('shows and edits my own profile', async () => {
    const ada = await signUp('ada');
    const before = await ada.request('GET', '/api/v1/me');
    expect(before.body).toMatchObject({ username: 'ada', email: 'ada@example.com' });

    const after = await ada.request('PATCH', '/api/v1/me', { display_name: '  Ada L.  ' });
    expect(after.status).toBe(200);
    expect(after.body.display_name).toBe('Ada L.');
    expect((await ada.request('GET', '/api/v1/me')).body.display_name).toBe('Ada L.');
  });

  it('requires a login to read or edit the profile', async () => {
    const visitor = t.anonymous();
    expect((await visitor.request('GET', '/api/v1/me')).status).toBe(401);
    expect((await visitor.request('PATCH', '/api/v1/me', { display_name: 'x' })).status).toBe(401);
  });

  it('validates the display name', async () => {
    const ada = await signUp('ada');
    for (const display_name of ['', '   ', 'x'.repeat(65)]) {
      const response = await ada.request('PATCH', '/api/v1/me', { display_name });
      expect(response.status).toBe(400);
      expect(response.body.error_code).toBe('VALIDATION_FAILED');
    }
    expect((await ada.request('PATCH', '/api/v1/me', {})).status).toBe(400);
  });

  describe('username rules', () => {
    it.each(['ab', 'a'.repeat(33), '-leading', 'has space', 'dot.ted', 'ünicode', 'a/b'])(
      'rejects the invalid username %j',
      async (username) => {
        const ada = await signUp('ada');
        const response = await ada.request('PATCH', '/api/v1/me', { username });
        expect(response.status).toBe(400);
        expect(response.body.details[0].field).toBe('username');
      }
    );

    it.each(['admin', 'api', 'Verdale'])('rejects the reserved username %j', async (username) => {
      const ada = await signUp('ada');
      const response = await ada.request('PATCH', '/api/v1/me', { username });
      expect(response.status).toBe(400);
      expect(response.body.details[0].message).toMatch(/reserved/);
    });

    it.each(['abc', 'a-b_c', 'a'.repeat(32), '007'])('accepts %j', async (username) => {
      const ada = await signUp('ada');
      const response = await ada.request('PATCH', '/api/v1/me', { username });
      expect(response.status).toBe(200);
      expect(response.body.username).toBe(username);
    });

    it('is unique regardless of letter case', async () => {
      const ada = await signUp('ada');
      const grace = await signUp('grace');
      const clash = await grace.request('PATCH', '/api/v1/me', { username: 'ADA' });
      expect(clash.status).toBe(409);
      expect((await grace.request('GET', '/api/v1/me')).body.username).toBe('grace');
      // and the stored form is lower-case
      const renamed = await ada.request('PATCH', '/api/v1/me', { username: 'Ada-Byron' });
      expect(renamed.body.username).toBe('ada-byron');
    });

    it('cannot take the slug of an existing Space', async () => {
      const ada = await signUp('ada');
      const grace = await signUp('grace');
      await ada.request('POST', '/api/v1/spaces', { name: 'Chess', slug: 'chess' });
      const response = await grace.request('PATCH', '/api/v1/me', { username: 'chess' });
      expect(response.status).toBe(409);
    });

    it('keeping the same username is not a conflict', async () => {
      const ada = await signUp('ada');
      const response = await ada.request('PATCH', '/api/v1/me', {
        username: 'ADA',
        display_name: 'A',
      });
      expect(response.status).toBe(200);
    });

    it('moves the personal Space with the username, in one step', async () => {
      const ada = await signUp('ada');
      await ada.request('PATCH', '/api/v1/me', { username: 'countess' });
      const spaces = await ada.request('GET', '/api/v1/me/spaces');
      expect(spaces.body.items[0]).toMatchObject({
        slug: 'countess',
        name: 'countess',
        is_personal: true,
      });
      expect((await ada.request('GET', '/api/v1/spaces/ada')).status).toBe(404);
    });

    it('keeps a personal Space name the owner chose', async () => {
      const ada = await signUp('ada');
      await ada.request('PATCH', '/api/v1/spaces/ada', { name: 'Ada’s Puzzles' });
      await ada.request('PATCH', '/api/v1/me', { username: 'countess' });
      const space = await ada.request('GET', '/api/v1/spaces/countess');
      expect(space.body).toMatchObject({ slug: 'countess', name: 'Ada’s Puzzles' });
    });
  });

  describe('what other people can see', () => {
    it('is only username and display name, never the e-mail or id', async () => {
      await signUp('ada');
      const grace = await signUp('grace');
      for (const viewer of [grace, t.anonymous()]) {
        const response = await viewer.request('GET', '/api/v1/users/ada');
        expect(response.status).toBe(200);
        expect(Object.keys(response.body).sort()).toEqual(['display_name', 'username']);
      }
    });

    it('member lists expose the same two fields plus the role', async () => {
      const ada = await signUp('ada');
      const response = await ada.request('GET', '/api/v1/spaces/ada/members');
      expect(Object.keys(response.body.items[0]).sort()).toEqual([
        'display_name',
        'joined_at',
        'role',
        'username',
      ]);
    });

    it('answers 404 for an unknown user, any letter case for a known one', async () => {
      await signUp('ada');
      expect((await t.anonymous().request('GET', '/api/v1/users/nobody')).status).toBe(404);
      expect((await t.anonymous().request('GET', '/api/v1/users/ADA')).status).toBe(200);
    });
  });
});
