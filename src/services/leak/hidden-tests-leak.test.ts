/**
 * CI gate (GRD-56): hidden tests never leave Core through an endpoint a solver can call.
 *
 * Hidden tests carry marker strings that nothing else contains. The test then asks
 * EVERY route the app registers, as a solver, an outsider and a visitor, and looks for
 * the markers in every body and header (answers and error messages included). A leak
 * is reported with the route, who asked, and what leaked, so it can be fixed where it
 * happens. A route added later is crawled too; if it has a path parameter the test
 * cannot fill in, the test fails and says what to add to PARAMETERS.
 *
 * It first proves the markers are really there: staff can read them through the same
 * data (positive control), so "not found in the solver's answers" means something.
 */
import { randomUUID } from 'node:crypto';
import {
  Cast,
  SOLUTION_SOURCE,
  addTest,
  castSpace,
  createDraft,
  placeInTrack,
  problemUrl,
  submitCode,
} from '@/test/fixtures';
import { jobResult, createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

const token = randomUUID().replaceAll('-', '');
const MARKERS = {
  'hidden input': `HIDDEN-INPUT-MARKER-${token}`,
  'hidden expected output': `HIDDEN-OUTPUT-MARKER-${token}`,
  'hidden checker message': `HIDDEN-CHECKER-MARKER-${token}`,
  'hidden program output': `HIDDEN-STDOUT-MARKER-${token}`,
  'hidden program error output': `HIDDEN-STDERR-MARKER-${token}`,
  'reference solution': `SOLUTION-MARKER-${token}`,
} as const;

/** Routes the crawl leaves alone, with the reason. */
const SKIPPED = new Map<string, string>([
  ['POST /api/v1/auth/logout', 'ends the session the crawl is using'],
  ['POST /api/v1/spaces/:slug/leave', 'removes the solver from the Space the crawl is using'],
  [
    'POST /internal/judge/result',
    'signed by Judge, not reachable by solvers (tested in judge-result.test.ts)',
  ],
]);

describeDb('Hidden tests never leak (GRD-56)', () => {
  let t: TestApp;
  let cast: Cast;
  let parameters: Record<string, string>;
  let hiddenPosition = 0;

  beforeAll(async () => {
    // Crawling every route is a lot of requests from one address.
    t = await createTestApp({
      RATE_LIMIT_API_PER_IP: '100000',
      RATE_LIMIT_API_PER_USER: '100000',
      RATE_LIMIT_SUBMIT_PER_USER: '1000',
      RATE_LIMIT_SUBMIT_PER_IP: '1000',
    });
    await resetDatabase(t.prisma);
    cast = await castSpace(t, { visibility: 'public' });

    // A published problem whose hidden test and reference solution carry markers.
    await createDraft(cast.editor, cast.slug, 'sum');
    await addTest(cast.editor, cast.slug, 'sum', '1 2\n', '3\n', true);
    const hidden = await addTest(
      cast.editor,
      cast.slug,
      'sum',
      `${MARKERS['hidden input']} 7\n`,
      `${MARKERS['hidden expected output']}\n`,
      false
    );
    const solution = await cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/solutions'), {
      language: 'cpp',
      source: `// ${MARKERS['reference solution']}\n${SOLUTION_SOURCE}`,
    });
    expect(solution.status).toBe(201);
    await verifyWithCapturedOutput();
    const published = await cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/publish'));
    expect(published.status).toBe(200);
    await placeInTrack(cast, 'sum');

    // A solver's submission that Judge answers with everything a careless Judge could send.
    const submitted = await submitCode(cast.solver, cast.slug, 'sum');
    expect(submitted.status).toBe(202);
    await t.settle();
    const job = t.judge.last;
    const delivered = await t.deliver(
      jobResult(job, {
        verdict: 'WA',
        tests: job.tests.map((test) =>
          test.sample
            ? {
                id: test.id,
                verdict: 'AC' as const,
                time_ms: 5,
                memory_kb: 1024,
                stdout_preview: '3\n',
              }
            : {
                id: test.id,
                verdict: 'WA' as const,
                time_ms: 5,
                memory_kb: 1024,
                stdout_preview: MARKERS['hidden program output'],
                checker_message: `expected ${MARKERS['hidden checker message']}`,
                stdout: `${MARKERS['hidden program output']}\n`,
                stdout_size_bytes: 40,
                stderr: `${MARKERS['hidden program error output']}\n`,
                stderr_size_bytes: 40,
              }
        ),
        summary: { passed: 1, total: 2, time_ms: 5, memory_kb: 1024 },
      })
    );
    expect(delivered.status).toBe(204);
    // A second submission that is still waiting, and an invitation, so those routes have something to find.
    await submitCode(cast.solver, cast.slug, 'sum');
    const invite = await cast.owner.request('POST', `/api/v1/spaces/${cast.slug}/invites`, {
      role: 'solver',
    });

    const detail = (await cast.owner.request('GET', `/api/v1/submissions/${submitted.body.id}`))
      .body;
    hiddenPosition =
      detail.results.findIndex((row: { verdict: string }) => row.verdict === 'WA') + 1;
    parameters = {
      slug: cast.slug,
      problemSlug: 'sum',
      submissionId: submitted.body.id,
      position: String(hiddenPosition),
      testId: hidden.body.id,
      solutionId: solution.body.id,
      side: 'input',
      provider: 'claude',
      token: invite.body.token,
      inviteId: invite.body.id,
      username: 'sol',
      trackSlug: 'general',
      collectionSlug: 'general-set',
      jobId: randomUUID(),
      reportId: randomUUID(),
      name: 'none.png',
    };
  });
  afterAll(async () => t?.close());

  /** Verify run that, like a Judge asked to capture, reports the output of every test. */
  async function verifyWithCapturedOutput() {
    const started = await cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/verify'));
    expect(started.status).toBe(202);
    await t.settle();
    const job = t.judge.last;
    t.judge.jobs = t.judge.jobs.filter((candidate) => candidate !== job);
    const delivered = await t.deliver(
      jobResult(job, {
        kind: 'verify',
        tests: job.tests.map((test) => ({
          id: test.id,
          verdict: 'AC' as const,
          time_ms: 5,
          memory_kb: 1024,
          exit_code: 0,
          ...(test.sample
            ? { stdout_preview: '3\n' }
            : { stdout: `${MARKERS['hidden program output']}\n`, stdout_size_bytes: 40 }),
        })),
      })
    );
    expect(delivered.status).toBe(204);
  }

  describe('the markers are really in the system (positive control)', () => {
    it('staff can read the hidden test, its output and the reference solution', async () => {
      const detail = await cast.owner.request(
        'GET',
        `/api/v1/submissions/${parameters.submissionId}/tests/${hiddenPosition}`
      );
      expect(detail.status).toBe(200);
      const text = JSON.stringify(detail.body);
      expect(text).toContain(MARKERS['hidden input']);
      expect(text).toContain(MARKERS['hidden expected output']);
      expect(text).toContain(MARKERS['hidden program output']);
      expect(text).toContain(MARKERS['hidden program error output']);

      const solutions = await cast.editor.request(
        'GET',
        problemUrl(cast.slug, 'sum', '/solutions')
      );
      expect(JSON.stringify(solutions.body)).toContain(MARKERS['reference solution']);
    });
  });

  describe('every route, asked by people who may not see hidden tests', () => {
    interface Leak {
      route: string;
      actor: string;
      marker: string;
      where: string;
    }
    const leaks: Leak[] = [];
    const answers: Array<{ route: string; actor: string; status: number }> = [];
    let unfilled: string[] = [];

    function fill(pattern: string): string | null {
      let missing = false;
      const url = pattern.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
        const value = parameters[name];
        if (value === undefined) {
          missing = true;
          unfilled.push(`:${name} in ${pattern}`);
          return 'x';
        }
        return encodeURIComponent(value);
      });
      return missing ? null : url;
    }

    async function crawl(
      actorName: string,
      client: { cookie: string },
      methods: 'reads' | 'writes'
    ) {
      for (const route of t.routes) {
        const key = `${route.method} ${route.url}`;
        const isRead = route.method === 'GET'; // HEAD answers share the GET handlers
        if (route.method === 'HEAD' || SKIPPED.has(key) || isRead !== (methods === 'reads'))
          continue;
        const url = fill(route.url);
        if (url === null) continue;
        const response = await t.app.inject({
          method: route.method as 'GET',
          url,
          payload: isRead ? undefined : {},
          headers: {
            ...(client.cookie ? { cookie: client.cookie } : {}),
            origin: 'http://localhost:3000',
          },
        });
        answers.push({ route: key, actor: actorName, status: response.statusCode });
        const searched = {
          body: response.body,
          headers: JSON.stringify(response.headers),
        };
        for (const [name, marker] of Object.entries(MARKERS)) {
          for (const [where, text] of Object.entries(searched)) {
            if (text.includes(marker))
              leaks.push({ route: `${key} → ${url}`, actor: actorName, marker: name, where });
          }
        }
      }
    }

    beforeAll(async () => {
      unfilled = [];
      const actors = [
        ['solver', cast.solver],
        ['outsider', cast.outsider],
        ['visitor', cast.visitor],
      ] as const;
      // Reads first for everybody, then the writes (an empty body: errors must not leak either).
      for (const [name, client] of actors) await crawl(name, client, 'reads');
      for (const [name, client] of actors) await crawl(name, client, 'writes');
    }, 120_000);

    it('finds no hidden content in any answer, header or error message', () => {
      const report = leaks
        .map(
          (leak) => `  ${leak.actor} asked ${leak.route}: ${leak.where} contains the ${leak.marker}`
        )
        .join('\n');
      if (leaks.length > 0) throw new Error(`Hidden test content leaked:\n${report}`);
      expect(leaks).toEqual([]);
    });

    it('could fill in every path parameter, so no route went unchecked', () => {
      const missing = [...new Set(unfilled)];
      if (missing.length > 0) {
        throw new Error(
          `Teach the crawl what to put in these parameters (the parameters object in this file):\n  ${missing.join('\n  ')}`
        );
      }
      expect(missing).toEqual([]);
    });

    it('really reached the data: the crawl got real answers, not only "not found"', () => {
      const solver = answers.filter((answer) => answer.actor === 'solver');
      const ok = (route: string) =>
        solver.some((answer) => answer.route === route && answer.status === 200);
      expect(ok('GET /api/v1/spaces/:slug/problems/:problemSlug')).toBe(true);
      expect(ok('GET /api/v1/submissions/:submissionId')).toBe(true);
      expect(ok('GET /api/v1/spaces/:slug/problems/:problemSlug/submissions')).toBe(true);
      expect(ok('GET /api/v1/submissions/:submissionId/events')).toBe(true);
      expect(solver.filter((answer) => answer.status === 200).length).toBeGreaterThan(10);
      // Every route was asked of every actor.
      const crawled = t.routes.filter(
        (route) => route.method !== 'HEAD' && !SKIPPED.has(`${route.method} ${route.url}`)
      ).length;
      expect(answers.length).toBe(crawled * 3);
    });

    it('is refused the staff-only views of the same data', () => {
      const status = (actor: string, route: string) =>
        answers.find((answer) => answer.actor === actor && answer.route === route)?.status;
      for (const actor of ['solver', 'outsider', 'visitor']) {
        const detail = status(actor, 'GET /api/v1/submissions/:submissionId/tests/:position');
        expect([401, 403, 404]).toContain(detail);
        const tests = status(actor, 'GET /api/v1/spaces/:slug/problems/:problemSlug/tests');
        expect([401, 403, 404]).toContain(tests);
      }
    });
  });
});
