import { ConfigError, loadConfig } from '@/config';
import { DEFAULT_RATE_LIMITS } from '@/constants/limits';
import { Cast, castSpace, createPublishedProblem, submitCode } from '@/test/fixtures';
import { jobResult, createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

const base = { DATABASE_URL: 'postgresql://core:pw@localhost:5432/verdale' };
const WINDOW_MS = 1000;
const afterWindow = () => new Promise((resolve) => setTimeout(resolve, WINDOW_MS + 150));

describe('rate limit settings (GRD-55)', () => {
  it('has defaults and reads every limit from the environment', () => {
    expect(loadConfig(base).rateLimits).toEqual({
      windowMs: 60_000,
      apiPerIp: DEFAULT_RATE_LIMITS.api_per_ip,
      apiPerUser: DEFAULT_RATE_LIMITS.api_per_user,
      signInPerIp: DEFAULT_RATE_LIMITS.sign_in_per_ip,
      submitPerUser: DEFAULT_RATE_LIMITS.submit_per_user,
      submitPerIp: DEFAULT_RATE_LIMITS.submit_per_ip,
      maxPendingSubmissionsPerUser: DEFAULT_RATE_LIMITS.max_pending_submissions_per_user,
      clientIpHeader: undefined,
    });
    expect(
      loadConfig({
        ...base,
        RATE_LIMIT_API_PER_IP: '50',
        RATE_LIMIT_API_PER_USER: '80',
        RATE_LIMIT_SIGN_IN_PER_IP: '5',
        RATE_LIMIT_SUBMIT_PER_USER: '4',
        RATE_LIMIT_SUBMIT_PER_IP: '9',
        MAX_PENDING_SUBMISSIONS_PER_USER: '3',
        CLIENT_IP_HEADER: 'CF-Connecting-IP',
      }).rateLimits
    ).toMatchObject({
      apiPerIp: 50,
      apiPerUser: 80,
      signInPerIp: 5,
      submitPerUser: 4,
      submitPerIp: 9,
      maxPendingSubmissionsPerUser: 3,
      clientIpHeader: 'cf-connecting-ip',
    });
  });

  it('refuses a limit that is zero, negative, fractional or not a number, and a bad header name', () => {
    for (const bad of ['0', '-1', '1.5', 'many', '100001']) {
      expect(() => loadConfig({ ...base, RATE_LIMIT_API_PER_IP: bad })).toThrow(ConfigError);
    }
    expect(() => loadConfig({ ...base, MAX_PENDING_SUBMISSIONS_PER_USER: '0' })).toThrow(
      /MAX_PENDING_SUBMISSIONS_PER_USER/
    );
    expect(() => loadConfig({ ...base, CLIENT_IP_HEADER: 'bad header' })).toThrow(
      /CLIENT_IP_HEADER/
    );
  });
});

describeDb('Rate limiting (GRD-55)', () => {
  let t: TestApp;
  afterEach(async () => t?.close());

  /** A request from a chosen address (the test client always comes from 127.0.0.1). */
  const from = (
    address: string,
    url: string,
    headers: Record<string, string> = {},
    method: 'GET' | 'POST' = 'GET'
  ) => t.app.inject({ method, url, remoteAddress: address, headers });

  async function start(env: Record<string, string> = {}) {
    t = await createTestApp(env, { rateLimitWindowMs: WINDOW_MS });
    await resetDatabase(t.prisma);
  }

  describe('general API', () => {
    it('allows a number of requests per address, then answers 429 with the time to wait', async () => {
      await start({ RATE_LIMIT_API_PER_IP: '5' });
      for (let n = 0; n < 5; n++) {
        expect((await from('10.0.0.1', '/api/v1/auth/providers')).statusCode).toBe(200);
      }
      const limited = await from('10.0.0.1', '/api/v1/auth/providers');
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ status: 429, error_code: 'RATE_LIMITED' });
      expect(limited.json().message).toMatch(/Try again in \d+ seconds?\./);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(limited.json().request_id).toBe(limited.headers['x-request-id']);

      // Another address has a budget of its own.
      expect((await from('10.0.0.2', '/api/v1/auth/providers')).statusCode).toBe(200);
    });

    it('starts counting again when the window is over', async () => {
      await start({ RATE_LIMIT_API_PER_IP: '2' });
      await from('10.0.0.3', '/api/v1/auth/providers');
      await from('10.0.0.3', '/api/v1/auth/providers');
      expect((await from('10.0.0.3', '/api/v1/auth/providers')).statusCode).toBe(429);
      await afterWindow();
      expect((await from('10.0.0.3', '/api/v1/auth/providers')).statusCode).toBe(200);
    });

    it('does not limit /health or /ready', async () => {
      await start({ RATE_LIMIT_API_PER_IP: '1' });
      for (let n = 0; n < 5; n++) {
        expect((await from('10.0.0.4', '/health')).statusCode).toBe(200);
      }
    });

    it('limits a signed-in person as a whole, however many addresses they use', async () => {
      await start({ RATE_LIMIT_API_PER_USER: '4' });
      const ada = await t.login({ providerAccountId: 'ada', email: 'ada@example.com' });
      const grace = await t.login({ providerAccountId: 'grace', email: 'grace@example.com' });
      const me = (address: string, client = ada) =>
        from(address, '/api/v1/me', { cookie: client.cookie });

      for (const address of ['10.1.0.1', '10.1.0.2', '10.1.0.3', '10.1.0.4']) {
        expect((await me(address)).statusCode).toBe(200);
      }
      const limited = await me('10.1.0.5');
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error_code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      // Somebody else is not affected.
      expect((await me('10.1.0.5', grace)).statusCode).toBe(200);
      await afterWindow();
      expect((await me('10.1.0.1')).statusCode).toBe(200);
    });
  });

  describe('sign-in', () => {
    it('allows a few sign-in attempts per address, then answers 429', async () => {
      await start({ RATE_LIMIT_SIGN_IN_PER_IP: '3' });
      const attempt = (address: string) => from(address, '/api/v1/auth/oauth/github/start');
      for (let n = 0; n < 3; n++) expect((await attempt('10.2.0.1')).statusCode).toBe(302);
      const limited = await attempt('10.2.0.1');
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error_code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect((await attempt('10.2.0.2')).statusCode).toBe(302);
      await afterWindow();
      expect((await attempt('10.2.0.1')).statusCode).toBe(302);
    });

    it('limits the callback too, and the two share the address budget', async () => {
      await start({ RATE_LIMIT_SIGN_IN_PER_IP: '2' });
      await from('10.2.1.1', '/api/v1/auth/oauth/github/start');
      await from('10.2.1.1', '/api/v1/auth/oauth/github/callback?code=x&state=y');
      expect(
        (await from('10.2.1.1', '/api/v1/auth/oauth/github/callback?code=x&state=y')).statusCode
      ).toBe(429);
    });
  });

  describe('which address counts', () => {
    it('uses the header named in CLIENT_IP_HEADER, not an X-Forwarded-For the client can forge', async () => {
      await start({ RATE_LIMIT_API_PER_IP: '2', CLIENT_IP_HEADER: 'cf-connecting-ip' });
      const hit = (real: string, forged: string) =>
        from('10.3.0.1', '/api/v1/auth/providers', {
          'cf-connecting-ip': real,
          'x-forwarded-for': forged,
        });
      await hit('203.0.113.7', '1.1.1.1');
      await hit('203.0.113.7', '2.2.2.2');
      expect((await hit('203.0.113.7', '3.3.3.3')).statusCode).toBe(429);
      // A different real address, though the connection is the same proxy's.
      expect((await hit('203.0.113.8', '1.1.1.1')).statusCode).toBe(200);
    });

    it('falls back to the connection address when the header is missing or not an address', async () => {
      await start({ RATE_LIMIT_API_PER_IP: '2', CLIENT_IP_HEADER: 'cf-connecting-ip' });
      await from('10.3.1.1', '/api/v1/auth/providers');
      await from('10.3.1.1', '/api/v1/auth/providers', { 'cf-connecting-ip': 'not an address' });
      expect((await from('10.3.1.1', '/api/v1/auth/providers')).statusCode).toBe(429);
    });
  });

  describe('submitting code', () => {
    let cast: Cast;
    async function startWithProblem(env: Record<string, string>) {
      await start(env);
      cast = await castSpace(t, { visibility: 'public' });
      await createPublishedProblem(cast);
    }

    it('limits each address, so several accounts behind one address share a budget', async () => {
      await startWithProblem({ RATE_LIMIT_SUBMIT_PER_USER: '100', RATE_LIMIT_SUBMIT_PER_IP: '3' });
      expect((await submitCode(cast.solver, cast.slug, 'sum')).status).toBe(202);
      expect((await submitCode(cast.editor, cast.slug, 'sum')).status).toBe(202);
      expect((await submitCode(cast.solver, cast.slug, 'sum')).status).toBe(202);
      const limited = await submitCode(cast.editor, cast.slug, 'sum');
      expect(limited.status).toBe(429);
      expect(limited.body.error_code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(await t.prisma.submission.count()).toBe(3);
      await afterWindow();
      expect((await submitCode(cast.editor, cast.slug, 'sum')).status).toBe(202);
    });

    it('limits each person with the configured number and resets with the window', async () => {
      await startWithProblem({ RATE_LIMIT_SUBMIT_PER_USER: '2', RATE_LIMIT_SUBMIT_PER_IP: '100' });
      await submitCode(cast.solver, cast.slug, 'sum');
      await submitCode(cast.solver, cast.slug, 'sum');
      const limited = await submitCode(cast.solver, cast.slug, 'sum');
      expect(limited.status).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect((await submitCode(cast.editor, cast.slug, 'sum')).status).toBe(202);
      await afterWindow();
      expect((await submitCode(cast.solver, cast.slug, 'sum')).status).toBe(202);
    });
  });

  describe('submissions waiting in the queue', () => {
    let cast: Cast;
    beforeEach(async () => {
      await start({
        MAX_PENDING_SUBMISSIONS_PER_USER: '2',
        RATE_LIMIT_SUBMIT_PER_USER: '100',
        RATE_LIMIT_SUBMIT_PER_IP: '100',
      });
      cast = await castSpace(t, { visibility: 'public' });
      await createPublishedProblem(cast);
    });

    it('refuses a submission when the person already has too many waiting, until one is judged', async () => {
      expect((await submitCode(cast.solver, cast.slug, 'sum')).status).toBe(202);
      expect((await submitCode(cast.solver, cast.slug, 'sum')).status).toBe(202);

      const refused = await submitCode(cast.solver, cast.slug, 'sum');
      expect(refused.status).toBe(429);
      expect(refused.body.error_code).toBe('TOO_MANY_PENDING_SUBMISSIONS');
      expect(refused.body.message).toMatch(/2 submissions waiting/);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(await t.prisma.submission.count()).toBe(2);

      // Somebody else has a queue of their own.
      expect((await submitCode(cast.editor, cast.slug, 'sum')).status).toBe(202);

      // Judge answers the first job: there is room again.
      await t.settle();
      const first = t.judge.jobs[0]!;
      expect((await t.deliver(jobResult(first))).status).toBe(204);
      expect((await submitCode(cast.solver, cast.slug, 'sum')).status).toBe(202);
    });

    it('does not count judged submissions, whatever their verdict', async () => {
      for (let round = 0; round < 3; round++) {
        const sent = await submitCode(cast.solver, cast.slug, 'sum');
        expect(sent.status).toBe(202);
        await t.settle();
        await t.deliver(jobResult(t.judge.last, { verdict: 'WA' }));
      }
      expect(await t.prisma.submission.count({ where: { status: 'completed' } })).toBe(3);
    });

    it('also holds back a re-check of a system error while the queue is full', async () => {
      const first = await submitCode(cast.solver, cast.slug, 'sum');
      await t.settle();
      await t.deliver(
        jobResult(t.judge.last, { verdict: 'ISE', tests: [], error: { code: 'X', message: 'x' } })
      );
      await submitCode(cast.solver, cast.slug, 'sum');
      await submitCode(cast.solver, cast.slug, 'sum');
      const recheck = await cast.solver.request(
        'POST',
        `/api/v1/submissions/${first.body.id}/rejudge`
      );
      expect(recheck.status).toBe(429);
      expect(recheck.body.error_code).toBe('TOO_MANY_PENDING_SUBMISSIONS');
    });
  });
});
