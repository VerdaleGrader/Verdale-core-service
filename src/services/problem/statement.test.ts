import { createHash } from 'node:crypto';
import { PDFDocument, PDFName } from 'pdf-lib';
import { countPdfPages, hasPdfHeader } from '@/libs/pdf';
import {
  Cast,
  castSpace,
  createDraft,
  createPublishedProblem,
  placeInTrack,
  problemUrl,
} from '@/test/fixtures';
import { createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

async function makePdf(pages = 1): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pages; index++) document.addPage();
  return Buffer.from(await document.save());
}

describe('hasPdfHeader', () => {
  it('looks at the bytes, not the name', () => {
    expect(hasPdfHeader(Buffer.from('%PDF-1.7\n...'))).toBe(true);
    expect(hasPdfHeader(Buffer.concat([Buffer.from('junk\n'), Buffer.from('%PDF-1.4')]))).toBe(
      true
    );
    expect(hasPdfHeader(Buffer.from('<html>%PDF-</html>'.padStart(2000, ' ')))).toBe(false);
    expect(hasPdfHeader(Buffer.from('GIF89a'))).toBe(false);
    expect(hasPdfHeader(Buffer.alloc(0))).toBe(false);
  });
});

describeDb('problem constraints for the create page', () => {
  it('are public and match the editor view', async () => {
    const t = await createTestApp();
    try {
      await resetDatabase(t.prisma);
      const response = await t.anonymous().request('GET', '/api/v1/problem-constraints');
      expect(response.status).toBe(200);
      expect(response.body.pdf).toEqual({ max_bytes: 10 * 1024 * 1024, max_pages: 10 });
      expect(response.body.time_limit_ms).toEqual({ min: 100, max: 10000, default: 1000 });
      const cast = await castSpace(t);
      await createDraft(cast.editor, 'team', 'sum');
      const editor = await cast.editor.request('GET', problemUrl('team', 'sum', '/editor'));
      expect(response.body).toEqual(editor.body.constraints);
    } finally {
      await t.close();
    }
  });
});

