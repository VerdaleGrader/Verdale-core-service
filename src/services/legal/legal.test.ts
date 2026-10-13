import { CURRENT_LEGAL_VERSIONS, LEGAL_DOCUMENTS } from '@/constants/legal';
import { cookieFrom, createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

const ADA = { providerAccountId: 'gh-1', email: 'ada@example.com', usernameHint: 'ada' };
const CURRENT = { terms: CURRENT_LEGAL_VERSIONS.terms, privacy: CURRENT_LEGAL_VERSIONS.privacy };

describe('current legal versions (GRD-122)', () => {
  it('are effective dates, one per document', () => {
    expect([...LEGAL_DOCUMENTS].sort()).toEqual(['privacy', 'terms']);
    for (const document of LEGAL_DOCUMENTS) {
      expect(CURRENT_LEGAL_VERSIONS[document]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describeDb('Terms and Privacy Policy acceptance (GRD-122)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
  });
  afterEach(async () => t.close());

  /** Pretends the documents were republished after the user accepted. */
  const makeStale = (userId: string) =>
    t.prisma.legalAcceptance.updateMany({
      where: { user_id: userId },
      data: { version: '2026-01-01' },
    });

  it('a new user gets one record per document with the current version and the time', async () => {
    const before = Date.now();
    const ada = await t.login(ADA);
    const me = (await ada.request('GET', '/api/v1/me')).body;

    const rows = await t.prisma.legalAcceptance.findMany({ where: { user_id: me.id } });
    expect(rows.map((r) => [r.document, r.version]).sort()).toEqual([
      ['privacy', CURRENT.privacy],
      ['terms', CURRENT.terms],
    ]);
    for (const row of rows) {
      expect(row.accepted_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(row.accepted_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    }
    expect(me.legal).toEqual({ acceptance_required: false, current_versions: CURRENT });
  });

  it('stores nothing but the user, the document, the version and the time', async () => {
    const columns = await t.prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'legal_acceptances'`;
    expect(columns.map((c) => c.column_name).sort()).toEqual([
      'accepted_at',
      'document',
      'user_id',
      'version',
    ]);
  });

  it('a first login that cannot record the acceptance leaves no user, Space or session', async () => {
    await t.prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION legal_test_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'legal acceptance failed on purpose'; END; $$ LANGUAGE plpgsql`);
    await t.prisma.$executeRawUnsafe(
      `CREATE TRIGGER legal_test_fail BEFORE INSERT ON legal_acceptances
       FOR EACH ROW EXECUTE FUNCTION legal_test_fail()`
    );
    try {
      t.github.profile = {
        providerAccountId: 'gh-1',
        email: 'ada@example.com',
        emailVerified: true,
        displayName: 'Ada',
        usernameHint: 'ada',
      };
      const start = await t.app.inject({ method: 'GET', url: '/api/v1/auth/oauth/github/start' });
      const state = new URL(start.headers.location as string).searchParams.get('state');
      await t.app.inject({
        method: 'GET',
        url: `/api/v1/auth/oauth/github/callback?code=c&state=${state}`,
        headers: { cookie: cookieFrom(start.headers['set-cookie'], 'vd_oauth') },
      });
      expect(await t.prisma.user.count()).toBe(0);
      expect(await t.prisma.space.count()).toBe(0);
      expect(await t.prisma.session.count()).toBe(0);
    } finally {
      await t.prisma.$executeRawUnsafe('DROP TRIGGER legal_test_fail ON legal_acceptances');
      await t.prisma.$executeRawUnsafe('DROP FUNCTION legal_test_fail()');
    }
  });

  it('logging in again does not add records', async () => {
    await t.login(ADA);
    await t.login(ADA);
    expect(await t.prisma.legalAcceptance.count()).toBe(2);
  });

  describe('after a document is republished', () => {
    it('a user on the old version is turned away from the API but can read /me and log out', async () => {
      const ada = await t.login(ADA);
      const me = (await ada.request('GET', '/api/v1/me')).body;
      await makeStale(me.id);

      const spaces = await ada.request('GET', '/api/v1/me/spaces');
      expect(spaces.status).toBe(403);
      expect(spaces.body.error_code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
      const patch = await ada.request('PATCH', '/api/v1/me', { display_name: 'New name' });
      expect(patch.status).toBe(403);
      expect(patch.body.error_code).toBe('LEGAL_ACCEPTANCE_REQUIRED');

      const stillMe = await ada.request('GET', '/api/v1/me');
      expect(stillMe.status).toBe(200);
      expect(stillMe.body.legal).toEqual({ acceptance_required: true, current_versions: CURRENT });

      const logout = await ada.request('POST', '/api/v1/auth/logout');
      expect(logout.status).toBe(204);
    });

    it('a user who accepted before this feature existed (no records) is asked too', async () => {
      const ada = await t.login(ADA);
      await t.prisma.legalAcceptance.deleteMany();
      expect((await ada.request('GET', '/api/v1/me/spaces')).status).toBe(403);
      expect((await ada.request('GET', '/api/v1/me')).body.legal.acceptance_required).toBe(true);
    });

    it('accepting the current versions restores access and keeps the old records as history', async () => {
      const ada = await t.login(ADA);
      const me = (await ada.request('GET', '/api/v1/me')).body;
      await makeStale(me.id);

      const accepted = await ada.request('POST', '/api/v1/me/legal-acceptance', CURRENT);
      expect(accepted.status).toBe(200);
      expect(accepted.body.legal.acceptance_required).toBe(false);
      expect((await ada.request('GET', '/api/v1/me/spaces')).status).toBe(200);

      const rows = await t.prisma.legalAcceptance.findMany({ where: { user_id: me.id } });
      expect(rows.map((r) => `${r.document}:${r.version}`).sort()).toEqual([
        'privacy:2026-01-01',
        `privacy:${CURRENT.privacy}`,
        'terms:2026-01-01',
        `terms:${CURRENT.terms}`,
      ]);
    });

    it('accepting twice records once (first time wins)', async () => {
      const ada = await t.login(ADA);
      const me = (await ada.request('GET', '/api/v1/me')).body;
      await makeStale(me.id);
      await ada.request('POST', '/api/v1/me/legal-acceptance', CURRENT);
      const first = await t.prisma.legalAcceptance.findMany({ where: { version: CURRENT.terms } });
      const again = await ada.request('POST', '/api/v1/me/legal-acceptance', CURRENT);
      expect(again.status).toBe(200);
      const second = await t.prisma.legalAcceptance.findMany({ where: { version: CURRENT.terms } });
      expect(second).toEqual(first);
      expect(await t.prisma.legalAcceptance.count()).toBe(4);
    });

    it('refuses to record a version that is not current (a page left open across a republish)', async () => {
      const ada = await t.login(ADA);
      const me = (await ada.request('GET', '/api/v1/me')).body;
      await makeStale(me.id);
      const response = await ada.request('POST', '/api/v1/me/legal-acceptance', {
        terms: '2026-01-01',
        privacy: CURRENT.privacy,
      });
      expect(response.status).toBe(409);
      expect(response.body.error_code).toBe('LEGAL_VERSION_CHANGED');
      expect((await ada.request('GET', '/api/v1/me/spaces')).status).toBe(403);
    });

    it('rejects a malformed body', async () => {
      const ada = await t.login(ADA);
      const bad = await ada.request('POST', '/api/v1/me/legal-acceptance', {
        terms: 'latest',
        privacy: CURRENT.privacy,
      });
      expect(bad.status).toBe(400);
      const extra = await ada.request('POST', '/api/v1/me/legal-acceptance', {
        ...CURRENT,
        ip: '203.0.113.9',
      });
      expect(extra.status).toBe(400);
    });

    it('needs a session to accept', async () => {
      const response = await t.anonymous().request('POST', '/api/v1/me/legal-acceptance', CURRENT);
      expect(response.status).toBe(401);
    });

    it('only the one who accepted is let back in', async () => {
      const ada = await t.login(ADA);
      const bob = await t.login({
        providerAccountId: 'gh-2',
        email: 'bob@example.com',
        usernameHint: 'bob',
      });
      await t.prisma.$executeRawUnsafe(`UPDATE legal_acceptances SET version = '2026-01-01'`);
      await ada.request('POST', '/api/v1/me/legal-acceptance', CURRENT);
      expect((await ada.request('GET', '/api/v1/me/spaces')).status).toBe(200);
      expect((await bob.request('GET', '/api/v1/me/spaces')).status).toBe(403);
    });
  });

  it('visitors are never asked: public calls work without a session', async () => {
    const response = await t.anonymous().request('GET', '/api/v1/auth/providers');
    expect(response.status).toBe(200);
  });
});
