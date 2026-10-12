import {
  Cast,
  castSpace,
  createDraft,
  createPublishedProblem,
  problemUrl,
  submitCode,
} from '@/test/fixtures';
import { createTestApp, describeDb, jobResult, resetDatabase, TestApp } from '@/test/harness';

describeDb('The Space’s submissions for staff (GRD-93)', () => {
  let t: TestApp;
  let cast: Cast;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    cast = await castSpace(t);
  });
  afterEach(async () => t.close());

  const base = () => `/api/v1/spaces/${cast.slug}`;
  const subs = (suffix = '') => `${base()}/submissions${suffix}`;

  async function addMember(name: string, role: 'administrator' | 'observer' | 'solver') {
    const client = await t.login({
      providerAccountId: name,
      email: `${name}@example.com`,
      usernameHint: name,
    });
    const invite = await cast.owner.request('POST', `${base()}/invites`, { role });
    expect(
      (await client.request('POST', `/api/v1/invites/${invite.body.token}/accept`)).status
    ).toBe(200);
    return client;
  }

  interface Record {
    verdict?: string | null;
    trackSlug?: string | null;
    at?: string;
    language?: 'c' | 'cpp' | 'python';
    testsPassed?: number;
    timeMs?: number;
    status?: 'queued' | 'running' | 'completed';
    version?: number;
    failedTest?: number;
  }

  /** A submission written straight to the database, for the statistics. */
  async function record(username: string, problemSlug: string, options: Record = {}) {
    const user = await t.prisma.user.findUniqueOrThrow({ where: { username } });
    const problem = await t.prisma.problem.findFirstOrThrow({ where: { slug: problemSlug } });
    const track = options.trackSlug
      ? await t.prisma.track.findFirstOrThrow({
          where: { slug: options.trackSlug, space: { slug: cast.slug } },
        })
      : null;
    const version = options.version
      ? await t.prisma.problemVersion.findFirstOrThrow({
          where: { problem_id: problem.id, version_number: options.version },
        })
      : { id: problem.current_version_id! };
    const status = options.status ?? 'completed';
    const verdict =
      status === 'completed' ? (options.verdict === undefined ? 'AC' : options.verdict) : null;
    const submission = await t.prisma.submission.create({
      data: {
        user_id: user.id,
        problem_id: problem.id,
        track_id: track?.id ?? null,
        problem_version_id: version.id,
        language: options.language ?? 'cpp',
        source: 'x',
        source_bytes: 1,
        status,
        verdict: verdict as 'AC' | null,
        tests_total: 2,
        tests_passed: options.testsPassed ?? (verdict === 'AC' ? 2 : 0),
        time_ms: options.timeMs ?? 10,
        memory_kb: 1000,
        ...(options.at ? { created_at: new Date(options.at) } : {}),
      },
    });
    if (options.failedTest) {
      await t.prisma.submissionTestResult.create({
        data: {
          submission_id: submission.id,
          position: options.failedTest,
          is_sample: false,
          verdict: (verdict ?? 'WA') as 'WA',
          time_ms: 1,
          memory_kb: 1,
        },
      });
    }
    return submission;
  }

  /** Two published problems in the starting Track, a second Track with one of them, and some people. */
  async function world() {
    await createPublishedProblem(cast, 'p1');
    await createPublishedProblem(cast, 'p2');
    await createPublishedProblem(cast, 'p3', {}, { expose: false });
    await cast.owner.request('POST', `${base()}/tracks`, { name: 'Week 2', slug: 'week-2' });
    await cast.owner.request('POST', `${base()}/collections`, { name: 'Extra', slug: 'extra' });
    await cast.owner.request('PATCH', `${base()}/collections/extra/problems`, { add: ['p2'] });
    await cast.owner.request('PUT', `${base()}/tracks/week-2/collections`, {
      collection_slugs: ['extra'],
    });
    const observer = await addMember('olga', 'observer');
    const admin = await addMember('ada', 'administrator');
    const lena = await addMember('lena', 'solver');
    return { observer, admin, lena };
  }

  describe('who can see it', () => {
    it('owner, administrator, editor and observer; nobody else', async () => {
      const { observer, admin } = await world();
      await record('sol', 'p1');
      for (const client of [cast.owner, admin, cast.editor, observer]) {
        for (const url of [
          subs(),
          subs('/by-member'),
          subs('/by-track'),
          subs('/by-problem'),
          subs('/versions'),
          subs('/by-member/sol/problems'),
          subs('/by-track/general/problems'),
        ]) {
          expect({ url, status: (await client.request('GET', url)).status }).toEqual({
            url,
            status: 200,
          });
        }
      }
      expect((await cast.solver.request('GET', subs())).status).toBe(403);
      expect((await cast.solver.request('GET', subs('/by-member'))).status).toBe(403);
      expect((await cast.outsider.request('GET', subs())).status).toBe(404);
      expect((await cast.visitor.request('GET', subs())).status).toBe(401);
    });
  });

  describe('the list of submissions', () => {
    it('shows every member’s submissions with the Track they came from and the problem version', async () => {
      await world();
      await record('sol', 'p1', {
        trackSlug: 'general',
        verdict: 'WA',
        at: '2026-10-01T10:00:00Z',
      });
      await record('lena', 'p2', {
        trackSlug: 'week-2',
        verdict: 'AC',
        at: '2026-10-02T10:00:00Z',
      });
      await record('lena', 'p3', { trackSlug: null, verdict: 'TLE', at: '2026-10-03T10:00:00Z' });
      const list = await cast.owner.request('GET', subs());
      expect(list.body.total).toBe(3);
      expect(
        list.body.items.map((item: { problem: { slug: string } }) => item.problem.slug)
      ).toEqual(['p3', 'p2', 'p1']);
      expect(list.body.items[0]).toMatchObject({
        member: { username: 'lena' },
        problem: { slug: 'p3', title: 'Sum of two numbers' },
        track: null,
        version: 1,
        language: 'cpp',
        status: 'completed',
        verdict: 'TLE',
        tests_passed: 0,
        tests_total: 2,
      });
      expect(list.body.items[1].track).toEqual({ name: 'Week 2', slug: 'week-2' });
      expect(list.body.items[2].track).toEqual({ name: 'General', slug: 'general' });
    });

    it('filters by member, search, problem, verdict, language, version, Track and time', async () => {
      await world();
      const problem = await t.prisma.problem.findFirstOrThrow({ where: { slug: 'p1' } });
      const v1 = await t.prisma.problemVersion.findUniqueOrThrow({
        where: { id: problem.current_version_id! },
      });
      await t.prisma.problemVersion.create({
        data: {
          problem_id: problem.id,
          version_number: 2,
          status: 'published',
          published_at: new Date(),
          title: v1.title,
          statement: v1.statement,
          time_limit_ms: v1.time_limit_ms,
          memory_limit_kb: v1.memory_limit_kb,
          allowed_languages: v1.allowed_languages,
        },
      });
      await record('sol', 'p1', {
        trackSlug: 'general',
        verdict: 'WA',
        language: 'python',
        at: '2026-10-01T10:00:00Z',
      });
      await record('sol', 'p1', {
        trackSlug: 'general',
        verdict: 'AC',
        at: '2026-10-05T10:00:00Z',
        version: 2,
      });
      await record('lena', 'p2', {
        trackSlug: 'week-2',
        verdict: 'TLE',
        at: '2026-10-03T10:00:00Z',
      });
      await record('lena', 'p3', { verdict: 'RE', at: '2026-10-04T10:00:00Z' });

      const ask = async (query: string) =>
        (await cast.owner.request('GET', subs(`?${query}`))).body.items.map(
          (item: { problem: { slug: string }; member: { username: string } }) =>
            `${item.member.username}:${item.problem.slug}`
        );

      expect(await ask('member=lena')).toEqual(['lena:p3', 'lena:p2']);
      expect(await ask('q=SOL')).toEqual(['sol:p1', 'sol:p1']);
      expect(await ask('problem=p2')).toEqual(['lena:p2']);
      expect(await ask('verdict=AC')).toEqual(['sol:p1']);
      expect(await ask('verdict=TLE,RE')).toEqual(['lena:p3', 'lena:p2']);
      expect(await ask('language=python')).toEqual(['sol:p1']);
      expect(await ask('version=2')).toEqual(['sol:p1']);
      expect(await ask('track=week-2')).toEqual(['lena:p2']);
      expect(await ask('track=none')).toEqual(['lena:p3']);
      expect(await ask('from=2026-10-03T00:00:00Z&to=2026-10-05T00:00:00Z')).toEqual([
        'lena:p3',
        'lena:p2',
      ]);
      expect((await cast.owner.request('GET', subs('?track=ghost'))).status).toBe(404);
      expect((await cast.owner.request('GET', subs('?verdict=XX'))).status).toBe(400);
      expect((await cast.owner.request('GET', subs('?language=java'))).status).toBe(400);
    });

    it('sorts and pages', async () => {
      await world();
      await record('sol', 'p1', {
        verdict: 'WA',
        testsPassed: 1,
        timeMs: 300,
        at: '2026-10-01T10:00:00Z',
      });
      await record('lena', 'p1', {
        verdict: 'AC',
        testsPassed: 2,
        timeMs: 50,
        at: '2026-10-02T10:00:00Z',
      });
      await record('ada', 'p1', {
        verdict: 'AC',
        testsPassed: 2,
        timeMs: 120,
        at: '2026-10-03T10:00:00Z',
      });
      const names = async (query: string) =>
        (await cast.owner.request('GET', subs(`?${query}`))).body.items.map(
          (item: { member: { username: string } }) => item.member.username
        );
      expect(await names('sort=newest')).toEqual(['ada', 'lena', 'sol']);
      expect(await names('sort=oldest')).toEqual(['sol', 'lena', 'ada']);
      expect(await names('sort=member')).toEqual(['ada', 'lena', 'sol']);
      expect(await names('sort=time')).toEqual(['lena', 'ada', 'sol']);
      expect((await names('sort=tests_passed'))[2]).toBe('sol');
      const page = await cast.owner.request('GET', subs('?page_size=2&page=2'));
      expect(page.body).toMatchObject({ page: 2, page_size: 2, total: 3 });
      expect(page.body.items).toHaveLength(1);
      expect((await cast.owner.request('GET', subs('?page_size=51'))).status).toBe(400);
    });

    it('lists the versions that exist, for the filter', async () => {
      await world();
      expect((await cast.owner.request('GET', subs('/versions'))).body.items).toEqual([1]);
      expect((await cast.owner.request('GET', subs('/versions?problem=p1'))).body.items).toEqual([
        1,
      ]);
    });

    it('only the Space’s own submissions are listed', async () => {
      await world();
      await record('sol', 'p1');
      const other = await t.login({
        providerAccountId: 'x',
        email: 'x@example.com',
        usernameHint: 'xavier',
      });
      await other.request('POST', '/api/v1/spaces', { name: 'Other', slug: 'other' });
      expect((await cast.owner.request('GET', subs())).body.total).toBe(1);
      expect((await other.request('GET', '/api/v1/spaces/other/submissions')).body.total).toBe(0);
    });
  });

  describe('which Track a submission counts towards', () => {
    it('is the Track the solver names, else the first one that reaches the problem', async () => {
      await world(); // p2 is in "general" and in "week-2"
      const first = await submitCode(cast.solver, cast.slug, 'p2');
      expect(first.status).toBe(202);
      const named = await submitCode(cast.solver, cast.slug, 'p2', { track: 'week-2' });
      expect(named.status).toBe(202);
      const rows = await t.prisma.submission.findMany({
        include: { track: true },
        orderBy: { created_at: 'asc' },
      });
      expect(rows.map((row) => row.track?.slug)).toEqual(['general', 'week-2']);
    });

    it('refuses a Track that does not reach the problem or that the solver cannot reach', async () => {
      await world();
      await cast.owner.request('POST', `${base()}/tracks`, {
        name: 'Closed',
        slug: 'closed',
        privacy: 'members',
      });
      await cast.owner.request('PUT', `${base()}/tracks/closed/collections`, {
        collection_slugs: ['extra'],
      });
      for (const track of ['week-2-nope', 'closed']) {
        const response = await submitCode(cast.solver, cast.slug, 'p1', { track });
        expect({ track, status: response.status }).toEqual({ track, status: 400 });
      }
      // p2 is in "closed", but the solver is not a member, so it does not count
      const hidden = await submitCode(cast.solver, cast.slug, 'p2', { track: 'closed' });
      expect(hidden.status).toBe(400);
      expect(await t.prisma.submission.count()).toBe(0);
    });

    it('is empty for staff who submit to a problem outside every Track', async () => {
      await world();
      expect((await submitCode(cast.editor, cast.slug, 'p3')).status).toBe(202);
      const row = await t.prisma.submission.findFirstOrThrow();
      expect(row.track_id).toBeNull();
    });

    it('survives the Track being archived, and is cleared if the Track is deleted from the database', async () => {
      await world();
      await submitCode(cast.solver, cast.slug, 'p1');
      await cast.owner.request('DELETE', `${base()}/tracks/general`);
      expect((await cast.owner.request('GET', subs())).body.items[0].track).toMatchObject({
        slug: 'general',
      });
      await t.prisma.track.deleteMany({ where: { slug: 'general' } });
      expect((await cast.owner.request('GET', subs())).body.items[0].track).toBeNull();
    });
  });

  describe('by member', () => {
    it('counts problems tried and solved, submissions, accepted rate and the last verdict', async () => {
      await world();
      await record('sol', 'p1', { verdict: 'WA', at: '2026-10-01T10:00:00Z' });
      await record('sol', 'p1', { verdict: 'AC', at: '2026-10-02T10:00:00Z' });
      await record('sol', 'p2', { verdict: 'TLE', at: '2026-10-03T10:00:00Z' });
      await record('sol', 'p2', { verdict: 'ISE', at: '2026-10-04T10:00:00Z' }); // not their fault: no verdict stats
      await record('lena', 'p1', { verdict: 'AC', at: '2026-10-05T10:00:00Z' });
      const response = await cast.owner.request('GET', subs('/by-member'));
      expect(response.status).toBe(200);
      expect(response.body.totals).toEqual({ members: 2, submissions: 5 });
      const [lena, sol] = response.body.items;
      expect(lena).toMatchObject({
        user: { username: 'lena' },
        role: 'solver',
        attempted: 1,
        solved: 1,
        submissions: 1,
        ac_rate: 1,
        last_verdict: 'AC',
      });
      expect(sol).toMatchObject({
        user: { username: 'sol' },
        attempted: 2,
        solved: 1,
        submissions: 4,
        last_verdict: 'TLE',
        last_submission_at: '2026-10-04T10:00:00.000Z',
      });
      expect(sol.ac_rate).toBeCloseTo(0.25);
    });

    it('hides members with no submissions unless asked not to', async () => {
      await world();
      await record('sol', 'p1');
      const hidden = await cast.owner.request('GET', subs('/by-member'));
      expect(
        hidden.body.items.map((item: { user: { username: string } }) => item.user.username)
      ).toEqual(['sol']);
      const all = await cast.owner.request('GET', subs('/by-member?hide_empty=false'));
      expect(all.body.items.length).toBe(6);
      const idle = all.body.items.find(
        (item: { user: { username: string } }) => item.user.username === 'edith'
      );
      expect(idle).toMatchObject({
        role: 'editor',
        attempted: 0,
        solved: 0,
        submissions: 0,
        ac_rate: null,
        last_verdict: null,
        last_submission_at: null,
      });
    });

    it('filters by search, role, Track and time window, and sorts', async () => {
      await world();
      const now = Date.now();
      const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
      await record('sol', 'p1', { trackSlug: 'general', verdict: 'AC', at: daysAgo(2) });
      await record('sol', 'p2', { trackSlug: 'week-2', verdict: 'AC', at: daysAgo(3) });
      await record('lena', 'p1', { trackSlug: 'general', verdict: 'WA', at: daysAgo(20) });
      await record('edith', 'p1', { trackSlug: 'general', verdict: 'AC', at: daysAgo(40) });
      const names = async (query: string) =>
        (await cast.owner.request('GET', subs(`/by-member?${query}`))).body.items.map(
          (item: { user: { username: string } }) => item.user.username
        );
      expect(await names('')).toEqual(['sol', 'lena', 'edith']);
      expect(await names('q=LEN')).toEqual(['lena']);
      expect(await names('role=editor')).toEqual(['edith']);
      expect(await names('role=solver')).toEqual(['sol', 'lena']);
      expect(await names('window=7d')).toEqual(['sol']);
      expect(await names('window=30d')).toEqual(['sol', 'lena']);
      expect(await names('track=week-2')).toEqual(['sol']);
      expect(await names('sort=solved')).toEqual(['sol', 'edith', 'lena']);
      expect(await names('sort=name')).toEqual(['edith', 'lena', 'sol']);
      expect(await names('page_size=2&page=2')).toEqual(['edith']);
    });

    it('also lists someone who submitted without being a member of a public Space', async () => {
      await world();
      await cast.owner.request('PATCH', base(), { visibility: 'public' });
      expect((await submitCode(cast.outsider, cast.slug, 'p1')).status).toBe(202);
      const response = await cast.owner.request('GET', subs('/by-member'));
      expect(response.body.items[0]).toMatchObject({
        user: { username: 'otto' },
        role: null,
        submissions: 1,
      });
      const filtered = await cast.owner.request('GET', subs('/by-member?role=none'));
      expect(filtered.body.items).toHaveLength(1);
    });

    it('shows the problems one member tried, with attempts and best and last verdict', async () => {
      await world();
      await record('sol', 'p1', {
        verdict: 'WA',
        trackSlug: 'general',
        at: '2026-10-01T10:00:00Z',
      });
      await record('sol', 'p1', {
        verdict: 'TLE',
        trackSlug: 'general',
        at: '2026-10-02T10:00:00Z',
      });
      await record('sol', 'p2', { verdict: 'AC', trackSlug: 'week-2', at: '2026-10-03T10:00:00Z' });
      await record('sol', 'p3', { verdict: 'CE', trackSlug: null, at: '2026-10-04T10:00:00Z' });
      await record('lena', 'p1', { verdict: 'AC' });
      const response = await cast.owner.request('GET', subs('/by-member/sol/problems'));
      expect(response.status).toBe(200);
      expect(response.body.member).toMatchObject({
        user: { username: 'sol' },
        attempted: 3,
        solved: 1,
        submissions: 4,
      });
      const bySlug = Object.fromEntries(
        response.body.items.map((item: { problem: { slug: string } }) => [item.problem.slug, item])
      );
      expect(bySlug.p1).toMatchObject({
        attempts: 2,
        solved: false,
        best_verdict: 'WA',
        last_verdict: 'TLE',
        track: { slug: 'general' },
      });
      expect(bySlug.p2).toMatchObject({
        attempts: 1,
        solved: true,
        best_verdict: 'AC',
        track: { slug: 'week-2' },
      });
      expect(bySlug.p3).toMatchObject({ best_verdict: 'CE', track: null });

      const names = async (query: string) =>
        (await cast.owner.request('GET', subs(`/by-member/sol/problems?${query}`))).body.items.map(
          (item: { problem: { slug: string } }) => item.problem.slug
        );
      expect(await names('')).toEqual(['p3', 'p2', 'p1']);
      expect(await names('status=solved')).toEqual(['p2']);
      expect(await names('status=unsolved')).toEqual(['p3', 'p1']);
      expect(await names('track=general')).toEqual(['p1']);
      expect((await names('sort=attempts'))[0]).toBe('p1');
      expect(await names('q=p2')).toEqual(['p2']);
      expect((await cast.owner.request('GET', subs('/by-member/nobody/problems'))).status).toBe(
        404
      );
    });
  });

  describe('by Track', () => {
    it('counts problems, members, submissions, accepted and members who finished', async () => {
      await world();
      // "general" has p1 and p2: sol solves both, lena only one
      await record('sol', 'p1', { trackSlug: 'general', verdict: 'AC' });
      await record('sol', 'p2', { trackSlug: 'general', verdict: 'AC' });
      await record('lena', 'p1', { trackSlug: 'general', verdict: 'AC' });
      await record('lena', 'p2', {
        trackSlug: 'general',
        verdict: 'WA',
        at: '2026-10-06T10:00:00Z',
      });
      await record('sol', 'p2', { trackSlug: 'week-2', verdict: 'WA' });
      const response = await cast.owner.request('GET', subs('/by-track'));
      expect(response.status).toBe(200);
      const [general, week2] = response.body.items;
      expect(general).toMatchObject({
        track: { slug: 'general', privacy: 'space', is_default: true },
        problems: 2,
        members: 6,
        submissions: 4,
        accepted: 3,
        members_finished: 1,
      });
      expect(week2).toMatchObject({
        track: { slug: 'week-2' },
        problems: 1,
        submissions: 1,
        accepted: 0,
        // finishing a Track is about solving its problems, wherever the accepted submission came from
        members_finished: 1,
      });
    });

    it('a members-only Track counts its own members', async () => {
      await world();
      await cast.owner.request('POST', `${base()}/tracks`, {
        name: 'Class',
        slug: 'class',
        privacy: 'members',
      });
      await cast.owner.request('PUT', `${base()}/tracks/class/collections`, {
        collection_slugs: ['extra'],
      });
      const invite = await cast.owner.request('POST', `${base()}/tracks/class/invites`, {});
      await cast.outsider.request('POST', `/api/v1/invites/${invite.body.token}/accept`);
      await record('otto', 'p2', { verdict: 'AC' });
      const response = await cast.owner.request('GET', subs('/by-track?privacy=members'));
      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({
        track: { slug: 'class', privacy: 'members' },
        members: 1,
        members_finished: 1,
        problems: 1,
      });
    });

    it('searches, filters by privacy, sorts, and leaves archived Tracks out', async () => {
      await world();
      await record('sol', 'p2', { trackSlug: 'week-2', verdict: 'AC', at: '2026-10-09T10:00:00Z' });
      await record('sol', 'p1', {
        trackSlug: 'general',
        verdict: 'AC',
        at: '2026-10-01T10:00:00Z',
      });
      const slugs = async (query: string) =>
        (await cast.owner.request('GET', subs(`/by-track?${query}`))).body.items.map(
          (item: { track: { slug: string } }) => item.track.slug
        );
      expect(await slugs('')).toEqual(['general', 'week-2']);
      expect(await slugs('sort=last_submission')).toEqual(['week-2', 'general']);
      expect(await slugs('q=week')).toEqual(['week-2']);
      expect(await slugs('privacy=members')).toEqual([]);
      await cast.owner.request('DELETE', `${base()}/tracks/week-2`);
      expect(await slugs('')).toEqual(['general']);
    });

    it('lists the problems of a Track with the most common failure', async () => {
      await world();
      await createDraft(cast.editor, cast.slug, 'wip');
      await cast.owner.request('PATCH', `${base()}/collections/main/problems`, { add: ['wip'] });
      for (let i = 0; i < 3; i++) {
        await record('sol', 'p1', { trackSlug: 'general', verdict: 'WA', failedTest: 4 });
      }
      await record('lena', 'p1', { trackSlug: 'general', verdict: 'WA', failedTest: 1 });
      await record('lena', 'p1', { trackSlug: 'general', verdict: 'TLE', failedTest: 4 });
      await record('lena', 'p1', { trackSlug: 'general', verdict: 'AC' });
      await record('lena', 'p1', { trackSlug: 'general', verdict: 'ISE' }); // never a failure
      await record('lena', 'p1', { trackSlug: 'week-2', verdict: 'RE', failedTest: 2 }); // another Track
      await record('sol', 'p2', { trackSlug: 'general', verdict: 'CE' });
      const response = await cast.owner.request('GET', subs('/by-track/general/problems'));
      expect(response.status).toBe(200);
      expect(response.body.track).toMatchObject({
        slug: 'general',
        collections: 1,
        problems: 3,
        submissions: 8,
        accepted: 1,
      });
      const bySlug = Object.fromEntries(
        response.body.items.map((item: { problem: { slug: string } }) => [item.problem.slug, item])
      );
      expect(bySlug.p1).toMatchObject({
        problem: { status: 'published' },
        collections: [{ slug: 'main' }],
        tried: 2,
        solved: 1,
        submissions: 7,
        most_common_failure: { verdict: 'WA', test_position: 4, count: 3 },
      });
      expect(bySlug.p2.most_common_failure).toEqual({
        verdict: 'CE',
        test_position: null,
        count: 1,
      });
      expect(bySlug.wip).toMatchObject({
        problem: { status: 'draft' },
        tried: 0,
        submissions: 0,
        most_common_failure: null,
        last_submission_at: null,
      });
    });

    it('filters the problems of a Track by search, collection, status and sorts them', async () => {
      await world();
      await createDraft(cast.editor, cast.slug, 'wip');
      await cast.owner.request('PATCH', `${base()}/collections/extra/problems`, { add: ['wip'] });
      await cast.owner.request('PUT', `${base()}/tracks/general/collections`, {
        collection_slugs: ['main', 'extra'],
      });
      await record('sol', 'p1', {
        trackSlug: 'general',
        verdict: 'AC',
        at: '2026-10-01T10:00:00Z',
      });
      await record('lena', 'p2', {
        trackSlug: 'general',
        verdict: 'WA',
        at: '2026-10-09T10:00:00Z',
      });
      const slugs = async (query: string) =>
        (
          await cast.owner.request('GET', subs(`/by-track/general/problems?${query}`))
        ).body.items.map((item: { problem: { slug: string } }) => item.problem.slug);
      expect(await slugs('')).toEqual(['p1', 'p2', 'wip']);
      expect(await slugs('collection=extra')).toEqual(['p2', 'wip']);
      expect(await slugs('status=draft')).toEqual(['wip']);
      expect(await slugs('status=published')).toEqual(['p1', 'p2']);
      expect(await slugs('q=p2')).toEqual(['p2']);
      expect(await slugs('sort=last_submission')).toEqual(['p2', 'p1', 'wip']);
      expect((await slugs('sort=solved_fewest'))[0]).not.toBe('p1');
      expect((await cast.owner.request('GET', subs('/by-track/ghost/problems'))).status).toBe(404);
    });
  });

  describe('by problem', () => {
    it('counts people who tried and solved, submissions and the last verdict, over every Track', async () => {
      await world();
      await record('sol', 'p2', {
        trackSlug: 'general',
        verdict: 'WA',
        at: '2026-10-01T10:00:00Z',
      });
      await record('sol', 'p2', { trackSlug: 'week-2', verdict: 'AC', at: '2026-10-02T10:00:00Z' });
      await record('lena', 'p2', {
        trackSlug: 'week-2',
        verdict: 'TLE',
        at: '2026-10-03T10:00:00Z',
      });
      const response = await cast.owner.request('GET', subs('/by-problem'));
      const p2 = response.body.items.find(
        (item: { problem: { slug: string } }) => item.problem.slug === 'p2'
      );
      expect(p2).toMatchObject({
        tried: 2,
        solved: 1,
        submissions: 3,
        last_verdict: 'TLE',
        tracks: [{ slug: 'general' }, { slug: 'week-2' }],
      });
      const p3 = response.body.items.find(
        (item: { problem: { slug: string } }) => item.problem.slug === 'p3'
      );
      expect(p3).toMatchObject({ tracks: [], tried: 0, submissions: 0, last_verdict: null });
    });

    it('filters by Track (also "none"), status and search, and sorts and pages', async () => {
      await world();
      await createDraft(cast.editor, cast.slug, 'wip');
      await record('sol', 'p1', { verdict: 'AC', at: '2026-10-01T10:00:00Z' });
      await record('sol', 'p2', { verdict: 'WA', at: '2026-10-05T10:00:00Z' });
      await record('lena', 'p2', { verdict: 'WA', at: '2026-10-06T10:00:00Z' });
      const slugs = async (query: string) =>
        (await cast.owner.request('GET', subs(`/by-problem?${query}`))).body.items.map(
          (item: { problem: { slug: string } }) => item.problem.slug
        );
      expect(await slugs('')).toEqual(['p2', 'p1', 'p3', 'wip']);
      expect(await slugs('track=none')).toEqual(['p3', 'wip']);
      expect(await slugs('track=week-2')).toEqual(['p2']);
      expect(await slugs('status=draft')).toEqual(['wip']);
      expect(await slugs('q=p1')).toEqual(['p1']);
      expect(await slugs('sort=submissions')).toEqual(['p2', 'p1', 'p3', 'wip']);
      expect((await slugs('sort=solved_fewest'))[0]).not.toBe('p1');
      expect(await slugs('sort=name&page_size=2&page=2')).toEqual(['p3', 'wip']);
    });
  });

  describe('one test of a submission: input, expected, output and stderr', () => {
    async function judged(
      options: {
        stdout?: string;
        stderr?: string;
        stdoutSize?: number;
        verdict?: string;
        by?: Cast['solver'];
      } = {}
    ) {
      await createPublishedProblem(cast, 'p1');
      const submitted = await submitCode(options.by ?? cast.solver, cast.slug, 'p1');
      await t.settle();
      const result = jobResult(t.judge.last, { verdict: (options.verdict ?? 'WA') as 'WA' });
      result.tests[0] = {
        ...result.tests[0]!,
        verdict: 'AC',
        stdout: '3\n',
        stdout_size_bytes: 2,
      };
      result.tests[1] = {
        ...result.tests[1]!,
        verdict: (options.verdict ?? 'WA') as 'WA',
        stdout: options.stdout ?? '5\n',
        stdout_size_bytes: options.stdoutSize ?? Buffer.byteLength(options.stdout ?? '5\n'),
        stderr: options.stderr ?? 'warning: something',
        stderr_size_bytes: Buffer.byteLength(options.stderr ?? 'warning: something'),
      };
      result.summary.passed = 1;
      expect((await t.deliver(result)).status).toBe(204);
      return submitted.body.id as string;
    }

    it('asks Judge to send the output back', async () => {
      await createPublishedProblem(cast, 'p1');
      await submitCode(cast.solver, cast.slug, 'p1');
      await t.settle();
      expect(t.judge.last.capture).toEqual({
        stdout_bytes: 65536,
        stderr_bytes: 8192,
        total_bytes: 2097152,
      });
    });

    it('shows staff the hidden test: input, expected output, what the program printed, stderr', async () => {
      const observer = await addMember('olga', 'observer');
      const id = await judged();
      for (const client of [cast.owner, cast.editor, observer]) {
        const detail = await client.request('GET', `/api/v1/submissions/${id}/tests/2`);
        expect(detail.status).toBe(200);
        expect(detail.body).toMatchObject({
          submission_id: id,
          position: 2,
          verdict: 'WA',
          is_sample: false,
          input: { lines: ['987654321 123456789'], total_lines: 1 },
          expected: { lines: ['1111111110'], total_lines: 1 },
          output: { lines: ['5'], total_lines: 1, cut: false },
          stderr: { lines: ['warning: something'], cut: false },
        });
      }
      const sample = await cast.owner.request('GET', `/api/v1/submissions/${id}/tests/1`);
      expect(sample.body).toMatchObject({
        is_sample: true,
        input: { lines: ['1 2'] },
        expected: { lines: ['3'] },
        output: { lines: ['3'] },
      });
    });

    it('is closed to solvers, the author included, and to outsiders', async () => {
      const id = await judged();
      expect((await cast.solver.request('GET', `/api/v1/submissions/${id}/tests/2`)).status).toBe(
        404
      );
      expect((await cast.outsider.request('GET', `/api/v1/submissions/${id}/tests/2`)).status).toBe(
        404
      );
      expect((await cast.visitor.request('GET', `/api/v1/submissions/${id}/tests/2`)).status).toBe(
        401
      );
      expect((await cast.owner.request('GET', `/api/v1/submissions/${id}/tests/9`)).status).toBe(
        404
      );
      expect(
        (
          await cast.owner.request(
            'GET',
            `/api/v1/submissions/${'0'.repeat(8)}-0000-4000-8000-000000000000/tests/1`
          )
        ).status
      ).toBe(404);
    });

    it('never puts the hidden output in what solvers and the ordinary detail see', async () => {
      const id = await judged({ stdout: 'HIDDEN-STDOUT-LEAK\n', stderr: 'HIDDEN-STDERR-LEAK' });
      for (const client of [cast.solver, cast.editor, cast.owner]) {
        const responses = [
          await client.request('GET', `/api/v1/submissions/${id}`),
          await client.request('GET', problemUrl(cast.slug, 'p1', '/submissions')),
          await client.text('GET', `/api/v1/submissions/${id}/events`),
        ];
        for (const response of responses) {
          const text = 'text' in response ? response.text : JSON.stringify(response.body);
          expect(text).not.toContain('HIDDEN-STDOUT-LEAK');
          expect(text).not.toContain('HIDDEN-STDERR-LEAK');
        }
      }
      const staff = await cast.owner.request('GET', `/api/v1/submissions/${id}/tests/2`);
      expect(staff.body.output.lines).toEqual(['HIDDEN-STDOUT-LEAK']);
    });

    it('pages a long text by lines and reports the totals', async () => {
      const long = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
      const id = await judged({ stdout: long });
      const first = await cast.owner.request(
        'GET',
        `/api/v1/submissions/${id}/tests/2?part=output&max_lines=10`
      );
      expect(first.body.output).toMatchObject({ from_line: 1, to_line: 10, total_lines: 25 });
      expect(first.body.input).toBeNull();
      expect(first.body.expected).toBeNull();
      const last = await cast.owner.request(
        'GET',
        `/api/v1/submissions/${id}/tests/2?part=output&from_line=21&max_lines=10`
      );
      expect(last.body.output).toMatchObject({
        from_line: 21,
        to_line: 25,
        lines: expect.arrayContaining(['line 25']),
      });
      expect(
        (await cast.owner.request('GET', `/api/v1/submissions/${id}/tests/2?max_lines=1001`)).status
      ).toBe(400);
      expect(
        (await cast.owner.request('GET', `/api/v1/submissions/${id}/tests/2?part=nope`)).status
      ).toBe(400);
    });

    it('says when the kept text is shorter than what the program printed', async () => {
      const id = await judged({ stdout: '12345\n', stdoutSize: 5_000_000 });
      const detail = await cast.owner.request('GET', `/api/v1/submissions/${id}/tests/2`);
      expect(detail.body.output).toMatchObject({ lines: ['12345'], cut: true });
    });

    it('has no output for a submission judged before outputs were kept', async () => {
      await createPublishedProblem(cast, 'p1');
      const submitted = await submitCode(cast.solver, cast.slug, 'p1');
      await t.settle();
      await t.deliver(jobResult(t.judge.last));
      const detail = await cast.owner.request(
        'GET',
        `/api/v1/submissions/${submitted.body.id}/tests/2`
      );
      expect(detail.status).toBe(200);
      expect(detail.body.output).toBeNull();
      expect(detail.body.stderr).toBeNull();
      expect(detail.body.expected).toMatchObject({ lines: ['1111111110'] });
    });

    it('keeps NUL characters out of the database and cuts a runaway result', async () => {
      const id = await judged({ stdout: 'a\u0000b\n' });
      const stored = await t.prisma.submissionTestOutput.findMany();
      expect(stored.some((row) => row.stdout?.includes('\u0000'))).toBe(false);
      expect(
        (await cast.owner.request('GET', `/api/v1/submissions/${id}/tests/2`)).body.output.lines
      ).toEqual(['a�b']);
    });

    it('reports a missing test file as unavailable instead of failing', async () => {
      const id = await judged();
      t.storage.tests.objects.clear();
      const detail = await cast.owner.request('GET', `/api/v1/submissions/${id}/tests/2`);
      expect(detail.status).toBe(200);
      expect(detail.body.input).toMatchObject({ unavailable: true, lines: [] });
      expect(detail.body.output.lines).toEqual(['5']);
    });

    it('an observer cannot ask for a re-judge', async () => {
      const observer = await addMember('olga', 'observer');
      await createPublishedProblem(cast, 'p1');
      const submitted = await submitCode(cast.solver, cast.slug, 'p1');
      await t.settle();
      await t.deliver(
        jobResult(t.judge.last, {
          verdict: 'ISE',
          tests: [],
          error: { code: 'SANDBOX_FAILURE', message: 'x' },
        } as never)
      );
      const detail = await observer.request('GET', `/api/v1/submissions/${submitted.body.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.can_rejudge).toBe(false);
      expect(
        (await observer.request('POST', `/api/v1/submissions/${submitted.body.id}/rejudge`)).status
      ).toBe(403);
      expect(
        (await cast.owner.request('GET', `/api/v1/submissions/${submitted.body.id}`)).body
          .can_rejudge
      ).toBe(true);
    });
  });
});