describeDb('PDF statements (GRD-73)', () => {
  let t: TestApp;
  let cast: Cast;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    cast = await castSpace(t, { visibility: 'public' });
    await createDraft(cast.editor, 'team', 'sum');
  });
  afterEach(async () => t.close());

  const url = problemUrl('team', 'sum', '/statement/pdf');
  const upload = (
    client: typeof cast.editor,
    content: Buffer | string,
    filename = 'statement.pdf'
  ) =>
    client.upload('PUT', url, [
      { name: 'file', filename, content, contentType: 'application/pdf' },
    ]);
  const editor = async () =>
    (await cast.editor.request('GET', problemUrl('team', 'sum', '/editor'))).body;

  describe('uploading', () => {
    it('stores a real PDF in the private bucket under its SHA-256 and switches the mode', async () => {
      const bytes = await makePdf(3);
      const response = await upload(cast.editor, bytes);
      expect(response.status).toBe(200);
      const sha = createHash('sha256').update(bytes).digest('hex');
      expect(response.body.version).toMatchObject({
        statement_mode: 'pdf',
        statement_pdf: { sha256: sha, size_bytes: bytes.length, pages: 3 },
      });
      const stored = t.storage.tests.objects.get(`statements/${sha}`);
      expect(stored?.contentType).toBe('application/pdf');
      expect(stored?.bytes.equals(bytes)).toBe(true);
      expect(t.storage.assets.objects.size).toBe(0); // never in the public bucket
    });

    it('the same file twice is stored once', async () => {
      const bytes = await makePdf();
      await upload(cast.editor, bytes);
      await upload(cast.editor, bytes, 'again.pdf');
      expect(
        [...t.storage.tests.objects.keys()].filter((key) => key.startsWith('statements/'))
      ).toHaveLength(1);
    });

    it('accepts a PDF with exactly 10 pages and refuses 11', async () => {
      expect((await upload(cast.editor, await makePdf(10))).status).toBe(200);
      const response = await upload(cast.editor, await makePdf(11));
      expect(response.status).toBe(400);
      expect(response.body.details[0]).toEqual({
        field: 'file',
        message: '“statement.pdf” has 11 pages; at most 10 are allowed.',
      });
    });

    it.each([
      ['a text file renamed to .pdf', Buffer.from('hello world'), 'is not a PDF file'],
      ['an image renamed to .pdf', Buffer.from('89504e470d0a1a0a0000', 'hex'), 'is not a PDF file'],
      [
        'an HTML page renamed to .pdf',
        Buffer.from('<script>alert(1)</script>'),
        'is not a PDF file',
      ],
      ['an empty file', Buffer.alloc(0), 'is empty'],
      [
        'a PDF header with nothing behind it',
        Buffer.from('%PDF-1.7\nnot really'),
        'is damaged or not a valid PDF',
      ],
    ])('refuses %s, with the reason', async (_label, bytes, reason) => {
      const response = await upload(cast.editor, bytes);
      expect(response.status).toBe(400);
      expect(response.body.details[0].field).toBe('file');
      expect(response.body.details[0].message).toBe(`“statement.pdf” ${reason}.`);
      expect(t.storage.tests.objects.size).toBe(0);
      expect((await editor()).version.statement_mode).toBe('markdown');
    });

    it('refuses a file over 10 MiB before parsing it', async () => {
      const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(10 * 1024 * 1024)]);
      const response = await upload(cast.editor, big);
      expect(response.status).toBe(400);
      expect(response.body.details[0].message).toMatch(/larger than 10/);
    });

    it('accepts a valid PDF just under 10 MiB', async () => {
      const document = await PDFDocument.create();
      const page = document.addPage();
      page.node.set(
        PDFName.of('Contents'),
        document.context.register(document.context.stream(Buffer.alloc(9.5 * 1024 * 1024, 0x20)))
      );
      const bytes = Buffer.from(await document.save());
      expect(bytes.length).toBeLessThan(10 * 1024 * 1024);
      expect(bytes.length).toBeGreaterThan(9 * 1024 * 1024);
      expect((await upload(cast.editor, bytes)).status).toBe(200);
    });

    it('stops checking a file that takes too long instead of stalling the API', async () => {
      const valid = await makePdf(2);
      const padded = Buffer.concat([valid, Buffer.alloc(9 * 1024 * 1024, 0x41)]);
      await expect(countPdfPages(padded, 300)).rejects.toThrow('is too complex to check');
    }, 15_000);

    it('needs a file part', async () => {
      const response = await cast.editor.upload('PUT', url, [{ name: 'note', content: 'x' }]);
      expect(response.status).toBe(400);
      expect(response.body.details[0].field).toBe('file');
    });

    it('only owners and editors may upload; others never reach the body', async () => {
      const bytes = await makePdf();
      expect((await upload(cast.solver, bytes)).status).toBe(403);
      expect((await upload(cast.outsider, bytes)).status).toBe(403);
      expect((await upload(cast.visitor, bytes)).status).toBe(401);
      expect(t.storage.tests.objects.size).toBe(0);
    });

    it('is refused once the version is published or the Space archived', async () => {
      const published = await createPublishedProblem(cast, 'done');
      expect(published.editor.version.status).toBe('published');
      const response = await cast.editor.upload(
        'PUT',
        problemUrl('team', 'done', '/statement/pdf'),
        [{ name: 'file', filename: 'a.pdf', content: await makePdf() }]
      );
      expect(response.status).toBe(409);
      expect(response.body.error_code).toBe('VERSION_PUBLISHED');
      await cast.owner.request('POST', '/api/v1/spaces/team/archive');
      expect((await upload(cast.editor, await makePdf())).status).toBe(403);
    });
  });

  describe('the mode', () => {
    it('is Markdown at first and cannot be PDF before a file exists', async () => {
      expect((await editor()).version).toMatchObject({
        statement_mode: 'markdown',
        statement_pdf: null,
      });
      const response = await cast.editor.request('PATCH', problemUrl('team', 'sum'), {
        statement_mode: 'pdf',
      });
      expect(response.status).toBe(400);
      expect(response.body.details[0].field).toBe('statement_mode');
    });

    it('can go back to Markdown and forth again; the uploaded file is kept', async () => {
      await upload(cast.editor, await makePdf(2));
      const back = await cast.editor.request('PATCH', problemUrl('team', 'sum'), {
        statement_mode: 'markdown',
      });
      expect(back.body.version).toMatchObject({
        statement_mode: 'markdown',
        statement_pdf: { pages: 2 },
      });
      const again = await cast.editor.request('PATCH', problemUrl('team', 'sum'), {
        statement_mode: 'pdf',
      });
      expect(again.body.version.statement_mode).toBe('pdf');
    });

    it('rejects an unknown mode', async () => {
      expect(
        (await cast.editor.request('PATCH', problemUrl('team', 'sum'), { statement_mode: 'docx' }))
          .status
      ).toBe(400);
    });

    it('PDF mode counts as a statement for publishing, even with empty text', async () => {
      await createDraft(cast.editor, 'team', 'blank', { statement: '' });
      const before = await cast.editor.request('GET', problemUrl('team', 'blank', '/editor'));
      expect(
        before.body.publish_checks.find((c: { key: string }) => c.key === 'statement').ok
      ).toBe(false);
      await cast.editor.upload('PUT', problemUrl('team', 'blank', '/statement/pdf'), [
        { name: 'file', filename: 'a.pdf', content: await makePdf() },
      ]);
      const after = await cast.editor.request('GET', problemUrl('team', 'blank', '/editor'));
      expect(
        after.body.publish_checks.find((c: { key: string }) => c.key === 'statement')
      ).toMatchObject({
        ok: true,
        message: 'The PDF statement is uploaded.',
      });
    });

    it('sample tests stay a separate field in both modes', async () => {
      const published = await createPublishedProblem(cast, 'sampled');
      await placeInTrack(cast, 'sampled');
      const reader = await cast.solver.request('GET', problemUrl('team', 'sampled'));
      expect(reader.body.samples).toEqual([{ position: 1, input: '1 2\n', output: '3\n' }]);
      expect(published.sample.is_sample).toBe(true);
    });
  });

  describe('reading', () => {
    let bytes: Buffer;
    beforeEach(async () => {
      bytes = await makePdf(2);
    });

    it('serves the bytes with headers that keep the PDF from running in our pages', async () => {
      await upload(cast.editor, bytes);
      const response = await cast.editor.text('GET', `${url}?draft=true`);
      expect(response.status).toBe(200);
      expect(response.text.length).toBeGreaterThan(100);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(String(response.headers['content-disposition'])).toContain('inline');
      expect(response.headers['cache-control']).toBe('private, max-age=300');
      expect(response.headers['content-length']).toBe(String(bytes.length));
    });

    it('a draft’s PDF is for owners and editors; solvers and visitors get 404', async () => {
      await upload(cast.editor, bytes);
      for (const who of ['owner', 'editor'] as const) {
        expect((await cast[who].text('GET', url)).status).toBe(200);
      }
      for (const who of ['solver', 'outsider', 'visitor'] as const) {
        expect((await cast[who].text('GET', url)).status).toBe(404);
        expect((await cast[who].text('GET', `${url}?draft=true`)).status).toBe(404);
      }
    });

    it('a problem with no PDF is 404', async () => {
      expect((await cast.editor.text('GET', url)).status).toBe(404);
    });

    it('a published PDF problem reaches solvers through a Track, and visitors in a public Space', async () => {
      // Build a published problem whose statement is the PDF.
      await createDraft(cast.editor, 'team', 'pdfp');
      await upload(cast.editor, bytes);
      const draftUrl = problemUrl('team', 'pdfp', '/statement/pdf');
      await cast.editor.upload('PUT', draftUrl, [
        { name: 'file', filename: 'a.pdf', content: bytes },
      ]);
      const { addTest, SOLUTION_SOURCE } = await import('@/test/fixtures');
      await addTest(cast.editor, 'team', 'pdfp', '1 2\n', '3\n', true);
      await cast.editor.request('POST', problemUrl('team', 'pdfp', '/solutions'), {
        language: 'cpp',
        source: SOLUTION_SOURCE,
      });
      const published = await cast.editor.request('POST', problemUrl('team', 'pdfp', '/publish'));
      expect(published.status).toBe(200);

      // Not in a Track yet: hidden.
      expect((await cast.solver.text('GET', draftUrl)).status).toBe(404);
      expect((await cast.solver.request('GET', problemUrl('team', 'pdfp'))).status).toBe(404);

      await placeInTrack(cast, 'pdfp');
      const reader = await cast.solver.request('GET', problemUrl('team', 'pdfp'));
      expect(reader.body).toMatchObject({
        statement_mode: 'pdf',
        statement_pdf: {
          url: '/api/v1/spaces/team/problems/pdfp/statement/pdf',
          pages: 2,
          size_bytes: bytes.length,
        },
        samples: [{ input: '1 2\n', output: '3\n' }],
      });
      for (const who of ['solver', 'outsider', 'visitor'] as const) {
        const file = await cast[who].text('GET', draftUrl);
        expect(file.status).toBe(200);
        expect(file.headers['content-type']).toBe('application/pdf');
      }
    });

    it('a private Space and a members-only Track keep the file private', async () => {
      const privateCast = await castSpace(t, { visibility: 'private', slug: 'priv' });
      await createDraft(privateCast.editor, 'priv', 'sum');
      await privateCast.editor.upload('PUT', problemUrl('priv', 'sum', '/statement/pdf'), [
        { name: 'file', filename: 'a.pdf', content: bytes },
      ]);
      for (const who of ['outsider', 'visitor'] as const) {
        expect(
          (await privateCast[who].text('GET', problemUrl('priv', 'sum', '/statement/pdf'))).status
        ).toBe(404);
      }
    });
  });
});
