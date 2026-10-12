import type { Readable } from 'node:stream';
import {
  FileStorage,
  ObjectInfo,
  PutOptions,
  StoredObject,
  StorageUnavailableError,
} from '@/libs/storage/file-storage';

export interface RetryOptions {
  /** Total tries per call, including the first. */
  attempts: number;
  /** Delay before the second try; doubles each time. */
  backoffMs: number;
  /** Upper bound for one try, whatever the provider does. */
  timeoutMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * One policy for every provider: a try that exceeds `timeoutMs` counts as
 * unavailable, unavailable errors are retried with exponential backoff, and
 * anything else (not found, refused) is returned at once. A body that is a
 * stream cannot be sent twice, so it gets a single try.
 */
export class RetryingFileStorage implements FileStorage {
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly inner: FileStorage,
    private readonly options: RetryOptions
  ) {
    this.sleep = options.sleep ?? defaultSleep;
  }

  private async attempt<T>(operation: string, run: () => Promise<T>, tries: number): Promise<T> {
    let delay = this.options.backoffMs;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.withTimeout(operation, run);
      } catch (error) {
        if (!(error instanceof StorageUnavailableError) || attempt >= tries) throw error;
        await this.sleep(delay);
        delay *= 2;
      }
    }
  }

  private withTimeout<T>(operation: string, run: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new StorageUnavailableError(`Storage ${operation} timed out`)),
        this.options.timeoutMs
      );
    });
    return Promise.race([run(), timeout]).finally(() => clearTimeout(timer));
  }

  put(key: string, body: Buffer | Readable, options: PutOptions): Promise<void> {
    const tries = Buffer.isBuffer(body) ? this.options.attempts : 1;
    return this.attempt('put', () => this.inner.put(key, body, options), tries);
  }

  get(key: string): Promise<StoredObject> {
    return this.attempt('get', () => this.inner.get(key), this.options.attempts);
  }

  head(key: string): Promise<ObjectInfo | null> {
    return this.attempt('head', () => this.inner.head(key), this.options.attempts);
  }

  delete(key: string): Promise<void> {
    return this.attempt('delete', () => this.inner.delete(key), this.options.attempts);
  }
}
