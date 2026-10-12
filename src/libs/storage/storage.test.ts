import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  FileStorage,
  ObjectInfo,
  PutOptions,
  StoredObject,
  StorageError,
  StorageNotFoundError,
  StorageUnavailableError,
  assertSafeKey,
  imageKey,
  readAll,
  testFileKey,
} from '@/libs/storage/file-storage';
import { LocalDiskFileStorage } from '@/libs/storage/local';
import { MemoryFileStorage } from '@/libs/storage/memory';
import { RetryingFileStorage } from '@/libs/storage/retrying';
import { mapS3Error, S3FileStorage } from '@/libs/storage/s3';

const SHA = 'a'.repeat(64);

describe('keys', () => {
  it('test files are keyed by content hash under tests/ (the layout Judge reads)', () => {
    expect(testFileKey(SHA)).toBe(`tests/${SHA}`);
    expect(imageKey('abc.png')).toBe('images/abc.png');
  });

  it.each(['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'a\0b', 'x'.repeat(513)])(
    'refuses the unsafe key %j',
    (key) => expect(() => assertSafeKey(key)).toThrow(StorageError)
  );
});

/** The contract every implementation must satisfy. */
function behavesLikeStorage(
  name: string,
  create: () => Promise<{ storage: FileStorage; cleanup?: () => Promise<void> }>
) {
  describe(`${name} implements FileStorage`, () => {
    let storage: FileStorage;
    let cleanup: (() => Promise<void>) | undefined;
    beforeEach(async () => ({ storage, cleanup } = await create()));
    afterEach(async () => cleanup?.());

    it('puts and gets bytes back as a stream', async () => {
      await storage.put('tests/one', Buffer.from('hello\n'), { size: 6 });
      const object = await storage.get('tests/one');
      expect(object.size).toBe(6);
      expect((await readAll(object.body)).toString()).toBe('hello\n');
    });

    it('accepts a stream as the body', async () => {
      await storage.put('tests/stream', Readable.from([Buffer.from('ab'), Buffer.from('cd')]), {
        size: 4,
      });
      expect((await readAll((await storage.get('tests/stream')).body)).toString()).toBe('abcd');
    });

    it('overwrites with the same key', async () => {
      await storage.put('k/a', Buffer.from('1'), { size: 1 });
      await storage.put('k/a', Buffer.from('22'), { size: 2 });
      expect((await storage.head('k/a'))?.size).toBe(2);
    });

    it('head reports the size, or null when the object is missing', async () => {
      await storage.put('k/b', Buffer.from('xyz'), { size: 3 });
      expect(await storage.head('k/b')).toEqual({ size: 3 });
      expect(await storage.head('k/missing')).toBeNull();
    });

    it('get of a missing object throws StorageNotFoundError', async () => {
      await expect(storage.get('k/missing')).rejects.toBeInstanceOf(StorageNotFoundError);
    });

    it('delete removes the object and is quiet when it is already gone', async () => {
      await storage.put('k/c', Buffer.from('x'), { size: 1 });
      await storage.delete('k/c');
      expect(await storage.head('k/c')).toBeNull();
      await expect(storage.delete('k/c')).resolves.toBeUndefined();
    });

    it('stores an empty object', async () => {
      await storage.put('k/empty', Buffer.alloc(0), { size: 0 });
      expect(await storage.head('k/empty')).toEqual({ size: 0 });
      expect((await readAll((await storage.get('k/empty')).body)).length).toBe(0);
    });

    it('refuses unsafe keys on every call', async () => {
      await expect(storage.put('../x', Buffer.from('x'), { size: 1 })).rejects.toBeInstanceOf(
        StorageError
      );
      await expect(storage.get('../x')).rejects.toBeInstanceOf(StorageError);
      await expect(storage.head('../x')).rejects.toBeInstanceOf(StorageError);
      await expect(storage.delete('../x')).rejects.toBeInstanceOf(StorageError);
    });
  });
}

behavesLikeStorage('MemoryFileStorage', async () => ({ storage: new MemoryFileStorage() }));

behavesLikeStorage('LocalDiskFileStorage', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'verdale-storage-'));
  return {
    storage: new LocalDiskFileStorage(dir),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
});

