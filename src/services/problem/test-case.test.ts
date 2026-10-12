import { createHash } from 'node:crypto';
import { testFileKey } from '@/libs/storage/file-storage';
import {
  Cast,
  addTest,
  castSpace,
  createDraft,
  createPublishedProblem,
  problemUrl,
} from '@/test/fixtures';
import { createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describeDb('Tests of a problem (GRD-23, 24, 25)', () => {
  let t: TestApp;
  let cast: Cast;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    cast = await castSpace(t);
    await createDraft(cast.editor, cast.slug);
  });
  afterEach(async () => t.close());

  const url = (suffix = '') => problemUrl(cast.slug, 'sum', `/tests${suffix}`);
  const list = async () => (await cast.editor.request('GET', url())).body;
  const detailsOf = (body: { details?: Array<{ field: string; message: string }> }) =>
    body.details ?? [];

  describe('adding (GRD-24)', () => {
    it('stores the files by SHA-256 and records hashes, sizes, order and sample flag', async () => {
      const response = await addTest(cast.editor, cast.slug, 'sum', '1 2\n', '3\n', true);
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        position: 1,
        is_sample: true,
        input_sha256: sha('1 2\n'),
        output_sha256: sha('3\n'),
        input_size_bytes: 4,
        output_size_bytes: 2,
      });
      expect([...t.storage.tests.objects.keys()].sort()).toEqual(
        [testFileKey(sha('1 2\n')), testFileKey(sha('3\n'))].sort()
      );
      expect(t.storage.tests.objects.get(testFileKey(sha('1 2\n')))!.bytes.toString()).toBe(
        '1 2\n'
      );
    });

    it('adds tests at the end, in order', async () => {
      await addTest(cast.editor, cast.slug, 'sum', '1\n', '1\n');
      await addTest(cast.editor, cast.slug, 'sum', '2\n', '2\n');
      await addTest(cast.editor, cast.slug, 'sum', '3\n', '3\n');
      const { items } = await list();
      expect(items.map((item: { position: number }) => item.position)).toEqual([1, 2, 3]);
      expect(items.map((item: { input_sha256: string }) => item.input_sha256)).toEqual(
        ['1\n', '2\n', '3\n'].map(sha)
      );
    });

    it('does not store the same content twice, even across tests and sides', async () => {
      await addTest(cast.editor, cast.slug, 'sum', '5\n', '5\n'); // input and output are identical
      await addTest(cast.editor, cast.slug, 'sum', '5\n', '6\n');
      await addTest(cast.editor, cast.slug, 'sum', '5\r\n', '6'); // same content once normalised
      expect(t.storage.tests.objects.size).toBe(2);
      const { items } = await list();
      expect(items[0].input_sha256).toBe(items[0].output_sha256);
      expect(items[2].input_sha256).toBe(items[1].input_sha256);
      expect(items[2].output_sha256).toBe(items[1].output_sha256);
    });

    it('never overwrites an object that is already there', async () => {
      await addTest(cast.editor, cast.slug, 'sum', '7\n', '7\n');
      const key = testFileKey(sha('7\n'));
      const putSpy = jest.spyOn(t.storage.tests, 'put');
      await addTest(cast.editor, cast.slug, 'sum', '7\n', '8\n');
      expect(putSpy.mock.calls.map(([stored]) => stored)).toEqual([testFileKey(sha('8\n'))]);
      expect(t.storage.tests.objects.has(key)).toBe(true);
    });

    it('is_sample defaults to hidden', async () => {
      const response = await cast.editor.upload('POST', url(), [
        { name: 'input', filename: 'a', content: '1\n' },
        { name: 'output', filename: 'b', content: '1\n' },
      ]);
      expect(response.status).toBe(201);
      expect(response.body.is_sample).toBe(false);
    });

    it('asks for both files', async () => {
      const response = await cast.editor.upload('POST', url(), [
        { name: 'input', filename: 'a', content: '1\n' },
      ]);
      expect(response.status).toBe(400);
      expect(detailsOf(response.body)).toEqual([
        { field: 'output', message: 'Add the output file.' },
      ]);
      const none = await cast.editor.upload('POST', url(), [
        { name: 'is_sample', content: 'true' },
      ]);
      expect(detailsOf(none.body).map((detail) => detail.field)).toEqual(['input', 'output']);
    });

    it('refuses a request that is not multipart', async () => {
      const response = await cast.editor.request('POST', url(), { input: '1', output: '1' });
      expect(response.status).toBe(400);
    });

    it('refuses an is_sample that is not true or false', async () => {
      const response = await cast.editor.upload('POST', url(), [
        { name: 'input', filename: 'a', content: '1\n' },
        { name: 'output', filename: 'b', content: '1\n' },
        { name: 'is_sample', content: 'maybe' },
      ]);
      expect(response.status).toBe(400);
      expect(detailsOf(response.body)[0]!.field).toBe('is_sample');
    });

    it('owners and editors can; solvers get 403, outsiders 404, visitors 401', async () => {
      expect((await addTest(cast.owner, cast.slug, 'sum', '1\n', '1\n')).status).toBe(201);
      expect((await addTest(cast.editor, cast.slug, 'sum', '1\n', '1\n')).status).toBe(201);
      expect((await addTest(cast.solver, cast.slug, 'sum', '1\n', '1\n')).status).toBe(403);
      expect((await addTest(cast.outsider, cast.slug, 'sum', '1\n', '1\n')).status).toBe(404);
      expect((await addTest(cast.visitor, cast.slug, 'sum', '1\n', '1\n')).status).toBe(401);
      expect((await list()).items).toHaveLength(2);
    });

    it('is refused in an archived Space', async () => {
      await cast.owner.request('POST', `/api/v1/spaces/${cast.slug}/archive`);
      expect((await addTest(cast.editor, cast.slug, 'sum', '1\n', '1\n')).status).toBe(403);
    });

    it('a missing problem is 404', async () => {
      expect((await addTest(cast.editor, cast.slug, 'nope', '1\n', '1\n')).status).toBe(404);
    });

    it('does not read the upload for someone who may not edit', async () => {
      const spy = jest.spyOn(t.storage.tests, 'put');
      await addTest(cast.solver, cast.slug, 'sum', 'x\n', 'y\n');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('checking and normalising files (GRD-25)', () => {
    it('turns CRLF into LF and stores one final newline', async () => {
      const response = await addTest(cast.editor, cast.slug, 'sum', '3\r\n1 2 3\r\n\r\n\r\n', '6');
      expect(response.status).toBe(201);
      expect(
        t.storage.tests.objects.get(testFileKey(response.body.input_sha256))!.bytes.toString()
      ).toBe('3\n1 2 3\n');
      expect(
        t.storage.tests.objects.get(testFileKey(response.body.output_sha256))!.bytes.toString()
      ).toBe('6\n');
      expect(response.body.input_size_bytes).toBe(8);
    });

    it('accepts an empty input (a problem may have none)', async () => {
      const response = await addTest(cast.editor, cast.slug, 'sum', '', '42\n');
      expect(response.status).toBe(201);
      expect(response.body.input_size_bytes).toBe(0);
    });

    it('refuses a binary file and says which file and why', async () => {
      const response = await cast.editor.upload('POST', url(), [
        { name: 'input', filename: 'data.bin', content: Buffer.from([0x31, 0x00, 0x32]) },
        { name: 'output', filename: 'out.txt', content: '3\n' },
      ]);
      expect(response.status).toBe(400);
      expect(response.body.error_code).toBe('VALIDATION_FAILED');
      expect(detailsOf(response.body)).toHaveLength(1);
      expect(detailsOf(response.body)[0]).toEqual({
        field: 'input',
        message:
          '“data.bin” (input) contains a NUL byte at offset 1, so it looks like a binary file; only UTF-8 text is accepted.',
      });
      expect(await t.prisma.testCase.count()).toBe(0);
      expect(t.storage.tests.objects.size).toBe(0);
    });

    it('refuses text that is not UTF-8', async () => {
      const response = await cast.editor.upload('POST', url(), [
        { name: 'input', filename: 'in.txt', content: '1\n' },
        { name: 'output', filename: 'latin1.txt', content: Buffer.from('café\n', 'latin1') },
      ]);
      expect(response.status).toBe(400);
      expect(detailsOf(response.body)[0]!.field).toBe('output');
      expect(detailsOf(response.body)[0]!.message).toMatch(
        /“latin1.txt” \(output\) is not valid UTF-8 text/
      );
    });

    it('reports a problem in each file when both are bad', async () => {
      const response = await cast.editor.upload('POST', url(), [
        { name: 'input', filename: 'a.bin', content: Buffer.from([0, 1, 2]) },
        { name: 'output', filename: 'b.bin', content: Buffer.from([0xff, 0xfe]) },
      ]);
      expect(detailsOf(response.body).map((detail) => detail.field)).toEqual(['input', 'output']);
    });

    it('refuses a file over the size limit, naming it', async () => {
      const big = 'x'.repeat(8 * 1024 * 1024 + 1);
      const response = await cast.editor.upload('POST', url(), [
        { name: 'input', filename: 'huge.in', content: big },
        { name: 'output', filename: 'out.txt', content: '1\n' },
      ]);
      expect(response.status).toBe(400);
      expect(detailsOf(response.body)).toEqual([
        { field: 'input', message: '“huge.in” is larger than 8 MiB.' },
      ]);
    });

    it('accepts a file just under the limit', async () => {
      const ok = 'y'.repeat(8 * 1024 * 1024 - 1);
      const response = await addTest(cast.editor, cast.slug, 'sum', ok, '1\n');
      expect(response.status).toBe(201);
      expect(response.body.input_size_bytes).toBe(8 * 1024 * 1024);
    });

    it('keeps samples small because they are shown in the statement', async () => {
      const big = 'z'.repeat(65 * 1024);
      const asSample = await addTest(cast.editor, cast.slug, 'sum', big, '1\n', true);
      expect(asSample.status).toBe(400);
      expect(detailsOf(asSample.body)[0]!.message).toMatch(/too large for a sample/);
      const asHidden = await addTest(cast.editor, cast.slug, 'sum', big, '1\n', false);
      expect(asHidden.status).toBe(201);
    });
  });

  describe('limits (GRD-24)', () => {
    it('at most 100 tests per problem', async () => {
      for (let n = 1; n <= 100; n++) {
        const added = await addTest(cast.editor, cast.slug, 'sum', `${n}\n`, `${n}\n`);
        expect(added.status).toBe(201);
      }
      const over = await addTest(cast.editor, cast.slug, 'sum', 'x\n', 'x\n');
      expect(over.status).toBe(409);
      expect(over.body.error_code).toBe('TEST_LIMIT_REACHED');
      expect((await list()).summary.count).toBe(100);
    }, 120_000);

    it('at most 10 samples', async () => {
      for (let n = 1; n <= 10; n++) {
        expect(
          (await addTest(cast.editor, cast.slug, 'sum', `${n}\n`, `${n}\n`, true)).status
        ).toBe(201);
      }
      const over = await addTest(cast.editor, cast.slug, 'sum', '11\n', '11\n', true);
      expect(over.status).toBe(409);
      expect(over.body.error_code).toBe('SAMPLE_LIMIT_REACHED');
      const hidden = await addTest(cast.editor, cast.slug, 'sum', '11\n', '11\n', false);
      expect(hidden.status).toBe(201);
      const flip = await cast.editor.request('PATCH', url(`/${hidden.body.id}`), {
        is_sample: true,
      });
      expect(flip.status).toBe(409);
    });

    it('at most 128 MiB for all tests together', async () => {
      const chunk = 'a'.repeat(8 * 1024 * 1024 - 2); // plus one digit and the final newline: exactly 8 MiB
      // 8 MiB of input + 8 MiB of output per test = 16 MiB; the 9th would pass 128 MiB.
      for (let n = 0; n < 8; n++) {
        const added = await addTest(
          cast.editor,
          cast.slug,
          'sum',
          chunk + String(n),
          chunk + String(n)
        );
        expect(added.status).toBe(201);
      }
      const over = await addTest(cast.editor, cast.slug, 'sum', chunk, chunk);
      expect(over.status).toBe(409);
      expect(over.body.error_code).toBe('TEST_SIZE_LIMIT_REACHED');
      expect((await list()).summary.total_bytes).toBe(8 * 2 * 8 * 1024 * 1024);
    }, 120_000);

    it('reports the totals and the limits, so the web app can show "37 of 100"', async () => {
      await addTest(cast.editor, cast.slug, 'sum', '1 2\n', '3\n', true);
      await addTest(cast.editor, cast.slug, 'sum', '4 5\n', '9\n');
      const body = await list();
      expect(body.summary).toEqual({
        count: 2,
        sample_count: 1,
        missing_output_count: 0,
        total_bytes: 4 + 2 + 4 + 2,
      });
      expect(body.limits).toEqual({
        max_count: 100,
        max_total_bytes: 128 * 1024 * 1024,
        max_file_bytes: 8 * 1024 * 1024,
        max_sample_bytes: 64 * 1024,
        max_samples: 10,
      });
      expect(body.editable).toBe(true);
    });

    it('concurrent uploads never exceed the count and keep positions unique', async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, n) =>
          addTest(cast.editor, cast.slug, 'sum', `${n}\n`, `${n}\n`)
        )
      );
      expect(results.every((response) => response.status === 201)).toBe(true);
      const positions = (await list()).items
        .map((item: { position: number }) => item.position)
        .sort((a: number, b: number) => a - b);
      expect(positions).toEqual(Array.from({ length: 12 }, (_, n) => n + 1));
    });
  });

  describe('changing tests (GRD-24)', () => {
    let first: { id: string };
    let second: { id: string };
    let third: { id: string };
    beforeEach(async () => {
      first = (await addTest(cast.editor, cast.slug, 'sum', '1\n', '1\n', true)).body;
      second = (await addTest(cast.editor, cast.slug, 'sum', '2\n', '2\n')).body;
      third = (await addTest(cast.editor, cast.slug, 'sum', '3\n', '3\n')).body;
    });

    it('marks a test as a sample or as hidden', async () => {
      const flipped = await cast.editor.request('PATCH', url(`/${second.id}`), { is_sample: true });
      expect(flipped.status).toBe(200);
      expect(flipped.body.is_sample).toBe(true);
      const back = await cast.editor.request('PATCH', url(`/${first.id}`), { is_sample: false });
      expect(back.body.is_sample).toBe(false);
      expect((await list()).summary.sample_count).toBe(1);
    });

    it('a test too large to be a sample cannot become one', async () => {
      const big = (await addTest(cast.editor, cast.slug, 'sum', 'q'.repeat(70 * 1024), '1\n')).body;
      const response = await cast.editor.request('PATCH', url(`/${big.id}`), { is_sample: true });
      expect(response.status).toBe(409);
      expect(response.body.error_code).toBe('SAMPLE_TOO_LARGE');
    });

    it('rejects a body without is_sample', async () => {
      expect((await cast.editor.request('PATCH', url(`/${second.id}`), {})).status).toBe(400);
    });

    it('deleting a test closes the gap in the order but keeps the stored files', async () => {
      const response = await cast.editor.request('DELETE', url(`/${first.id}`));
      expect(response.status).toBe(204);
      const { items } = await list();
      expect(
        items.map((item: { id: string; position: number }) => [item.id, item.position])
      ).toEqual([
        [second.id, 1],
        [third.id, 2],
      ]);
      expect(t.storage.tests.objects.has(testFileKey(sha('1\n')))).toBe(true);
    });

    it('reorders: the list must name every test exactly once', async () => {
      const ok = await cast.editor.request('POST', url('/reorder'), {
        test_ids: [third.id, first.id, second.id],
      });
      expect(ok.status).toBe(200);
      expect(ok.body.items.map((item: { id: string }) => item.id)).toEqual([
        third.id,
        first.id,
        second.id,
      ]);
      expect(ok.body.items.map((item: { position: number }) => item.position)).toEqual([1, 2, 3]);
      for (const bad of [
        [first.id, second.id],
        [first.id, first.id, second.id],
        [first.id, second.id, third.id, first.id],
        [first.id, second.id, '00000000-0000-4000-8000-000000000000'],
      ]) {
        const response = await cast.editor.request('POST', url('/reorder'), { test_ids: bad });
        expect(response.status).toBe(400);
        expect(detailsOf(response.body)[0]!.field).toBe('test_ids');
      }
      expect((await list()).items.map((item: { id: string }) => item.id)).toEqual([
        third.id,
        first.id,
        second.id,
      ]);
    });

    it('replaces the files of a test and keeps its place and sample flag', async () => {
      const response = await cast.editor.upload('PUT', url(`/${first.id}`), [
        { name: 'input', filename: 'new.in', content: '10\r\n' },
        { name: 'output', filename: 'new.out', content: '20\n' },
      ]);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: first.id,
        position: 1,
        is_sample: true,
        input_sha256: sha('10\n'),
        output_sha256: sha('20\n'),
      });
      expect(await t.prisma.testCase.count()).toBe(3);
    });

    it('can replace just the output', async () => {
      const response = await cast.editor.upload('PUT', url(`/${second.id}`), [
        { name: 'output', filename: 'fixed.out', content: 'two\n' },
      ]);
      expect(response.body).toMatchObject({
        input_sha256: sha('2\n'),
        output_sha256: sha('two\n'),
      });
    });

    it('replacing needs at least one file, and checks it like an upload', async () => {
      const none = await cast.editor.upload('PUT', url(`/${second.id}`), [
        { name: 'is_sample', content: 'true' },
      ]);
      expect(none.status).toBe(400);
      const binary = await cast.editor.upload('PUT', url(`/${second.id}`), [
        { name: 'input', filename: 'x.bin', content: Buffer.from([0, 0]) },
      ]);
      expect(binary.status).toBe(400);
      expect(detailsOf(binary.body)[0]!.field).toBe('input');
    });

    it('a test of another problem or a random id is 404', async () => {
      expect(
        (await cast.editor.request('DELETE', url('/00000000-0000-4000-8000-000000000000'))).status
      ).toBe(404);
      expect(
        (await cast.editor.request('PATCH', url('/not-a-uuid'), { is_sample: true })).status
      ).toBe(400);
      await createDraft(cast.editor, cast.slug, 'other');
      const foreign = await cast.editor.request(
        'DELETE',
        problemUrl(cast.slug, 'other', `/tests/${first.id}`)
      );
      expect(foreign.status).toBe(404);
      expect(await t.prisma.testCase.count()).toBe(3);
    });

    it('every change needs edit rights', async () => {
      const calls = (client: typeof cast.solver) => [
        client.request('PATCH', url(`/${first.id}`), { is_sample: false }),
        client.request('DELETE', url(`/${first.id}`)),
        client.request('POST', url('/reorder'), { test_ids: [third.id, second.id, first.id] }),
        client.upload('PUT', url(`/${first.id}`), [{ name: 'input', filename: 'a', content: 'x' }]),
      ];
      for (const response of await Promise.all(calls(cast.solver)))
        expect(response.status).toBe(403);
      for (const response of await Promise.all(calls(cast.outsider)))
        expect(response.status).toBe(404);
      for (const response of await Promise.all(calls(cast.visitor)))
        expect(response.status).toBe(401);
      expect((await list()).items).toHaveLength(3);
    });
  });

  describe('looking at tests', () => {
    it('lists them to owners and editors only', async () => {
      await addTest(cast.editor, cast.slug, 'sum', '1\n', '1\n');
      expect((await cast.owner.request('GET', url())).status).toBe(200);
      expect((await cast.solver.request('GET', url())).status).toBe(403);
      expect((await cast.outsider.request('GET', url())).status).toBe(404);
      expect((await cast.visitor.request('GET', url())).status).toBe(401);
    });

    it('downloads the stored input or output, for authors only', async () => {
      const test = (await addTest(cast.editor, cast.slug, 'sum', '4 5\r\n', '9')).body;
      const input = await cast.editor.text('GET', url(`/${test.id}/input`));
      const output = await cast.editor.text('GET', url(`/${test.id}/output`));
      expect(input.text).toBe('4 5\n');
      expect(output.text).toBe('9\n');
      expect(input.headers['content-type']).toMatch(/^text\/plain/);
      expect(input.headers['content-disposition']).toBe('attachment; filename="sum-1.in"');
      expect(input.headers['x-content-type-options']).toBe('nosniff');
      expect((await cast.solver.text('GET', url(`/${test.id}/input`))).status).toBe(403);
      expect((await cast.outsider.text('GET', url(`/${test.id}/output`))).status).toBe(404);
      expect((await cast.visitor.text('GET', url(`/${test.id}/output`))).status).toBe(401);
    });

    it('stays readable after publishing (frozen, not secret from authors)', async () => {
      await createPublishedProblem(cast, 'live');
      const { items, editable } = (
        await cast.editor.request('GET', problemUrl(cast.slug, 'live', '/tests'))
      ).body;
      expect(items).toHaveLength(2);
      expect(editable).toBe(false);
    });
  });

  describe('storage trouble', () => {
    it('answers 503 and leaves no half-made test when storage is down', async () => {
      const { StorageUnavailableError } = await import('@/libs/storage/file-storage');
      jest.spyOn(t.storage.tests, 'put').mockRejectedValue(new StorageUnavailableError('down'));
      const response = await addTest(cast.editor, cast.slug, 'sum', '1\n', '1\n');
      expect(response.status).toBe(503);
      expect(response.body.error_code).toBe('UNAVAILABLE');
      expect(await t.prisma.testCase.count()).toBe(0);
    });
  });
});
