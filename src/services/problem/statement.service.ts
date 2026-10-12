import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { PrismaClient, User } from '../../../generated/prisma/client';
import { PDF_MAX_BYTES, PDF_MAX_PAGES } from '@/constants/limits';
import { NotFoundError, ServiceUnavailableError, ValidationError } from '@/errors';
import { PdfRejectedError, countPdfPages, hasPdfHeader } from '@/libs/pdf';
import {
  FileStorage,
  StorageNotFoundError,
  StorageUnavailableError,
  statementPdfKey,
} from '@/libs/storage/file-storage';
import { formatBytes } from '@/libs/test-file';
import TLogger, { Layer } from '@/logging/logger';
import ProblemRepository from '@/repositories/problem.repository';
import { assertDraftEditable, isAuthor } from '@/services/problem/problem.access';
import { currentVersionOf } from '@/services/problem/problem.mapper';
import ProblemService from '@/services/problem/problem.service';

export interface PdfStatement {
  body: Readable;
  size: number;
  sha256: string;
}

/**
 * PDF statements (GRD-73). The file lives in the private bucket under the
 * SHA-256 of its bytes, is never reachable except through Core's permission
 * check, and is served with headers that stop a browser from running anything
 * inside it.
 */
export default class StatementService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly problems: ProblemRepository,
    private readonly problemService: ProblemService,
    private readonly storage: FileStorage
  ) {}

  async uploadPdf(
    user: User,
    slug: string,
    problemSlug: string,
    file: { filename: string; bytes: Buffer },
    requestId: string
  ) {
    const logger = this.logger.setContext('service.statement.uploadPdf', requestId);
    const { access, problem: found } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    const label = file.filename ? `“${file.filename}”` : 'The file';
    const refuse = (message: string): never => {
      throw new ValidationError([{ field: 'file', message: `${label} ${message}.` }]);
    };
    if (file.bytes.length === 0) refuse('is empty');
    if (file.bytes.length > PDF_MAX_BYTES) refuse(`is larger than ${formatBytes(PDF_MAX_BYTES)}`);
    if (!hasPdfHeader(file.bytes)) refuse('is not a PDF file');
    let pages: number;
    try {
      pages = await countPdfPages(file.bytes);
    } catch (error) {
      if (error instanceof PdfRejectedError) return refuse(error.message);
      throw error;
    }
    if (pages > PDF_MAX_PAGES) refuse(`has ${pages} pages; at most ${PDF_MAX_PAGES} are allowed`);

    const sha256 = createHash('sha256').update(file.bytes).digest('hex');
    try {
      // Same bytes, same key: an existing object is already right.
      if (!(await this.storage.head(statementPdfKey(sha256)))) {
        await this.storage.put(statementPdfKey(sha256), file.bytes, {
          size: file.bytes.length,
          contentType: 'application/pdf',
        });
      }
    } catch (error) {
      if (error instanceof StorageUnavailableError) throw new ServiceUnavailableError();
      throw error;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.problems.lock(tx, found.id);
      const fresh = (await this.problems.findById(tx, found.id))!;
      const draft = await this.problems.findDraftVersion(tx, fresh.id);
      assertDraftEditable(fresh, draft);
      await this.problems.updateVersion(tx, draft!.id, {
        statement_mode: 'pdf',
        statement_pdf_sha256: sha256,
        statement_pdf_size_bytes: file.bytes.length,
        statement_pdf_pages: pages,
      });
      await this.problems.touch(tx, fresh.id);
      return (await this.problems.findById(tx, fresh.id))!;
    });
    logger.info({
      message: 'pdf statement uploaded',
      data: { problemId: found.id, sha256, pages, size: file.bytes.length },
    });
    return this.problemService.editorView(this.prisma, updated, access);
  }

  /**
   * The PDF of the version solvers see; owners and editors can ask for the
   * draft they are working on. Permission is the same as reading the problem:
   * anything a solver may not read is a 404, drafts and strangers included.
   */
  async readPdf(
    user: User | null,
    slug: string,
    problemSlug: string,
    options: { draft: boolean }
  ): Promise<PdfStatement> {
    const { access, problem, inTrack } = await this.problemService.loadForReader(
      this.prisma,
      user,
      slug,
      problemSlug
    );
    this.problemService.assertReadable(user, access, problem, inTrack);
    const version =
      options.draft && isAuthor(user, access)
        ? await this.problemService.editorVersion(this.prisma, problem)
        : currentVersionOf(problem);
    if (version.statement_mode !== 'pdf' || !version.statement_pdf_sha256) {
      throw new NotFoundError('This problem has no PDF statement.');
    }
    try {
      const object = await this.storage.get(statementPdfKey(version.statement_pdf_sha256));
      return { body: object.body, size: object.size, sha256: version.statement_pdf_sha256 };
    } catch (error) {
      if (error instanceof StorageNotFoundError) {
        this.logger
          .setContext('service.statement.readPdf')
          .error({ message: 'A PDF statement is missing from storage', data: { slug }, error });
        throw new NotFoundError('The PDF statement could not be found.');
      }
      if (error instanceof StorageUnavailableError) throw new ServiceUnavailableError();
      throw error;
    }
  }
}