describe('LocalDiskFileStorage layout', () => {
  it('writes tests/<sha256> under the root, where Judge reads it, and leaves no partial files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'verdale-storage-'));
    try {
      await new LocalDiskFileStorage(dir).put(testFileKey(SHA), Buffer.from('1 2\n'), { size: 4 });
      expect(await readFile(path.join(dir, 'tests', SHA), 'utf8')).toBe('1 2\n');
      expect(await readdir(path.join(dir, 'tests'))).toEqual([SHA]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A storage that fails the first `failures` calls, then works. */
class FlakyStorage implements FileStorage {
  calls = 0;
  constructor(
    private readonly inner: FileStorage,
    private failures: number,
    private readonly error: () => Error = () => new StorageUnavailableError('down')
  ) {}
  private maybeFail() {
    this.calls++;
    if (this.failures > 0) {
      this.failures--;
      throw this.error();
    }
  }
  async put(key: string, body: Buffer | Readable, options: PutOptions) {
    this.maybeFail();
    return this.inner.put(key, body, options);
  }
  async get(key: string): Promise<StoredObject> {
    this.maybeFail();
    return this.inner.get(key);
  }
  async head(key: string): Promise<ObjectInfo | null> {
    this.maybeFail();
    return this.inner.head(key);
  }
  async delete(key: string) {
    this.maybeFail();
    return this.inner.delete(key);
  }
}

describe('RetryingFileStorage (one policy for every provider)', () => {
  const sleeps: number[] = [];
  const options = {
    attempts: 3,
    backoffMs: 100,
    timeoutMs: 50,
    sleep: async (ms: number) => void sleeps.push(ms),
  };
  beforeEach(() => (sleeps.length = 0));

  it('retries unavailable errors with doubling backoff and then succeeds', async () => {
    const flaky = new FlakyStorage(new MemoryFileStorage(), 2);
    const storage = new RetryingFileStorage(flaky, options);
    await storage.put('k/a', Buffer.from('x'), { size: 1 });
    expect(flaky.calls).toBe(3);
    expect(sleeps).toEqual([100, 200]);
    expect(await storage.head('k/a')).toEqual({ size: 1 });
  });

  it('gives up after the configured number of attempts and reports unavailable', async () => {
    const flaky = new FlakyStorage(new MemoryFileStorage(), 10);
    const storage = new RetryingFileStorage(flaky, options);
    await expect(storage.head('k/a')).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(flaky.calls).toBe(3);
  });

  it('does not retry "not found": it is an answer, not a failure', async () => {
    const flaky = new FlakyStorage(new MemoryFileStorage(), 0);
    const storage = new RetryingFileStorage(flaky, options);
    await expect(storage.get('k/none')).rejects.toBeInstanceOf(StorageNotFoundError);
    expect(flaky.calls).toBe(1);
  });

  it('does not retry errors that retrying cannot fix', async () => {
    const flaky = new FlakyStorage(
      new MemoryFileStorage(),
      5,
      () => new StorageError('access denied')
    );
    const storage = new RetryingFileStorage(flaky, options);
    await expect(storage.delete('k/a')).rejects.toThrow('access denied');
    expect(flaky.calls).toBe(1);
  });

  it('does not retry a streamed upload: the stream is spent after one try', async () => {
    const flaky = new FlakyStorage(new MemoryFileStorage(), 1);
    const storage = new RetryingFileStorage(flaky, options);
    await expect(storage.put('k/s', Readable.from(['x']), { size: 1 })).rejects.toBeInstanceOf(
      StorageUnavailableError
    );
    expect(flaky.calls).toBe(1);
  });

  it('turns a call that hangs into an unavailable error after the timeout', async () => {
    const hanging: FileStorage = {
      put: () => new Promise(() => undefined),
      get: () => new Promise(() => undefined),
      head: () => new Promise(() => undefined),
      delete: () => new Promise(() => undefined),
    };
    const storage = new RetryingFileStorage(hanging, { ...options, attempts: 2 });
    await expect(storage.head('k/a')).rejects.toThrow(/timed out/);
    expect(sleeps).toEqual([100]); // it was retried once
  });
});

describe('S3 error mapping', () => {
  it.each([
    [{ name: 'NoSuchKey' }, StorageNotFoundError],
    [{ name: 'NotFound', $metadata: { httpStatusCode: 404 } }, StorageNotFoundError],
    [{ $metadata: { httpStatusCode: 503 } }, StorageUnavailableError],
    [{ $metadata: { httpStatusCode: 500 } }, StorageUnavailableError],
    [{ $metadata: { httpStatusCode: 429 } }, StorageUnavailableError],
    [{ code: 'ECONNRESET' }, StorageUnavailableError],
    [{ name: 'TimeoutError' }, StorageUnavailableError],
    [{ $metadata: { httpStatusCode: 403 }, name: 'AccessDenied' }, StorageError],
  ])('maps %j', (failure, expected) => {
    const mapped = mapS3Error(failure, 'k/a');
    expect(mapped).toBeInstanceOf(expected);
    if (expected === StorageError) {
      expect(mapped).not.toBeInstanceOf(StorageUnavailableError);
      expect(mapped).not.toBeInstanceOf(StorageNotFoundError);
    }
  });
});

/**
 * Against a real bucket (GRD-23: integration test with the staging bucket).
 * Runs only when the staging credentials are in the environment:
 *   R2_TEST_ENDPOINT, R2_TEST_ACCESS_KEY_ID, R2_TEST_SECRET_ACCESS_KEY, R2_TEST_BUCKET
 * It writes under a random prefix and deletes what it wrote.
 */
const real = process.env.R2_TEST_ENDPOINT && process.env.R2_TEST_BUCKET;
(real ? describe : describe.skip)('S3FileStorage against the staging bucket', () => {
  const prefix = `ci/${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const storage = new RetryingFileStorage(
    new S3FileStorage({
      endpoint: process.env.R2_TEST_ENDPOINT!,
      accessKeyId: process.env.R2_TEST_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_TEST_SECRET_ACCESS_KEY!,
      bucket: process.env.R2_TEST_BUCKET!,
      timeoutMs: 15_000,
    }),
    { attempts: 3, backoffMs: 200, timeoutMs: 20_000 }
  );

  it('round-trips an object and reports missing ones', async () => {
    const key = `${prefix}/object`;
    try {
      await storage.put(key, Buffer.from('1 2\n'), { size: 4, contentType: 'text/plain' });
      expect(await storage.head(key)).toEqual({ size: 4 });
      expect((await readAll((await storage.get(key)).body)).toString()).toBe('1 2\n');
    } finally {
      await storage.delete(key);
    }
    expect(await storage.head(key)).toBeNull();
    await expect(storage.get(key)).rejects.toBeInstanceOf(StorageNotFoundError);
  });
});
