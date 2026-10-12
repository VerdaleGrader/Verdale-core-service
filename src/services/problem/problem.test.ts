import {
  Cast,
  HIDDEN,
  SOLUTION_SOURCE,
  addTest,
  castSpace,
  createDraft,
  createPublishedProblem,
  problemUrl,
} from '@/test/fixtures';
import { createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

describeDb('Problems (GRD-21, 22, 47)', () => {
  let t: TestApp;
  let cast: Cast;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    cast = await castSpace(t);
  });
  afterEach(async () => t.close());

  const fieldsOf = (body: { details?: Array<{ field: string }> }) =>
    (body.details ?? []).map((detail) => detail.field);

  describe('data model (GRD-21)', () => {
    it('a new problem is a draft with version 1 as its current version', async () => {
      const editor = await createDraft(cast.editor, cast.slug);
      expect(editor).toMatchObject({
        slug: 'sum',
        status: 'draft',
        editable: true,
        space: { slug: 'team' },
        version: { number: 1, status: 'draft', title: 'Sum of two numbers', published_at: null },
        tests: { count: 0, sample_count: 0, missing_output_count: 0, total_bytes: 0 },
        solutions: { count: 0, has_primary: false },
        can_publish: false,
      });
      const problem = await t.prisma.problem.findFirstOrThrow({ include: { versions: true } });
      expect(problem.current_version_id).toBe(problem.versions[0]!.id);
      expect(problem.space_id).toBeTruthy();
      expect(problem.created_by_id).toBeTruthy();
    });

    it('uses the default limits and all three languages when none are given', async () => {
      const editor = await createDraft(cast.editor, cast.slug);
      expect(editor.version).toMatchObject({
        time_limit_ms: 1000,
        memory_limit_kb: 262144,
        allowed_languages: ['c', 'cpp', 'python'],
      });
    });

    it('slugs are unique inside a Space, but two Spaces can use the same one', async () => {
      await createDraft(cast.editor, cast.slug, 'dup');
      const again = await cast.editor.request('POST', `/api/v1/spaces/${cast.slug}/problems`, {
        slug: 'DUP',
        title: 'Again',
      });
      expect(again.status).toBe(409);
      await cast.owner.request('POST', '/api/v1/spaces', { name: 'Other', slug: 'other' });
      await createDraft(cast.owner, 'other', 'dup');
      expect(await t.prisma.problem.count({ where: { slug: 'dup' } })).toBe(2);
    });

    it('a problem has at most one draft version (database rule)', async () => {
      await createDraft(cast.editor, cast.slug);
      const problem = await t.prisma.problem.findFirstOrThrow();
      await expect(
        t.prisma.problemVersion.create({
          data: {
            problem_id: problem.id,
            version_number: 2,
            title: 'Second draft',
            time_limit_ms: 1000,
            memory_limit_kb: 262144,
            allowed_languages: ['c'],
          },
        })
      ).rejects.toThrow();
    });

    it('the database refuses limits outside the Judge contract and an empty language list', async () => {
      await createDraft(cast.editor, cast.slug);
      const version = await t.prisma.problemVersion.findFirstOrThrow();
      await expect(
        t.prisma.problemVersion.update({ where: { id: version.id }, data: { time_limit_ms: 50 } })
      ).rejects.toThrow();
      await expect(
        t.prisma.problemVersion.update({
          where: { id: version.id },
          data: { memory_limit_kb: 4_000_000 },
        })
      ).rejects.toThrow();
      await expect(
        t.prisma.problemVersion.update({
          where: { id: version.id },
          data: { allowed_languages: [] },
        })
      ).rejects.toThrow();
    });
  });

  describe('create', () => {
    it('owners and editors can; solvers, outsiders and visitors cannot', async () => {
      const url = `/api/v1/spaces/${cast.slug}/problems`;
      const body = (slug: string) => ({ slug, title: 'T' });
      expect((await cast.owner.request('POST', url, body('by-owner'))).status).toBe(201);
      expect((await cast.editor.request('POST', url, body('by-editor'))).status).toBe(201);
      expect((await cast.solver.request('POST', url, body('by-solver'))).status).toBe(403);
      expect((await cast.outsider.request('POST', url, body('by-outsider'))).status).toBe(404); // private Space
      expect((await cast.visitor.request('POST', url, body('by-visitor'))).status).toBe(401); // log in first
      expect(await t.prisma.problem.count()).toBe(2);
    });

    it('a visible Space answers 403, not 404, to a logged-in non-member', async () => {
      const open = await castSpace(t, { visibility: 'public', slug: 'open' });
      const response = await open.outsider.request('POST', '/api/v1/spaces/open/problems', {
        slug: 'x1',
        title: 'T',
      });
      expect(response.status).toBe(403);
    });

    it('is refused in an archived Space', async () => {
      await cast.owner.request('POST', `/api/v1/spaces/${cast.slug}/archive`);
      const response = await cast.owner.request('POST', `/api/v1/spaces/${cast.slug}/problems`, {
        slug: 'late',
        title: 'T',
      });
      expect(response.status).toBe(403);
      expect(response.body.message).toMatch(/archived/);
    });

    it.each([
      [{ slug: 'ok-1', title: '' }, 'title'],
      [{ slug: 'ok-1', title: 'x'.repeat(201) }, 'title'],
      [{ slug: 'ok-1', title: 'T', statement: 'x'.repeat(100_001) }, 'statement'],
      [{ slug: 'ok-1', title: 'T', statement: 'a\u0000b' }, 'statement'],
      [{ slug: 'a', title: 'T' }, 'slug'],
      [{ slug: 'has space', title: 'T' }, 'slug'],
      [{ slug: 'new', title: 'T' }, 'slug'],
      [{ slug: 'tests', title: 'T' }, 'slug'],
      [{ slug: '-lead', title: 'T' }, 'slug'],
      [{ slug: 'ok-1', title: 'T', time_limit_ms: 99 }, 'time_limit_ms'],
      [{ slug: 'ok-1', title: 'T', time_limit_ms: 10_001 }, 'time_limit_ms'],
      [{ slug: 'ok-1', title: 'T', time_limit_ms: 1.5 }, 'time_limit_ms'],
      [{ slug: 'ok-1', title: 'T', memory_limit_kb: 16_383 }, 'memory_limit_kb'],
      [{ slug: 'ok-1', title: 'T', memory_limit_kb: 1_048_577 }, 'memory_limit_kb'],
      [{ slug: 'ok-1', title: 'T', allowed_languages: [] }, 'allowed_languages'],
      [{ slug: 'ok-1', title: 'T', allowed_languages: ['rust'] }, 'allowed_languages.0'],
      [{ slug: 'ok-1', title: 'T', allowed_languages: ['c', 'c'] }, 'allowed_languages'],
    ])('rejects %j with an error on %s', async (body, field) => {
      const response = await cast.editor.request(
        'POST',
        `/api/v1/spaces/${cast.slug}/problems`,
        body
      );
      expect(response.status).toBe(400);
      expect(response.body.error_code).toBe('VALIDATION_FAILED');
      expect(fieldsOf(response.body)).toContain(field);
      expect(await t.prisma.problem.count()).toBe(0);
    });

    it('accepts the limits exactly at the edges of the allowed range', async () => {
      const low = await createDraft(cast.editor, cast.slug, 'low', {
        time_limit_ms: 100,
        memory_limit_kb: 16_384,
      });
      const high = await createDraft(cast.editor, cast.slug, 'high', {
        time_limit_ms: 10_000,
        memory_limit_kb: 1_048_576,
      });
      expect(low.version).toMatchObject({ time_limit_ms: 100, memory_limit_kb: 16_384 });
      expect(high.version).toMatchObject({ time_limit_ms: 10_000, memory_limit_kb: 1_048_576 });
    });

    it('tells the editor the allowed ranges, so the web app need not hard-code them', async () => {
      const editor = await createDraft(cast.editor, cast.slug);
      expect(editor.constraints).toMatchObject({
        time_limit_ms: { min: 100, max: 10_000, default: 1000 },
        memory_limit_kb: { min: 16_384, max: 1_048_576, default: 262_144 },
        languages: ['c', 'cpp', 'python'],
        source_max_bytes: 65_536,
        tests: { max_count: 100, max_file_bytes: 8 * 1024 * 1024 },
      });
    });
  });

  describe('edit (GRD-22)', () => {
    it('changes the statement, limits and languages, and shows the new values', async () => {
      await createDraft(cast.editor, cast.slug);
      const response = await cast.editor.request('PATCH', problemUrl(cast.slug, 'sum'), {
        title: ' Sum ',
        statement: '# New\n\n$$a+b$$',
        time_limit_ms: 2500,
        memory_limit_kb: 131072,
        allowed_languages: ['cpp', 'python'],
      });
      expect(response.status).toBe(200);
      expect(response.body.version).toMatchObject({
        title: 'Sum',
        statement: '# New\n\n$$a+b$$',
        time_limit_ms: 2500,
        memory_limit_kb: 131072,
        allowed_languages: ['cpp', 'python'],
      });
    });

    it('changes only what is sent', async () => {
      await createDraft(cast.editor, cast.slug);
      const response = await cast.editor.request('PATCH', problemUrl(cast.slug, 'sum'), {
        time_limit_ms: 2000,
      });
      expect(response.body.version).toMatchObject({
        title: 'Sum of two numbers',
        time_limit_ms: 2000,
        memory_limit_kb: 262144,
      });
    });

    it.each([
      [{}],
      [{ time_limit_ms: 99 }],
      [{ time_limit_ms: 20_000 }],
      [{ memory_limit_kb: 1 }],
      [{ title: '   ' }],
      [{ allowed_languages: [] }],
    ])('rejects %j', async (body) => {
      await createDraft(cast.editor, cast.slug);
      const response = await cast.editor.request('PATCH', problemUrl(cast.slug, 'sum'), body);
      expect(response.status).toBe(400);
      const stored = await t.prisma.problemVersion.findFirstOrThrow();
      expect(stored.time_limit_ms).toBe(1000);
      expect(stored.title).toBe('Sum of two numbers');
    });

    it('owners and editors can; solvers and outsiders cannot', async () => {
      await createDraft(cast.editor, cast.slug);
      const patch = (client: typeof cast.editor) =>
        client.request('PATCH', problemUrl(cast.slug, 'sum'), { title: 'Changed' });
      expect((await patch(cast.owner)).status).toBe(200);
      expect((await patch(cast.editor)).status).toBe(200);
      expect((await patch(cast.solver)).status).toBe(403);
      expect((await patch(cast.outsider)).status).toBe(404);
      expect((await patch(cast.visitor)).status).toBe(401);
    });

    it('a missing problem is 404 for authors', async () => {
      const response = await cast.editor.request('PATCH', problemUrl(cast.slug, 'nope'), {
        title: 'x',
      });
      expect(response.status).toBe(404);
    });

    it('a solver cannot tell a draft from a missing problem on author endpoints', async () => {
      await createDraft(cast.editor, cast.slug, 'secret-draft');
      const draft = await cast.solver.request(
        'GET',
        problemUrl(cast.slug, 'secret-draft', '/editor')
      );
      const missing = await cast.solver.request('GET', problemUrl(cast.slug, 'no-such', '/editor'));
      expect(draft.status).toBe(403);
      expect(missing.status).toBe(403);
    });

    it('is refused in an archived Space', async () => {
      await createDraft(cast.editor, cast.slug);
      await cast.owner.request('POST', `/api/v1/spaces/${cast.slug}/archive`);
      const response = await cast.editor.request('PATCH', problemUrl(cast.slug, 'sum'), {
        title: 'x',
      });
      expect(response.status).toBe(403);
    });

    it('concurrent edits do not lose the problem (last write wins)', async () => {
      await createDraft(cast.editor, cast.slug);
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          cast.editor.request('PATCH', problemUrl(cast.slug, 'sum'), { title: `T${n}` })
        )
      );
      expect(results.every((response) => response.status === 200)).toBe(true);
      expect((await t.prisma.problemVersion.findFirstOrThrow()).title).toMatch(/^T[1-5]$/);
    });
  });

  describe('delete and archive', () => {
    it('a draft can be deleted by an author, with its tests and solutions', async () => {
      await createDraft(cast.editor, cast.slug);
      await addTest(cast.editor, cast.slug, 'sum', '1\n', '1\n', true);
      await cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/solutions'), {
        language: 'cpp',
        source: SOLUTION_SOURCE,
      });
      expect((await cast.solver.request('DELETE', problemUrl(cast.slug, 'sum'))).status).toBe(403);
      expect((await cast.editor.request('DELETE', problemUrl(cast.slug, 'sum'))).status).toBe(204);
      expect(await t.prisma.problem.count()).toBe(0);
      expect(await t.prisma.testCase.count()).toBe(0);
      expect(await t.prisma.referenceSolution.count()).toBe(0);
      expect(
        (await cast.editor.request('GET', problemUrl(cast.slug, 'sum', '/editor'))).status
      ).toBe(404);
    });

    it('a published problem cannot be deleted: archive it instead', async () => {
      await createPublishedProblem(cast);
      const response = await cast.editor.request('DELETE', problemUrl(cast.slug, 'sum'));
      expect(response.status).toBe(409);
      expect(response.body.error_code).toBe('PROBLEM_PUBLISHED');
      expect(await t.prisma.problem.count()).toBe(1);
      // ...and the database says no too, whatever the service does.
      await expect(t.prisma.problem.deleteMany()).rejects.toThrow(/cannot be deleted/);
    });

    it('archiving closes a published problem to submissions but keeps it readable', async () => {
      await createPublishedProblem(cast);
      const archived = await cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/archive'));
      expect(archived.status).toBe(200);
      expect(archived.body).toMatchObject({ status: 'archived', editable: false });
      const read = await cast.solver.request('GET', problemUrl(cast.slug, 'sum'));
      expect(read.body).toMatchObject({ status: 'archived', accepts_submissions: false });
      const list = await cast.solver.request('GET', `/api/v1/spaces/${cast.slug}/problems`);
      expect(list.body.total).toBe(0);
      const submit = await cast.solver.request(
        'POST',
        problemUrl(cast.slug, 'sum', '/submissions'),
        {
          language: 'cpp',
          source: 'int main(){}',
        }
      );
      expect(submit.status).toBe(409);
      expect(submit.body.error_code).toBe('PROBLEM_NOT_OPEN');
    });

    it('archiving again changes nothing, and a never-published draft cannot be archived', async () => {
      await createDraft(cast.editor, cast.slug, 'draft-one');
      const draft = await cast.editor.request(
        'POST',
        problemUrl(cast.slug, 'draft-one', '/archive')
      );
      expect(draft.status).toBe(409);
      await createPublishedProblem(cast, 'live');
      await cast.editor.request('POST', problemUrl(cast.slug, 'live', '/archive'));
      expect(
        (await cast.editor.request('POST', problemUrl(cast.slug, 'live', '/archive'))).status
      ).toBe(200);
    });

    it('solvers cannot archive', async () => {
      await createPublishedProblem(cast);
      expect(
        (await cast.solver.request('POST', problemUrl(cast.slug, 'sum', '/archive'))).status
      ).toBe(403);
    });
  });

  describe('a published version never changes (GRD-21)', () => {
    async function published() {
      await createPublishedProblem(cast);
      return t.prisma.problemVersion.findFirstOrThrow({ include: { test_cases: true } });
    }

    it('PATCH answers 409 VERSION_PUBLISHED and nothing changes', async () => {
      const before = await published();
      const response = await cast.editor.request('PATCH', problemUrl(cast.slug, 'sum'), {
        title: 'Rewritten',
        time_limit_ms: 5000,
      });
      expect(response.status).toBe(409);
      expect(response.body.error_code).toBe('VERSION_PUBLISHED');
      const after = await t.prisma.problemVersion.findFirstOrThrow();
      expect(after.title).toBe(before.title);
      expect(after.time_limit_ms).toBe(before.time_limit_ms);
      expect(after.statement).toBe(before.statement);
    });

    it('tests and solutions cannot be added, changed or removed either', async () => {
      const version = await published();
      const test = version.test_cases[0]!;
      const calls = [
        addTest(cast.editor, cast.slug, 'sum', '5\n', '5\n'),
        cast.editor.request('PATCH', problemUrl(cast.slug, 'sum', `/tests/${test.id}`), {
          is_sample: false,
        }),
        cast.editor.request('DELETE', problemUrl(cast.slug, 'sum', `/tests/${test.id}`)),
        cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/tests/reorder'), {
          test_ids: version.test_cases.map((candidate) => candidate.id).reverse(),
        }),
        cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/solutions'), {
          language: 'python',
          source: 'print(1)',
        }),
        cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/publish')),
      ];
      for (const response of await Promise.all(calls)) {
        expect(response.status).toBe(409);
        expect(response.body.error_code).toBe('VERSION_PUBLISHED');
      }
      expect(await t.prisma.testCase.count()).toBe(2);
      expect(await t.prisma.referenceSolution.count()).toBe(1);
    });

    it('the database refuses direct writes to a published version, its tests and its solutions', async () => {
      const version = await published();
      await expect(
        t.prisma.problemVersion.update({
          where: { id: version.id },
          data: { statement: 'tampered' },
        })
      ).rejects.toThrow(/published problem version cannot be changed/);
      await expect(
        t.prisma.problemVersion.update({ where: { id: version.id }, data: { status: 'draft' } })
      ).rejects.toThrow(/cannot be changed/);
      await expect(t.prisma.problemVersion.delete({ where: { id: version.id } })).rejects.toThrow(
        /cannot be deleted/
      );
      await expect(
        t.prisma.testCase.update({
          where: { id: version.test_cases[0]!.id },
          data: { is_sample: false },
        })
      ).rejects.toThrow(/cannot be changed/);
      await expect(
        t.prisma.testCase.deleteMany({ where: { problem_version_id: version.id } })
      ).rejects.toThrow(/cannot be changed/);
      await expect(
        t.prisma.testCase.create({
          data: {
            problem_version_id: version.id,
            position: 3,
            input_sha256: 'a'.repeat(64),
            output_sha256: 'b'.repeat(64),
            input_size_bytes: 1,
            output_size_bytes: 1,
          },
        })
      ).rejects.toThrow(/cannot be changed/);
      await expect(
        t.prisma.referenceSolution.deleteMany({ where: { problem_version_id: version.id } })
      ).rejects.toThrow(/cannot be changed/);
      const unchanged = await t.prisma.problemVersion.findFirstOrThrow();
      expect(unchanged.statement).toBe(version.statement);
    });

    it('publishing is a one-way step that sets the published time', async () => {
      const version = await published();
      expect(version.status).toBe('published');
      expect(version.published_at).not.toBeNull();
      const problem = await t.prisma.problem.findFirstOrThrow();
      expect(problem).toMatchObject({ status: 'published', current_version_id: version.id });
    });
  });

  describe('publishing needs a complete draft', () => {
    it('lists what is missing, one entry per item', async () => {
      await createDraft(cast.editor, cast.slug, 'sum', { statement: '' });
      const response = await cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/publish'));
      expect(response.status).toBe(409);
      expect(response.body.error_code).toBe('PUBLISH_BLOCKED');
      expect(fieldsOf(response.body).sort()).toEqual([
        'sample_test',
        'solution',
        'statement',
        'tests',
      ]);
      expect((await t.prisma.problem.findFirstOrThrow()).status).toBe('draft');
    });

    it('needs a primary reference solution before it will publish', async () => {
      await createDraft(cast.editor, cast.slug);
      await addTest(cast.editor, cast.slug, 'sum', '1 2\n', '3\n', true);
      const noSolution = await cast.editor.request(
        'POST',
        problemUrl(cast.slug, 'sum', '/publish')
      );
      expect(fieldsOf(noSolution.body)).toEqual(['solution']);
      const solution = await cast.editor.request(
        'POST',
        problemUrl(cast.slug, 'sum', '/solutions'),
        {
          language: 'cpp',
          source: SOLUTION_SOURCE,
          is_primary: false,
        }
      );
      expect(solution.body.is_primary).toBe(false);
      const stillNo = await cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/publish'));
      expect(fieldsOf(stillNo.body)).toEqual(['solution']);
      await cast.editor.request(
        'PATCH',
        problemUrl(cast.slug, 'sum', `/solutions/${solution.body.id}`),
        {
          is_primary: true,
        }
      );
      expect(
        (await cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/publish'))).status
      ).toBe(200);
    });

    it('needs a sample test so solvers can see an example', async () => {
      await createDraft(cast.editor, cast.slug);
      await addTest(cast.editor, cast.slug, 'sum', '1 2\n', '3\n', false);
      await cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/solutions'), {
        language: 'cpp',
        source: SOLUTION_SOURCE,
      });
      const response = await cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/publish'));
      expect(fieldsOf(response.body)).toEqual(['sample_test']);
    });

    it('the editor view reports the same checklist, and can_publish when it is all green', async () => {
      await createDraft(cast.editor, cast.slug);
      let editor = (await cast.editor.request('GET', problemUrl(cast.slug, 'sum', '/editor'))).body;
      expect(editor.can_publish).toBe(false);
      expect(editor.publish_checks.filter((check: { ok: boolean }) => !check.ok)).toHaveLength(3);
      await addTest(cast.editor, cast.slug, 'sum', '1 2\n', '3\n', true);
      await cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/solutions'), {
        language: 'cpp',
        source: SOLUTION_SOURCE,
      });
      editor = (await cast.editor.request('GET', problemUrl(cast.slug, 'sum', '/editor'))).body;
      expect(editor.can_publish).toBe(true);
      expect(editor.publish_checks.every((check: { ok: boolean }) => check.ok)).toBe(true);
    });

    it('only owners and editors can publish', async () => {
      await createDraft(cast.editor, cast.slug);
      expect(
        (await cast.solver.request('POST', problemUrl(cast.slug, 'sum', '/publish'))).status
      ).toBe(403);
      expect(
        (await cast.outsider.request('POST', problemUrl(cast.slug, 'sum', '/publish'))).status
      ).toBe(404);
    });
  });

  describe('listing (GRD-22, GRD-47)', () => {
    beforeEach(async () => {
      await createPublishedProblem(cast, 'alpha', { title: 'Alpha sums' });
      await createPublishedProblem(cast, 'beta', { title: 'Beta paths' });
      await createDraft(cast.editor, cast.slug, 'gamma-draft', { title: 'Gamma draft' });
      await createDraft(cast.owner, cast.slug, 'owner-draft', { title: 'Owner draft' });
    });

    const list = (client: typeof cast.editor, query = '') =>
      client.request('GET', `/api/v1/spaces/${cast.slug}/problems${query}`);
    const slugs = (response: { body: { items: Array<{ slug: string }> } }) =>
      response.body.items.map((item) => item.slug).sort();

    it('solvers and members see published problems only', async () => {
      const response = await list(cast.solver);
      expect(response.status).toBe(200);
      expect(slugs(response)).toEqual(['alpha', 'beta']);
      expect(response.body).toMatchObject({ total: 2, page: 1, page_size: 20 });
    });

    it('a solver asking for drafts still gets published problems only', async () => {
      for (const query of ['?status=draft', '?status=all', '?status=archived', '?mine=true']) {
        const response = await list(cast.solver, query);
        expect(response.status).toBe(200);
        expect(slugs(response)).toEqual(['alpha', 'beta']);
      }
    });

    it('owners and editors see everything with status=all, or the drafts only, or only their own', async () => {
      expect(slugs(await list(cast.editor, '?status=all'))).toEqual([
        'alpha',
        'beta',
        'gamma-draft',
        'owner-draft',
      ]);
      expect(slugs(await list(cast.editor, '?status=draft'))).toEqual([
        'gamma-draft',
        'owner-draft',
      ]);
      expect(slugs(await list(cast.editor, '?status=draft&mine=true'))).toEqual(['gamma-draft']);
      expect(slugs(await list(cast.owner, '?status=draft&mine=true'))).toEqual(['owner-draft']);
      expect(slugs(await list(cast.editor))).toEqual(['alpha', 'beta']);
    });

    it('searches the title and the slug, ignoring case', async () => {
      expect(slugs(await list(cast.solver, '?q=PATHS'))).toEqual(['beta']);
      expect(slugs(await list(cast.solver, '?q=alp'))).toEqual(['alpha']);
      expect(slugs(await list(cast.solver, '?q=nothing'))).toEqual([]);
    });

    it('paginates and reports the total', async () => {
      const first = await list(cast.solver, '?page=1&page_size=1');
      const second = await list(cast.solver, '?page=2&page_size=1');
      expect(first.body.items).toHaveLength(1);
      expect(second.body.items).toHaveLength(1);
      expect(first.body.items[0].slug).not.toBe(second.body.items[0].slug);
      expect(first.body.total).toBe(2);
      expect((await list(cast.solver, '?page=3&page_size=1')).body.items).toHaveLength(0);
      expect((await list(cast.solver, '?page_size=51')).status).toBe(400);
      expect((await list(cast.solver, '?page=0')).status).toBe(400);
    });

    it('a private Space answers 404 to outsiders and visitors, on every problem endpoint', async () => {
      for (const client of [cast.outsider, cast.visitor]) {
        expect((await list(client)).status).toBe(404);
        expect((await client.request('GET', problemUrl(cast.slug, 'alpha'))).status).toBe(404);
        expect((await client.request('GET', problemUrl(cast.slug, 'gamma-draft'))).status).toBe(
          404
        );
        expect((await client.request('GET', problemUrl(cast.slug, 'nope'))).status).toBe(404);
      }
    });

    it('a public Space lists its published problems to visitors', async () => {
      const open = await castSpace(t, { visibility: 'public', slug: 'open' });
      await createPublishedProblem(open, 'pub');
      await createDraft(open.editor, 'open', 'hidden-draft');
      const response = await open.visitor.request('GET', '/api/v1/spaces/open/problems?status=all');
      expect(response.status).toBe(200);
      expect(response.body.items.map((item: { slug: string }) => item.slug)).toEqual(['pub']);
    });

    it('summaries carry what a list needs and nothing internal', async () => {
      const { items } = (await list(cast.solver, '?q=alpha')).body;
      expect(Object.keys(items[0]).sort()).toEqual([
        'allowed_languages',
        'created_at',
        'created_by',
        'id',
        'memory_limit_kb',
        'published_at',
        'slug',
        'status',
        'time_limit_ms',
        'title',
        'updated_at',
        'version_number',
      ]);
      expect(items[0].created_by).toEqual({
        username: 'edith',
        display_name: 'edith',
        avatar_url: null,
      });
    });
  });

  describe('what a solver sees of a problem (GRD-47)', () => {
    let created: Awaited<ReturnType<typeof createPublishedProblem>>;
    beforeEach(async () => {
      created = await createPublishedProblem(cast);
    });

    it('statement, limits, languages and the sample tests, with their content', async () => {
      const response = await cast.solver.request('GET', problemUrl(cast.slug, 'sum'));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        slug: 'sum',
        status: 'published',
        title: 'Sum of two numbers',
        statement: 'Read $a$ and $b$ and print $a + b$.',
        time_limit_ms: 1000,
        memory_limit_kb: 262144,
        allowed_languages: ['c', 'cpp', 'python'],
        samples: [{ position: 1, input: '1 2\n', output: '3\n' }],
        accepts_submissions: true,
        space: { slug: 'team' },
      });
    });

    it('never contains a hidden test, a reference solution or an internal field, for anyone', async () => {
      const hiddenHashes = [created.hidden.input_sha256, created.hidden.output_sha256];
      for (const client of [cast.solver, cast.outsider, cast.visitor, cast.editor, cast.owner]) {
        const response = await client.request('GET', problemUrl(cast.slug, 'sum'));
        if (response.status === 404) continue; // outsiders and visitors of a private Space
        const text = JSON.stringify(response.body);
        expect(text).not.toContain(HIDDEN.input.trim());
        expect(text).not.toContain(HIDDEN.output.trim());
        for (const hash of hiddenHashes) expect(text).not.toContain(hash);
        expect(text).not.toContain('std::cin');
        expect(text).not.toContain('source');
        expect(text).not.toContain('sha256');
        expect(response.body.samples).toHaveLength(1);
        expect(Object.keys(response.body).sort()).toEqual([
          'accepts_submissions',
          'allowed_languages',
          'created_by',
          'id',
          'memory_limit_kb',
          'published_at',
          'samples',
          'slug',
          'space',
          'statement',
          'statement_mode',
          'statement_pdf',
          'status',
          'time_limit_ms',
          'title',
          'version_number',
        ]);
      }
    });

    it('a sample that is toggled to hidden disappears from the solver view only after a new draft... never, while published', async () => {
      // Published versions are frozen, so the sample set a solver sees cannot change.
      const test = await t.prisma.testCase.findFirstOrThrow({ where: { is_sample: true } });
      const response = await cast.editor.request(
        'PATCH',
        problemUrl(cast.slug, 'sum', `/tests/${test.id}`),
        {
          is_sample: false,
        }
      );
      expect(response.status).toBe(409);
      expect(
        (await cast.solver.request('GET', problemUrl(cast.slug, 'sum'))).body.samples
      ).toHaveLength(1);
    });

    it('a draft is a 404 for solvers and a preview, exactly as solvers will see it, for authors', async () => {
      await createDraft(cast.editor, cast.slug, 'wip', { title: 'Work in progress' });
      await addTest(cast.editor, cast.slug, 'wip', '4 5\n', '9\n', true);
      await addTest(cast.editor, cast.slug, 'wip', '6 7\n', '13\n', false);
      expect((await cast.solver.request('GET', problemUrl(cast.slug, 'wip'))).status).toBe(404);
      const preview = await cast.editor.request('GET', problemUrl(cast.slug, 'wip'));
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({
        status: 'draft',
        accepts_submissions: false,
        samples: [{ position: 1, input: '4 5\n', output: '9\n' }],
      });
      expect(JSON.stringify(preview.body)).not.toContain('6 7');
    });

    it('answers 503 instead of failing when a sample file cannot be read from storage', async () => {
      const original = t.storage.tests.get.bind(t.storage.tests);
      t.storage.tests.get = async () => {
        const { StorageUnavailableError } = await import('@/libs/storage/file-storage');
        throw new StorageUnavailableError('down');
      };
      const response = await cast.solver.request('GET', problemUrl(cast.slug, 'sum'));
      t.storage.tests.get = original;
      expect(response.status).toBe(503);
      expect(response.body.error_code).toBe('UNAVAILABLE');
    });
  });

  describe('the editor view', () => {
    it('is for owners and editors; it shows the draft with its counts', async () => {
      await createDraft(cast.editor, cast.slug);
      await addTest(cast.editor, cast.slug, 'sum', '1 2\n', '3\n', true);
      await addTest(cast.editor, cast.slug, 'sum', '10 20\n', '30\n', false);
      const response = await cast.owner.request('GET', problemUrl(cast.slug, 'sum', '/editor'));
      expect(response.status).toBe(200);
      expect(response.body.tests).toEqual({
        count: 2,
        sample_count: 1,
        missing_output_count: 0,
        total_bytes: 4 + 2 + 6 + 3,
      });
      expect(
        (await cast.solver.request('GET', problemUrl(cast.slug, 'sum', '/editor'))).status
      ).toBe(403);
      expect(
        (await cast.visitor.request('GET', problemUrl(cast.slug, 'sum', '/editor'))).status
      ).toBe(401);
    });

    it('stays readable in an archived Space, but not editable', async () => {
      await createDraft(cast.editor, cast.slug);
      await cast.owner.request('POST', `/api/v1/spaces/${cast.slug}/archive`);
      const response = await cast.editor.request('GET', problemUrl(cast.slug, 'sum', '/editor'));
      expect(response.status).toBe(200);
      expect(response.body.editable).toBe(false);
    });
  });
});
