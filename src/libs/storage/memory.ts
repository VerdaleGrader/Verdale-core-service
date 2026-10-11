import { Readable } from 'node:stream';
import {
  FileStorage,
  ObjectInfo,
  PutOptions,
  StoredObject,
  StorageNotFoundError,
  assertSafeKey,
  readAll,
} from '@/libs/storage/file-storage';

/** For tests: everything lives in a Map. */
export class MemoryFileStorage implements FileStorage {
  readonly objects = new Map<string, { bytes: Buffer; contentType?: string }>();

  async put(key: string, body: Buffer | Readable, options: PutOptions): Promise<void> {
    assertSafeKey(key);
    const bytes = Buffer.isBuffer(body) ? Buffer.from(body) : await readAll(body);
    this.objects.set(key, { bytes, contentType: options.contentType });
  }

  async get(key: string): Promise<StoredObject> {
    assertSafeKey(key);
    const object = this.objects.get(key);
    if (!object) throw new StorageNotFoundError(key);
    return { body: Readable.from([object.bytes]), size: object.bytes.length };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    assertSafeKey(key);
    const object = this.objects.get(key);
    return object ? { size: object.bytes.length } : null;
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    this.objects.delete(key);
  }
}
