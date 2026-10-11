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

describeDb('Reference solutions (GRD-26)', () => {
  let t: TestApp;
  let cast: Cast;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    cast = await castSpace(t);
    await createDraft(cast.editor, cast.slug);
  });
  afterEach(async () => t.close());

  const url = (suffix = '') => problemUrl(cast.slug, 'sum', `/solutions${suffix}`);
  const add = (body: Record<string, unknown>, client = cast.editor) =>
    client.request('POST', url(), body);
  const list = async () => (await cast.editor.request('GET', url())).body.items;

  it('stores a solution with its language, source and size, against the problem version', async () => {
    const response = await add({ language: 'cpp', source: SOLUTION_SOURCE });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      language: 'cpp',
      source: SOLUTION_SOURCE,
      source_bytes: Buffer.byteLength(SOLUTION_SOURCE),
      is_primary: true,
      created_by: { username: 'edith' },
    });
    const stored = await t.prisma.referenceSolution.findFirstOrThrow({
      include: { version: true },
    });
    expect(stored.version.status).toBe('draft');
  });

  it('the first solution is primary, later ones are not unless asked', async () => {
    const first = (await add({ language: 'cpp', source: 'int main(){}' })).body;
    const second = (await add({ language: 'python', source: 'print(3)' })).body;
    expect([first.is_primary, second.is_primary]).toEqual([true, false]);
    const third = (await add({ language: 'c', source: 'int main(){}', is_primary: true })).body;
    expect(third.is_primary).toBe(true);
    const items = await list();
    expect(items.filter((item: { is_primary: boolean }) => item.is_primary)).toHaveLength(1);
    expect(items[0].id).toBe(third.id); // the primary comes first
  });

  it('only one solution is primary at a time, also in the database', async () => {
    const a = (await add({ language: 'cpp', source: 'a' })).body;
    const b = (await add({ language: 'cpp', source: 'b' })).body;
    await cast.editor.request('PATCH', url(`/${b.id}`), { is_primary: true });
    const rows = await t.prisma.referenceSolution.findMany({ orderBy: { created_at: 'asc' } });
    expect(rows.map((row) => row.is_primary)).toEqual([false, true]);
    await expect(
      t.prisma.referenceSolution.update({ where: { id: a.id }, data: { is_primary: true } })
    ).rejects.toThrow();
  });

  it('edits the source and language, and removes a solution', async () => {
    const solution = (await add({ language: 'cpp', source: 'old' })).body;
    const edited = await cast.editor.request('PATCH', url(`/${solution.id}`), {
      source: 'new',
      language: 'python',
    });
    expect(edited.body).toMatchObject({ source: 'new', language: 'python', source_bytes: 3 });
    expect((await cast.editor.request('DELETE', url(`/${solution.id}`))).status).toBe(204);
    expect(await list()).toEqual([]);
  });

  it('removing the primary leaves none: the version cannot be published until one is chosen', async () => {
    await addTest(cast.editor, cast.slug, 'sum', '1 2\n', '3\n', true);
    const only = (await add({ language: 'cpp', source: SOLUTION_SOURCE })).body;
    await cast.editor.request('DELETE', url(`/${only.id}`));
    const publish = await cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/publish'));
    expect(publish.status).toBe(409);
    expect(publish.body.details.map((detail: { field: string }) => detail.field)).toEqual([
      'solution',
    ]);
  });

  describe('limits', () => {
    it('refuses an empty source, a NUL character, a language Judge does not run and bad bodies', async () => {
      for (const [body, field] of [
        [{ language: 'cpp', source: '' }, 'source'],
        [{ language: 'cpp', source: 'a\u0000b' }, 'source'],
        [{ language: 'rust', source: 'fn main(){}' }, 'language'],
        [{ source: 'x' }, 'language'],
        [{ language: 'cpp' }, 'source'],
      ] as const) {
        const response = await add(body);
        expect(response.status).toBe(400);
        expect(response.body.details.map((detail: { field: string }) => detail.field)).toContain(
          field
        );
      }
      expect(await t.prisma.referenceSolution.count()).toBe(0);
    });

    it('accepts a source of exactly 64 KiB and refuses one byte more (counted in bytes, not characters)', async () => {
      expect((await add({ language: 'cpp', source: 'a'.repeat(65_536) })).status).toBe(201);
      const over = await add({ language: 'cpp', source: 'a'.repeat(65_537) });
      expect(over.status).toBe(400);
      expect(over.body.details[0].field).toBe('source');
      // 32 769 Thai letters are 98 307 bytes in UTF-8
      expect((await add({ language: 'cpp', source: 'ก'.repeat(21_846) })).status).toBe(400);
      expect((await add({ language: 'cpp', source: 'ก'.repeat(21_845) })).status).toBe(201);
    });

    it('at most 5 solutions per problem', async () => {
      for (let n = 0; n < 5; n++)
        expect((await add({ language: 'cpp', source: `s${n}` })).status).toBe(201);
      const over = await add({ language: 'cpp', source: 'six' });
      expect(over.status).toBe(409);
      expect(over.body.error_code).toBe('SOLUTION_LIMIT_REACHED');
    });
  });

  describe('who can see a reference solution', () => {
    it('owners and editors can list it; nobody else can, whatever the Space type', async () => {
      await add({ language: 'cpp', source: SOLUTION_SOURCE });
      expect((await cast.owner.request('GET', url())).status).toBe(200);
      expect((await cast.editor.request('GET', url())).status).toBe(200);
      expect((await cast.solver.request('GET', url())).status).toBe(403);
      expect((await cast.outsider.request('GET', url())).status).toBe(404);
      expect((await cast.visitor.request('GET', url())).status).toBe(401);

      const open = await castSpace(t, { visibility: 'public', slug: 'open' });
      await createDraft(open.editor, 'open', 'sum');
      await open.editor.request('POST', problemUrl('open', 'sum', '/solutions'), {
        language: 'cpp',
        source: 'secret',
      });
      expect(
        (await open.solver.request('GET', problemUrl('open', 'sum', '/solutions'))).status
      ).toBe(403);
      expect(
        (await open.outsider.request('GET', problemUrl('open', 'sum', '/solutions'))).status
      ).toBe(403);
      expect(
        (await open.visitor.request('GET', problemUrl('open', 'sum', '/solutions'))).status
      ).toBe(401);
    });

    it('only owners and editors can add, change or remove one', async () => {
      const solution = (await add({ language: 'cpp', source: 'mine' })).body;
      for (const [client, status] of [
        [cast.solver, 403],
        [cast.outsider, 404],
        [cast.visitor, 401],
      ] as const) {
        expect((await add({ language: 'cpp', source: 'x' }, client)).status).toBe(status);
        expect(
          (await client.request('PATCH', url(`/${solution.id}`), { source: 'x' })).status
        ).toBe(status);
        expect((await client.request('DELETE', url(`/${solution.id}`))).status).toBe(status);
      }
      expect((await list())[0].source).toBe('mine');
    });

    it('never appears in anything a solver can call, even for a published problem', async () => {
      const secret = 'THE_ANSWER_KEY_42';
      await createDraft(cast.editor, cast.slug, 'guarded');
      await addTest(cast.editor, cast.slug, 'guarded', '1 2\n', '3\n', true);
      await cast.editor.request('POST', problemUrl(cast.slug, 'guarded', '/solutions'), {
        language: 'python',
        source: `# ${secret}\nprint(3)\n`,
      });
      expect(
        (await cast.editor.request('POST', problemUrl(cast.slug, 'guarded', '/publish'))).status
      ).toBe(200);

      const problem = await t.prisma.problem.findFirstOrThrow({ where: { slug: 'guarded' } });
      const calls = [
        cast.solver.request('GET', problemUrl(cast.slug, 'guarded')),
        cast.solver.request('GET', `/api/v1/spaces/${cast.slug}/problems?status=all`),
        cast.solver.request('GET', `/api/v1/spaces/${cast.slug}/problems?q=guarded`),
        cast.solver.request('GET', `/api/v1/spaces/${cast.slug}`),
        cast.solver.request('GET', problemUrl(cast.slug, 'guarded', '/submissions')),
      ];
      for (const response of await Promise.all(calls)) {
        expect(JSON.stringify(response.body)).not.toContain(secret);
        expect(JSON.stringify(response.body)).not.toContain('print(3)');
      }
      expect(problem.id).toBeTruthy();
    });

    it('a published problem keeps its solutions readable by authors only', async () => {
      await createPublishedProblem(cast, 'live');
      const items = (await cast.owner.request('GET', problemUrl(cast.slug, 'live', '/solutions')))
        .body.items;
      expect(items).toHaveLength(1);
      expect(items[0].source).toBe(SOLUTION_SOURCE);
      expect(
        (await cast.solver.request('GET', problemUrl(cast.slug, 'live', '/solutions'))).status
      ).toBe(403);
      expect(
        JSON.stringify((await cast.solver.request('GET', problemUrl(cast.slug, 'live'))).body)
      ).not.toContain(HIDDEN.output.trim());
    });
  });

  it('is refused in an archived Space', async () => {
    await cast.owner.request('POST', `/api/v1/spaces/${cast.slug}/archive`);
    expect((await add({ language: 'cpp', source: 'x' })).status).toBe(403);
  });
});
