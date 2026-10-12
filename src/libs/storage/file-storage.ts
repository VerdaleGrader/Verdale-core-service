import type { Readable } from 'node:stream';

/**
 * File storage behind one interface (GRD-23), so the provider (Cloudflare R2
 * today) can change without touching business logic. Services only ever use
 * this; nothing outside src/libs/storage imports an SDK.
 *
 * Two buckets use it: the private one holds test files, keyed by the SHA-256
 * of their content (`tests/<sha256>`, which is also how Judge finds them);
 * the public one holds statement pictures under random names.
 */
export interface PutOptions {
  /** Exact size of `body` in bytes. */
  size: number;
  contentType?: string;
}

export interface StoredObject {
  body: Readable;
  size: number;
}

export interface ObjectInfo {
  size: number;
}

export interface FileStorage {
  /** Stores (or overwrites) an object. Content-addressed keys make overwriting harmless. */
  put(key: string, body: Buffer | Readable, options: PutOptions): Promise<void>;
  /** Opens an object as a stream. Throws StorageNotFoundError when it does not exist. */
  get(key: string): Promise<StoredObject>;
  /** Size of an object, or null when it does not exist. */
  head(key: string): Promise<ObjectInfo | null>;
  /** Removes an object; removing one that does not exist is not an error. */
  delete(key: string): Promise<void>;
}

/** Base class: the provider refused or failed in a way that retrying will not fix. */
export class StorageError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export class StorageNotFoundError extends StorageError {
  constructor(key: string) {
    super(`Object not found: ${key}`);
    this.name = 'StorageNotFoundError';
  }
}

/** Network failure, timeout, throttling or a 5xx: worth retrying, and the caller may answer 503. */
export class StorageUnavailableError extends StorageError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'StorageUnavailableError';
  }
}

/** Key of a test file in the private bucket (the layout Judge reads). */
export function testFileKey(sha256: string): string {
  return `tests/${sha256}`;
}

/** Key of a statement picture in the public bucket. */
export function imageKey(fileName: string): string {
  return `images/${fileName}`;
}

/** Refuses keys that could climb out of a directory. */
export function assertSafeKey(key: string): void {
  if (
    key.length === 0 ||
    key.length > 512 ||
    key.startsWith('/') ||
    key.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    key.includes('\\') ||
    key.includes('\0')
  ) {
    throw new StorageError(`Invalid storage key: ${JSON.stringify(key)}`);
  }
}

export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
