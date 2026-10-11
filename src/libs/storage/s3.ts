import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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
} from '@/libs/storage/file-storage';

export interface S3Options {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** R2 uses "auto". */
  region?: string;
  /** Per request; the SDK's own retries are off, RetryingFileStorage does that. */
  timeoutMs: number;
}

interface AwsLikeError {
  name?: string;
  code?: string;
  $metadata?: { httpStatusCode?: number };
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'TimeoutError',
  'RequestTimeout',
  'NetworkingError',
]);

/** Turns whatever the SDK threw into our error classes. */
export function mapS3Error(error: unknown, key: string): StorageError {
  const failure = error as AwsLikeError;
  const status = failure.$metadata?.httpStatusCode;
  if (failure.name === 'NoSuchKey' || failure.name === 'NotFound' || status === 404) {
    return new StorageNotFoundError(key);
  }
  if (
    (status !== undefined && (status >= 500 || status === 429 || status === 408)) ||
    NETWORK_CODES.has(failure.code ?? '') ||
    NETWORK_CODES.has(failure.name ?? '')
  ) {
    return new StorageUnavailableError(`Storage is unavailable (${key})`, error);
  }
  return new StorageError(`Storage refused the request (${key})`, error);
}

/** Cloudflare R2 (or any S3-compatible service) over the S3 API. */
export class S3FileStorage implements FileStorage {
  private readonly client: S3Client;

  constructor(private readonly options: S3Options) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region ?? 'auto',
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      forcePathStyle: true,
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  private send<T>(key: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    return run(controller.signal)
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          throw new StorageUnavailableError(`Storage timed out (${key})`, error);
        }
        throw mapS3Error(error, key);
      })
      .finally(() => clearTimeout(timer));
  }

  async put(key: string, body: Buffer | Readable, options: PutOptions): Promise<void> {
    assertSafeKey(key);
    await this.send(key, (signal) =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          Body: body,
          ContentLength: options.size,
          ContentType: options.contentType,
        }),
        { abortSignal: signal }
      )
    );
  }

  async get(key: string): Promise<StoredObject> {
    assertSafeKey(key);
    const output = await this.send(key, (signal) =>
      this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }), {
        abortSignal: signal,
      })
    );
    if (!(output.Body instanceof Readable)) {
      throw new StorageError(`Unexpected response body (${key})`);
    }
    return { body: output.Body, size: output.ContentLength ?? 0 };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    assertSafeKey(key);
    try {
      const output = await this.send(key, (signal) =>
        this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }), {
          abortSignal: signal,
        })
      );
      return { size: output.ContentLength ?? 0 };
    } catch (error) {
      if (error instanceof StorageNotFoundError) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.send(key, (signal) =>
      this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }), {
        abortSignal: signal,
      })
    );
  }
}
