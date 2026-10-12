import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { PrismaClient, User } from '../../../generated/prisma/client';
import { IMAGE_CONTENT_TYPES, IMAGE_MAX_BYTES } from '@/constants/limits';
import { NotFoundError, ServiceUnavailableError, ValidationError } from '@/errors';
import { IMAGE_EXTENSIONS, ImageType, sniffImageType } from '@/libs/image-type';
import {
  FileStorage,
  StorageNotFoundError,
  StorageUnavailableError,
  imageKey,
} from '@/libs/storage/file-storage';
import { formatBytes } from '@/libs/test-file';
import TLogger, { Layer } from '@/logging/logger';
import ProblemService from '@/services/problem/problem.service';

export interface ImageUploadDto {
  url: string;
  markdown: string;
  content_type: string;
  size_bytes: number;
}

const CONTENT_TYPE_BY_EXTENSION: Record<string, ImageType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

/** Pictures for statements (GRD-27), in the public bucket under random names. */
export default class ImageService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly problemService: ProblemService,
    private readonly storage: FileStorage,
    /** Where browsers load pictures from, without a trailing slash. */
    private readonly publicBaseUrl: string
  ) {}

  async upload(
    user: User,
    slug: string,
    problemSlug: string,
    file: { filename: string; bytes: Buffer },
    requestId: string
  ): Promise<ImageUploadDto> {
    const logger = this.logger.setContext('service.image.upload', requestId);
    // Same permission as editing the problem: others cannot upload at all.
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    const label = file.filename ? `“${file.filename}”` : 'The file';
    if (file.bytes.length === 0) {
      throw new ValidationError([{ field: 'file', message: `${label} is empty.` }]);
    }
    if (file.bytes.length > IMAGE_MAX_BYTES) {
      throw new ValidationError([
        { field: 'file', message: `${label} is larger than ${formatBytes(IMAGE_MAX_BYTES)}.` },
      ]);
    }
    // The type comes from the bytes. A renamed .svg or .html is not an image here.
    const type = sniffImageType(file.bytes);
    if (!type) {
      throw new ValidationError([
        {
          field: 'file',
          message: `${label} is not a PNG, JPEG or WebP image.`,
        },
      ]);
    }
    const name = `${randomBytes(16).toString('hex')}.${IMAGE_EXTENSIONS[type]}`;
    try {
      await this.storage.put(imageKey(name), file.bytes, {
        size: file.bytes.length,
        contentType: type,
      });
    } catch (error) {
      if (error instanceof StorageUnavailableError) throw new ServiceUnavailableError();
      throw error;
    }
    const url = `${this.publicBaseUrl}/${name}`;
    logger.info({
      message: 'image uploaded',
      data: { problemId: problem.id, name, type, size: file.bytes.length },
    });
    return { url, markdown: `![](${url})`, content_type: type, size_bytes: file.bytes.length };
  }

  /** Serves a picture when the public bucket has no domain of its own (development). */
  async read(name: string): Promise<{ body: Readable; size: number; contentType: ImageType }> {
    const extension = name.split('.').pop() ?? '';
    const contentType = CONTENT_TYPE_BY_EXTENSION[extension];
    if (!contentType || !(IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      throw new NotFoundError('Image not found.');
    }
    try {
      const object = await this.storage.get(imageKey(name));
      return { body: object.body, size: object.size, contentType };
    } catch (error) {
      if (error instanceof StorageNotFoundError) throw new NotFoundError('Image not found.');
      if (error instanceof StorageUnavailableError) throw new ServiceUnavailableError();
      throw error;
    }
  }
}
