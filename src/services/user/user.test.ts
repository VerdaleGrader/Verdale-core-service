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

  describe('profile picture and display name (GRD-68)', () => {
    const PICTURE = 'https://lh3.googleusercontent.com/a/abc=s96-c';

    it('keeps the provider picture at sign-up and returns it from the user API', async () => {
      const ada = await signUp('ada');
      expect((await ada.request('GET', '/api/v1/me')).body.avatar_url).toBeNull();
      const grace = await t.login({
        providerAccountId: 'grace',
        email: 'grace@example.com',
        usernameHint: 'grace',
        avatarUrl: PICTURE,
      });
      expect((await grace.request('GET', '/api/v1/me')).body.avatar_url).toBe(PICTURE);
      expect((await ada.request('GET', '/api/v1/users/grace')).body.avatar_url).toBe(PICTURE);
      const members = await grace.request('GET', '/api/v1/spaces/grace/members');
      expect(members.body.items[0].avatar_url).toBe(PICTURE);
    });

    it('refreshes the picture at every login, and a login without one keeps the old one', async () => {
      const profile = { providerAccountId: 'g1', email: 'g@example.com', usernameHint: 'gina' };
      await t.login({ ...profile, avatarUrl: PICTURE });
      const newer = 'https://lh3.googleusercontent.com/a/new=s96-c';
      const second = await t.login({ ...profile, avatarUrl: newer });
      expect((await second.request('GET', '/api/v1/me')).body.avatar_url).toBe(newer);
      const third = await t.login({ ...profile, avatarUrl: undefined });
      expect((await third.request('GET', '/api/v1/me')).body.avatar_url).toBe(newer);
    });

    it.each([
      ['an http URL', 'http://example.com/a.png'],
      ['a data URL', 'data:image/png;base64,AAAA'],
      ['a javascript URL', 'javascript:alert(1)'],
      ['a URL with credentials', 'https://user:pw@example.com/a.png'],
      ['text that is not a URL', 'not a url'],
      ['a URL that is too long', `https://example.com/${'a'.repeat(2100)}`],
    ])('does not keep %s', async (_label, avatarUrl) => {
      const client = await t.login({
        providerAccountId: 'bad',
        email: 'bad@example.com',
        usernameHint: 'badpic',
        avatarUrl,
      });
      expect((await client.request('GET', '/api/v1/me')).body.avatar_url).toBeNull();
    });

    it('the same person through another provider keeps one account and gets the picture', async () => {
      await t.login({ providerAccountId: 'gh-7', email: 'same@example.com', usernameHint: 'same' });
      t.google.profile = {
        providerAccountId: 'g-7',
        email: 'same@example.com',
        emailVerified: true,
        displayName: 'Same',
        usernameHint: 'same',
        avatarUrl: PICTURE,
      };
      const start = await t.app.inject({ method: 'GET', url: '/api/v1/auth/oauth/google/start' });
      const state = new URL(start.headers.location as string).searchParams.get('state');
      const stateCookie = String(start.headers['set-cookie']).split(';')[0]!;
      const callback = await t.app.inject({
        method: 'GET',
        url: `/api/v1/auth/oauth/google/callback?code=x&state=${state}`,
        headers: { cookie: stateCookie },
      });
      expect(callback.statusCode).toBe(302);
      expect(await t.prisma.user.count({ where: { email: 'same@example.com' } })).toBe(1);
      const user = await t.prisma.user.findFirstOrThrow({ where: { email: 'same@example.com' } });
      expect(user.avatar_url).toBe(PICTURE);
    });

    it('lets people change their display name and nothing else changes', async () => {
      const ada = await signUp('ada');
      const response = await ada.request('PATCH', '/api/v1/me', { display_name: 'Ada ลัฟเลซ 🌿' });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ display_name: 'Ada ลัฟเลซ 🌿', username: 'ada' });
      expect((await ada.request('GET', '/api/v1/users/ada')).body.display_name).toBe(
        'Ada ลัฟเลซ 🌿'
      );
    });

    it.each([
      ['a line break', 'Ada\nLovelace'],
      ['a tab', 'Ada\tL'],
      ['a NUL', 'Ada\u0000'],
      ['a line separator', 'Ada\u2028L'],
    ])('refuses a display name with %s', async (_label, display_name) => {
      const ada = await signUp('ada');
      const response = await ada.request('PATCH', '/api/v1/me', { display_name });
      expect(response.status).toBe(400);
      expect(response.body.details[0].field).toBe('display_name');
      expect((await ada.request('GET', '/api/v1/me')).body.display_name).toBe('ada');
    });

    it('limits profile changes to 10 a minute per person', async () => {
      const ada = await signUp('ada');
      const grace = await signUp('grace');
      for (let index = 0; index < 10; index++) {
        expect(
          (await ada.request('PATCH', '/api/v1/me', { display_name: `Ada ${index}` })).status
        ).toBe(200);
      }
      const blocked = await ada.request('PATCH', '/api/v1/me', { display_name: 'Ada again' });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error_code).toBe('RATE_LIMITED');
      expect((await grace.request('PATCH', '/api/v1/me', { display_name: 'Grace' })).status).toBe(
        200
      );
    });
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
        expect(Object.keys(response.body).sort()).toEqual([
          'avatar_url',
          'display_name',
          'username',
        ]);
      }
    });

    it('member lists expose the same two fields plus the role', async () => {
      const ada = await signUp('ada');
      const response = await ada.request('GET', '/api/v1/spaces/ada/members');
      expect(Object.keys(response.body.items[0]).sort()).toEqual([
        'avatar_url',
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
