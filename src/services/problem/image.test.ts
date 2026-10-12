import { Cast, castSpace, createDraft, problemUrl } from '@/test/fixtures';
import { createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('0000000d49484452', 'hex'),
  Buffer.alloc(20),
]);
const JPEG = Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.alloc(20)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBPVP8 '),
  Buffer.alloc(20),
]);

describeDb('Statement pictures (GRD-27)', () => {
  let t: TestApp;
  let cast: Cast;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    cast = await castSpace(t, { visibility: 'public' });
    await createDraft(cast.editor, cast.slug);
  });
  afterEach(async () => t.close());

  const url = problemUrl('team', 'sum', '/images');
  const upload = (client: typeof cast.editor, content: Buffer | string, filename = 'figure.png') =>
    client.upload('POST', url, [{ name: 'file', filename, content }]);

  it.each([
    ['png', PNG, 'image/png'],
    ['jpg', JPEG, 'image/jpeg'],
    ['webp', WEBP, 'image/webp'],
  ])(
    'accepts a %s, stores it in the public bucket under a random name and gives a Markdown link',
    async (extension, bytes, type) => {
      const response = await upload(cast.editor, bytes, `figure.${extension}`);
      expect(response.status).toBe(201);
      expect(response.body.content_type).toBe(type);
      expect(response.body.size_bytes).toBe(bytes.length);
      expect(response.body.url).toMatch(new RegExp(`^/api/v1/assets/[a-f0-9]{32}\\.${extension}$`));
      expect(response.body.markdown).toBe(`![](${response.body.url})`);
      const name = response.body.url.split('/').pop() as string;
      expect(name).not.toContain('figure');
      expect(t.storage.assets.objects.get(`images/${name}`)!.contentType).toBe(type);
      expect(t.storage.tests.objects.size).toBe(0); // never in the private bucket
    }
  );

  it('gives each upload its own random name, even for identical files', async () => {
    const one = await upload(cast.editor, PNG);
    const two = await upload(cast.editor, PNG);
    expect(one.body.url).not.toBe(two.body.url);
  });

  it('decides the type from the bytes, not the file name or the declared type', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    for (const [content, filename] of [
      [svg, 'logo.png'],
      ['<html><script>alert(1)</script></html>', 'page.jpg'],
      ['GIF89a....', 'anim.webp'],
      ['plain text', 'notes.png'],
    ] as const) {
      const response = await cast.editor.upload('POST', url, [
        { name: 'file', filename, content, contentType: 'image/png' },
      ]);
      expect(response.status).toBe(400);
      expect(response.body.details[0].field).toBe('file');
      expect(response.body.details[0].message).toMatch(/not a PNG, JPEG or WebP image/);
    }
    expect(t.storage.assets.objects.size).toBe(0);
  });

  it('refuses an empty file, a missing file and a file over 2 MiB', async () => {
    expect((await upload(cast.editor, '')).status).toBe(400);
    const missing = await cast.editor.upload('POST', url, [{ name: 'other', content: 'x' }]);
    expect(missing.status).toBe(400);
    expect(missing.body.details[0].field).toBe('file');
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    const over = await upload(cast.editor, big, 'big.png');
    expect(over.status).toBe(400);
    expect(over.body.details[0].message).toBe('“big.png” is larger than 2 MiB.');
    expect(t.storage.assets.objects.size).toBe(0);
  });

  it('only people who can edit the problem may upload', async () => {
    expect((await upload(cast.owner, PNG)).status).toBe(201);
    expect((await upload(cast.solver, PNG)).status).toBe(403);
    expect((await upload(cast.outsider, PNG)).status).toBe(403); // public Space: visible but not a member
    expect((await upload(cast.visitor, PNG)).status).toBe(401);
    expect(t.storage.assets.objects.size).toBe(1);
  });

  it('is refused in an archived Space and for a missing problem', async () => {
    expect(
      (
        await cast.editor.upload('POST', problemUrl('team', 'nope', '/images'), [
          { name: 'file', filename: 'a.png', content: PNG },
        ])
      ).status
    ).toBe(404);
    await cast.owner.request('POST', '/api/v1/spaces/team/archive');
    expect((await upload(cast.editor, PNG)).status).toBe(403);
  });

  it('answers 503 when the public bucket is down', async () => {
    const { StorageUnavailableError } = await import('@/libs/storage/file-storage');
    jest.spyOn(t.storage.assets, 'put').mockRejectedValue(new StorageUnavailableError('down'));
    expect((await upload(cast.editor, PNG)).status).toBe(503);
  });

  describe('serving them in development (GET /api/v1/assets/:name)', () => {
    it('serves the picture to anyone, cacheable, with a locked-down content type', async () => {
      const uploaded = await upload(cast.editor, PNG);
      const response = await cast.visitor.text('GET', uploaded.body.url);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    });

    it.each([
      '../../etc/passwd',
      'abc.png',
      `${'a'.repeat(32)}.svg`,
      `${'a'.repeat(32)}.png`,
      `${'A'.repeat(32)}.png`,
    ])('answers 404 for %s', async (name) => {
      expect((await cast.visitor.text('GET', `/api/v1/assets/${name}`)).status).toBe(404);
    });
  });
});
