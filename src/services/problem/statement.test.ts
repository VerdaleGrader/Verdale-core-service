import { PDFDocument } from 'pdf-lib';
import { Cast, castSpace, createDraft, createPublishedProblem, problemUrl } from '@/test/fixtures';
import { createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

async function pdf(pages: number): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let i = 0; i < pages; i++) document.addPage();
  return Buffer.from(await document.save());
}

describeDb('PDF statements (GRD-73)', () => {
  let t: TestApp;
  let cast: Cast;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    cast = await castSpace(t, { visibility: 'private' });
  });
  afterEach(async () => t.close());

  const url = (suffix: string, slug = 'sum') => problemUrl('team', slug, suffix);
  const upload = (client: Cast['editor'], content: Buffer | string, filename = 'statement.pdf') =>
    client.upload('PUT', url('/statement-pdf'), [{ name: 'file', filename, content }]);

  it('keeps a PDF on the draft by its SHA-256 in the private bucket and switches the mode', async () => {
    await createDraft(cast.editor, cast.slug);
    const bytes = await pdf(3);
    const response = await upload(cast.editor, bytes);
    expect(response.status).toBe(200);
    expect(response.body.version).toMatchObject({
      statement_mode: 'pdf',
      statement_pdf: { size_bytes: bytes.length, pages: 3 },
    });
    const { sha256 } = response.body.version.statement_pdf;
    expect(t.storage.tests.objects.get(`statements/${sha256}.pdf`)!.contentType).toBe(
      'application/pdf'
    );
    expect(t.storage.assets.objects.size).toBe(0);
    expect(response.body.constraints.statement_pdf).toEqual({
      max_bytes: 10 * 1024 * 1024,
      max_pages: 10,
    });
  });

  it('refuses what is not a PDF, however it is named, and PDFs that are too long, too big or locked', async () => {
    await createDraft(cast.editor, cast.slug);
    for (const [content, filename] of [
      ['<html><script>alert(1)</script></html>', 'statement.pdf'],
      [Buffer.from('%PDF-1.4 but not really'), 'broken.pdf'],
      [await pdf(1), 'statement.png'],
    ] as const) {
      const response = await upload(cast.editor, content, filename);
      if (filename === 'statement.png') {
        expect(response.status).toBe(200); // the bytes decide, not the name
      } else {
        expect(response.status).toBe(400);
        expect(response.body.details[0]).toMatchObject({ field: 'file' });
        expect(response.body.details[0].message).toContain(filename);
      }
    }
    const long = await upload(cast.editor, await pdf(11), 'long.pdf');
    expect(long.status).toBe(400);
    expect(long.body.details[0].message).toContain('11 pages');
    expect((await upload(cast.editor, await pdf(10))).status).toBe(200);
    const big = await upload(
      cast.editor,
      Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10 * 1024 * 1024)]),
      'big.pdf'
    );
    expect(big.status).toBe(400);
    expect(big.body.details[0].message).toContain('larger than');
    expect((await upload(cast.editor, Buffer.alloc(0))).status).toBe(400);
  });

  it('is for people who can edit, and only while the draft is open', async () => {
    await createDraft(cast.editor, cast.slug);
    const bytes = await pdf(1);
    expect((await upload(cast.solver, bytes)).status).toBe(403);
    expect((await upload(cast.visitor, bytes)).status).toBe(401);
    expect((await upload(cast.outsider, bytes)).status).toBe(404);
    expect((await cast.solver.request('DELETE', url('/statement-pdf'))).status).toBe(403);
    expect((await upload(cast.owner, bytes)).status).toBe(200);
  });

  it('blocks publishing in PDF mode until a PDF is uploaded, and takes the PDF off again', async () => {
    await createDraft(cast.editor, cast.slug, 'sum', { statement: '' });
    const patched = await cast.editor.request('PATCH', url(''), { statement_mode: 'pdf' });
    expect(patched.status).toBe(200);
    expect(
      patched.body.publish_checks.find((c: { key: string }) => c.key === 'statement')
    ).toMatchObject({ ok: false });
    await upload(cast.editor, await pdf(2));
    const withPdf = await cast.editor.request('GET', url('/editor'));
    expect(
      withPdf.body.publish_checks.find((c: { key: string }) => c.key === 'statement')
    ).toMatchObject({ ok: true });
    const removed = await cast.editor.request('DELETE', url('/statement-pdf'));
    expect(removed.status).toBe(200);
    expect(removed.body.version).toMatchObject({ statement_mode: 'markdown', statement_pdf: null });
    expect(
      removed.body.publish_checks.find((c: { key: string }) => c.key === 'statement')
    ).toMatchObject({ ok: false });
  });

  describe('a published problem with a PDF statement', () => {
    beforeEach(async () => {
      await createDraft(cast.editor, cast.slug, 'sum', { statement: 'ignored in pdf mode' });
      await upload(cast.editor, await pdf(2));
      const added = await cast.editor.request('POST', url('/solutions'), {
        language: 'cpp',
        source: 'int main(){}',
      });
      expect(added.status).toBe(201);
      void added;
    });

    async function publish() {
      const { addTest } = await import('@/test/fixtures');
      await addTest(cast.editor, cast.slug, 'sum', '1 2\n', '3\n', true);
      const response = await cast.editor.request('POST', url('/publish'));
      expect(response.status).toBe(200);
      const { exposeProblem } = await import('@/test/fixtures');
      await exposeProblem(cast.owner, cast.slug, 'sum');
    }

    it('shows solvers the page count, not the Markdown, and serves the file with safe headers', async () => {
      await publish();
      const detail = await cast.solver.request('GET', url(''));
      expect(detail.body).toMatchObject({
        statement: '',
        statement_mode: 'pdf',
        statement_pdf: { pages: 2 },
      });
      expect(detail.body.statement_pdf.sha256).toBeUndefined();
      const file = await cast.solver.text('GET', url('/statement.pdf'));
      expect(file.status).toBe(200);
      expect(file.text.startsWith('%PDF-')).toBe(true);
      expect(file.headers['content-type']).toBe('application/pdf');
      expect(file.headers['x-content-type-options']).toBe('nosniff');
      expect(file.headers['content-security-policy']).toContain('sandbox');
      expect(file.headers['cache-control']).toContain('no-store');
      expect(file.headers['content-disposition']).toContain('inline');
    });

    it('answers 404 to anyone who could not open the problem: outsiders, visitors of a private Space', async () => {
      await publish();
      for (const client of [cast.outsider, cast.visitor]) {
        expect((await client.text('GET', url('/statement.pdf'))).status).toBe(404);
      }
    });

    it('answers 404 to a solver when the problem is not in a Track they can reach', async () => {
      const { addTest } = await import('@/test/fixtures');
      await addTest(cast.editor, cast.slug, 'sum', '1 2\n', '3\n', true);
      await cast.editor.request('POST', url('/publish'));
      expect((await cast.solver.text('GET', url('/statement.pdf'))).status).toBe(404);
      expect((await cast.editor.text('GET', url('/statement.pdf'))).status).toBe(200);
    });

    it('serves the draft to staff only with ?draft=true', async () => {
      expect((await cast.editor.text('GET', url('/statement.pdf?draft=true'))).status).toBe(200);
      expect((await cast.solver.text('GET', url('/statement.pdf?draft=true'))).status).toBe(403);
      expect((await cast.visitor.text('GET', url('/statement.pdf?draft=true'))).status).toBe(404);
    });

    it('has no PDF to give for a Markdown problem', async () => {
      await createPublishedProblem(cast, 'plain');
      expect((await cast.editor.text('GET', url('/statement.pdf', 'plain'))).status).toBe(404);
    });
  });

  it('keeps the sample input and output separate from the statement mode', async () => {
    await createPublishedProblem(cast, 'plain');
    const detail = await cast.solver.request('GET', url('', 'plain'));
    expect(detail.body.samples).toEqual([{ position: 1, input: '1 2\n', output: '3\n' }]);
  });
});
