import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import {
  FileStorage,
  ObjectInfo,
  PutOptions,
  StoredObject,
  StorageError,
  StorageNotFoundError,
  StorageUnavailableError,
  assertSafeKey,
} from '@/libs/storage/file-storage';

/**
 * Objects as files in a directory, for development. Point Judge's
 * `storage.local_dir` at the same directory and it reads the tests Core
 * writes. Writes go to a temporary file first, so a reader never sees half
 * an object.
 */
export class LocalDiskFileStorage implements FileStorage {
  constructor(private readonly root: string) {}

  private pathOf(key: string): string {
    assertSafeKey(key);
    return path.join(this.root, ...key.split('/'));
  }

  async put(key: string, body: Buffer | Readable, _options: PutOptions): Promise<void> {
    const target = this.pathOf(key);
    const temporary = `${target}.${randomUUID()}.partial`;
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await pipeline(
        Buffer.isBuffer(body) ? Readable.from([body]) : body,
        createWriteStream(temporary)
      );
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw new StorageUnavailableError(`Could not write ${key}`, error);
    }
  }

  async get(key: string): Promise<StoredObject> {
    const target = this.pathOf(key);
    let info;
    try {
      info = await stat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageNotFoundError(key);
      throw new StorageUnavailableError(`Could not read ${key}`, error);
    }
    if (!info.isFile()) throw new StorageNotFoundError(key);
    return { body: createReadStream(target), size: info.size };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const info = await stat(this.pathOf(key));
      return info.isFile() ? { size: info.size } : null;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new StorageUnavailableError(`Could not stat ${key}`, error);
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}
