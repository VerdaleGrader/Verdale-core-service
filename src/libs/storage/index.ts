import path from 'node:path';
import type { StorageConfigurations } from '@/config';
import type { FileStorage } from '@/libs/storage/file-storage';
import { LocalDiskFileStorage } from '@/libs/storage/local';
import { MemoryFileStorage } from '@/libs/storage/memory';
import { RetryingFileStorage } from '@/libs/storage/retrying';
import { S3FileStorage } from '@/libs/storage/s3';

export interface Storages {
  /** Private: test files, keyed by content hash. */
  tests: FileStorage;
  /** Public: statement pictures. */
  assets: FileStorage;
}

export function createStorages(config: StorageConfigurations): Storages {
  const retry = {
    attempts: config.retryAttempts,
    backoffMs: config.retryBackoffMs,
    timeoutMs: config.timeoutMs,
  };
  if (config.driver === 'r2' && config.r2) {
    const client = (bucket: string) =>
      new RetryingFileStorage(
        new S3FileStorage({
          endpoint: config.r2!.endpoint,
          accessKeyId: config.r2!.accessKeyId,
          secretAccessKey: config.r2!.secretAccessKey,
          bucket,
          timeoutMs: config.timeoutMs,
        }),
        retry
      );
    return { tests: client(config.r2.testsBucket), assets: client(config.r2.publicBucket) };
  }
  if (config.driver === 'local') {
    const root = path.resolve(config.localDir);
    return {
      tests: new RetryingFileStorage(new LocalDiskFileStorage(root), retry),
      assets: new RetryingFileStorage(new LocalDiskFileStorage(path.join(root, 'public')), retry),
    };
  }
  return { tests: new MemoryFileStorage(), assets: new MemoryFileStorage() };
}

export * from '@/libs/storage/file-storage';
