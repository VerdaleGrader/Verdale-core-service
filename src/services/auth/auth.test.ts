import {
  cookieFrom,
  createTestApp,
  describeDb,
  rawSetCookie,
  resetDatabase,
  TestApp,
  testApiDependencies,
} from '@/test/harness';
import { safeRedirectPath, usernameCandidate } from '@/services/auth/auth.service';

describe('safeRedirectPath', () => {
  it.each([
    ['/spaces/mine', '/spaces/mine'],
    ['/', '/'],
    ['//evil.example', '/'],
    ['https://evil.example', '/'],
    ['/\\evil.example', '/'],
    ['/ok\nSet-Cookie: x=1', '/'],
    [undefined, '/'],
    [42, '/'],
  ])('%j -> %j', (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });
});

describe('usernameCandidate', () => {
  it.each([
    ['Ada Lovelace', 'ada-lovelace'],
    ['  --Ada__', 'ada'],
    ['ADA.the.great', 'ada-the-great'],
    ['x', 'user-x'],
    ['', 'user'],
    ['日本語', 'user'],
    ['a'.repeat(40), 'a'.repeat(24)],
  ])('%j -> %j', (input, expected) => {
    expect(usernameCandidate(input)).toBe(expected);
  });
});

describeDb('OAuth login (GRD-11)', () => {
  let t: TestApp;
  // A fresh app per test: the rate limiter keeps its counters in memory.
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
  });
  afterEach(async () => t.close());

  it('lists the configured providers', async () => {
    const response = await t.anonymous().request('GET', '/api/v1/auth/providers');
    expect(response.body).toEqual({ providers: ['github', 'google'] });
  });

  it('start redirects to the provider and sets a signed, httpOnly state cookie', async () => {
    const response = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/github/start?redirect=/spaces',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('https://provider.example/authorize');
    expect(response.headers.location).toContain(
      encodeURIComponent('http://localhost:3000/api/v1/auth/oauth/github/callback')
    );
    const cookie = rawSetCookie(response.headers['set-cookie'], 'vd_oauth');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=600/);
  });

  it('first login creates the user and a personal Space in one go', async () => {
    const ada = await t.login({
      providerAccountId: 'gh-1',
      email: 'ada@example.com',
      usernameHint: 'ada',
    });
    const me = await ada.request('GET', '/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ username: 'ada', email: 'ada@example.com' });

    const spaces = await ada.request('GET', '/api/v1/me/spaces');
    expect(spaces.body.items).toHaveLength(1);
    expect(spaces.body.items[0]).toMatchObject({
      slug: 'ada',
      name: 'ada',
      is_personal: true,
      my_role: 'owner',
      visibility: 'private',
    });
  });

  it('logging in again reuses the same user and does not add Spaces', async () => {
    const profile = { providerAccountId: 'gh-1', email: 'ada@example.com', usernameHint: 'ada' };
    await t.login(profile);
    await t.login(profile);
    expect(await t.prisma.user.count()).toBe(1);
    expect(await t.prisma.space.count()).toBe(1);
    expect(await t.prisma.session.count()).toBe(2);
  });

  it('the same verified e-mail through another provider links to the same user', async () => {
    await t.login({ providerAccountId: 'gh-1', email: 'ada@example.com' });
    t.google.profile = {
      providerAccountId: 'g-9',
      email: 'ada@example.com',
      emailVerified: true,
      displayName: 'Ada',
      usernameHint: 'ada',
    };
    const start = await t.app.inject({ method: 'GET', url: '/api/v1/auth/oauth/google/start' });
    const state = new URL(start.headers.location as string).searchParams.get('state');
    const callback = await t.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/google/callback?code=c&state=${state}`,
      headers: { cookie: cookieFrom(start.headers['set-cookie'], 'vd_oauth') },
    });
    expect(callback.statusCode).toBe(302);
    expect(await t.prisma.user.count()).toBe(1);
    expect(await t.prisma.oAuthAccount.count()).toBe(2);
  });

  it('two people with the same name get different usernames', async () => {
    const first = await t.login({
      providerAccountId: 'a',
      email: 'a@example.com',
      usernameHint: 'sam',
    });
    const second = await t.login({
      providerAccountId: 'b',
      email: 'b@example.com',
      usernameHint: 'sam',
    });
    const one = (await first.request('GET', '/api/v1/me')).body.username;
    const two = (await second.request('GET', '/api/v1/me')).body.username;
    expect(one).toBe('sam');
    expect(two).toMatch(/^sam-\d{4}$/);
  });

  it('a username never takes the slug of an existing Space', async () => {
    const owner = await t.login({
      providerAccountId: 'a',
      email: 'a@example.com',
      usernameHint: 'alpha',
    });
    await owner.request('POST', '/api/v1/spaces', { name: 'Chess', slug: 'chess' });
    const newcomer = await t.login({
      providerAccountId: 'b',
      email: 'b@example.com',
      usernameHint: 'chess',
    });
    const username = (await newcomer.request('GET', '/api/v1/me')).body.username;
    expect(username).not.toBe('chess');
  });

  it('rejects an e-mail the provider has not verified', async () => {
    t.github.profile = {
      providerAccountId: 'gh-2',
      email: 'victim@example.com',
      emailVerified: false,
      displayName: 'X',
      usernameHint: 'x',
    };
    const start = await t.app.inject({ method: 'GET', url: '/api/v1/auth/oauth/github/start' });
    const state = new URL(start.headers.location as string).searchParams.get('state');
    const callback = await t.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/github/callback?code=c&state=${state}`,
      headers: { cookie: cookieFrom(start.headers['set-cookie'], 'vd_oauth') },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain('/login?error=bad_request');
    expect(cookieFrom(callback.headers['set-cookie'], 'vd_session')).toBe('');
    expect(await t.prisma.user.count()).toBe(0);
  });

  it('rejects a callback whose state does not match the cookie', async () => {
    const start = await t.app.inject({ method: 'GET', url: '/api/v1/auth/oauth/github/start' });
    const callback = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/github/callback?code=c&state=forged',
      headers: { cookie: cookieFrom(start.headers['set-cookie'], 'vd_oauth') },
    });
    expect(callback.headers.location).toContain('/login?error=bad_request');
    expect(await t.prisma.user.count()).toBe(0);
  });

  it('rejects a callback with no state cookie, or a tampered one', async () => {
    const start = await t.app.inject({ method: 'GET', url: '/api/v1/auth/oauth/github/start' });
    const state = new URL(start.headers.location as string).searchParams.get('state');
    const url = `/api/v1/auth/oauth/github/callback?code=c&state=${state}`;
    const missing = await t.app.inject({ method: 'GET', url });
    expect(missing.headers.location).toContain('error=bad_request');
    const tampered = await t.app.inject({
      method: 'GET',
      url,
      headers: { cookie: `${cookieFrom(start.headers['set-cookie'], 'vd_oauth')}x` },
    });
    expect(tampered.headers.location).toContain('error=bad_request');
  });

  it('a state can only be used once', async () => {
    const start = await t.app.inject({ method: 'GET', url: '/api/v1/auth/oauth/github/start' });
    const state = new URL(start.headers.location as string).searchParams.get('state');
    const stateCookie = cookieFrom(start.headers['set-cookie'], 'vd_oauth');
    const url = `/api/v1/auth/oauth/github/callback?code=c&state=${state}`;
    const first = await t.app.inject({ method: 'GET', url, headers: { cookie: stateCookie } });
    expect(cookieFrom(first.headers['set-cookie'], 'vd_session')).not.toBe('');
    // The browser drops the cleared cookie, so a replay has none to send.
    expect(cookieFrom(first.headers['set-cookie'], 'vd_oauth')).toBe('');
    const replay = await t.app.inject({ method: 'GET', url });
    expect(replay.headers.location).toContain('error=bad_request');
  });

  it('turns provider failures and denied consent into a login redirect', async () => {
    const start = await t.app.inject({ method: 'GET', url: '/api/v1/auth/oauth/github/start' });
    const state = new URL(start.headers.location as string).searchParams.get('state');
    const stateCookie = cookieFrom(start.headers['set-cookie'], 'vd_oauth');

    const denied = await t.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/github/callback?error=access_denied&state=${state}`,
      headers: { cookie: stateCookie },
    });
    expect(denied.headers.location).toBe('http://localhost:3000/login?error=access_denied');

    t.github.profile = new Error('provider is down');
    const failed = await t.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/github/callback?code=c&state=${state}`,
      headers: { cookie: stateCookie },
    });
    expect(failed.headers.location).toContain('/login?error=bad_request');
  });

  it('sends the user to the requested page afterwards, but only a relative one', async () => {
    t.github.profile = {
      providerAccountId: 'gh-1',
      email: 'ada@example.com',
      emailVerified: true,
      displayName: 'Ada',
      usernameHint: 'ada',
    };
    for (const [asked, landed] of [
      ['/spaces/mine', '/spaces/mine'],
      ['//evil.example', '/'],
    ] as const) {
      const start = await t.app.inject({
        method: 'GET',
        url: `/api/v1/auth/oauth/github/start?redirect=${encodeURIComponent(asked)}`,
      });
      const state = new URL(start.headers.location as string).searchParams.get('state');
      const callback = await t.app.inject({
        method: 'GET',
        url: `/api/v1/auth/oauth/github/callback?code=c&state=${state}`,
        headers: { cookie: cookieFrom(start.headers['set-cookie'], 'vd_oauth') },
      });
      expect(callback.headers.location).toBe(`http://localhost:3000${landed}`);
    }
  });

  it('answers 404 for a provider that is not configured', async () => {
    const unconfigured = await import('@/routes');
    const { loadConfig } = await import('@/config');
    const config = loadConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! });
    const app = unconfigured.buildApp({
      version: 't',
      readinessChecks: [],
      api: testApiDependencies(t.prisma, config.auth, {}),
    });
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/oauth/github/start' });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  describe('session cookie', () => {
    it('is httpOnly, SameSite=Lax, path / and expires in 30 days (not Secure locally)', async () => {
      t.github.profile = {
        providerAccountId: 'gh-1',
        email: 'ada@example.com',
        emailVerified: true,
        displayName: 'Ada',
        usernameHint: 'ada',
      };
      const start = await t.app.inject({ method: 'GET', url: '/api/v1/auth/oauth/github/start' });
      const state = new URL(start.headers.location as string).searchParams.get('state');
      const callback = await t.app.inject({
        method: 'GET',
        url: `/api/v1/auth/oauth/github/callback?code=c&state=${state}`,
        headers: { cookie: cookieFrom(start.headers['set-cookie'], 'vd_oauth') },
      });
      const cookie = rawSetCookie(callback.headers['set-cookie'], 'vd_session');
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).not.toMatch(/Secure/i);
      const expires = new Date(/Expires=([^;]+)/i.exec(cookie)![1]!).getTime();
      const days = (expires - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);
    });

    it('is Secure outside local, and only a hash is stored', async () => {
      const staging = await createTestApp({
        ENV: 'staging',
        BETTERSTACK_SOURCE_TOKEN: 't',
        SESSION_SECRET: 'x'.repeat(32),
        STORAGE_DRIVER: 'r2',
        R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
        R2_ACCESS_KEY_ID: 'key',
        R2_SECRET_ACCESS_KEY: 'secret',
        R2_TESTS_BUCKET: 'tests',
        R2_PUBLIC_BUCKET: 'public',
        JUDGE_KEY_ID: 'core-staging',
        JUDGE_SECRET: 'c'.repeat(40),
        JUDGE_CALLBACK_KEYS: `judge-staging:${'j'.repeat(40)}`,
      });
      try {
        const ada = await staging.login({ providerAccountId: 'gh-1', email: 'ada@example.com' });
        const session = await staging.prisma.session.findFirstOrThrow();
        expect(ada.cookie).not.toContain(session.token_hash);
        expect(session.token_hash).toMatch(/^[0-9a-f]{64}$/);

        const start = await staging.app.inject({
          method: 'GET',
          url: '/api/v1/auth/oauth/github/start',
        });
        expect(rawSetCookie(start.headers['set-cookie'], 'vd_oauth')).toMatch(/Secure/i);
      } finally {
        await staging.close();
      }
    });
  });

  describe('logout', () => {
    it('makes the session unusable even if the cookie is kept', async () => {
      const ada = await t.login({ providerAccountId: 'gh-1', email: 'ada@example.com' });
      expect((await ada.request('GET', '/api/v1/me')).status).toBe(200);

      const out = await ada.request('POST', '/api/v1/auth/logout');
      expect(out.status).toBe(204);
      expect(await t.prisma.session.count()).toBe(0);

      const again = await ada.request('GET', '/api/v1/me');
      expect(again.status).toBe(401);
      expect(again.body.error_code).toBe('UNAUTHORIZED');
    });

    it('only ends the session that was used', async () => {
      const profile = { providerAccountId: 'gh-1', email: 'ada@example.com' };
      const laptop = await t.login(profile);
      const phone = await t.login(profile);
      await laptop.request('POST', '/api/v1/auth/logout');
      expect((await phone.request('GET', '/api/v1/me')).status).toBe(200);
    });
  });

  describe('sessions', () => {
    it('an expired session is rejected', async () => {
      const ada = await t.login({ providerAccountId: 'gh-1', email: 'ada@example.com' });
      await t.prisma.session.updateMany({ data: { expires_at: new Date(Date.now() - 1000) } });
      expect((await ada.request('GET', '/api/v1/me')).status).toBe(401);
    });

    it('a made-up token is rejected', async () => {
      const response = await t.anonymous().request('GET', '/api/v1/me');
      expect(response.status).toBe(401);
      const fake = await t.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: 'vd_session=not-a-real-token' },
      });
      expect(fake.statusCode).toBe(401);
    });
  });

  describe('CSRF', () => {
    it('rejects a state-changing request from another origin or with no Origin', async () => {
      const ada = await t.login({ providerAccountId: 'gh-1', email: 'ada@example.com' });
      for (const headers of [
        { cookie: ada.cookie, origin: 'https://evil.example' },
        { cookie: ada.cookie },
      ]) {
        const response = await t.app.inject({
          method: 'POST',
          url: '/api/v1/spaces',
          headers,
          payload: { name: 'Pwned', slug: 'pwned' },
        });
        expect(response.statusCode).toBe(403);
      }
      expect(await t.prisma.space.count()).toBe(1);
    });

    it('does not block reads, and does not need Origin without a session', async () => {
      const ada = await t.login({ providerAccountId: 'gh-1', email: 'ada@example.com' });
      const read = await t.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: ada.cookie },
      });
      expect(read.statusCode).toBe(200);
    });
  });

  describe('brute force', () => {
    it('limits the sign-in endpoints per client', async () => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 22; attempt++) {
        const response = await t.app.inject({
          method: 'GET',
          url: '/api/v1/auth/oauth/github/callback?code=x&state=y',
        });
        statuses.push(response.statusCode);
      }
      expect(statuses.slice(0, 20).every((status) => status === 302)).toBe(true);
      expect(statuses.slice(20)).toEqual([429, 429]);
    });
  });
});
