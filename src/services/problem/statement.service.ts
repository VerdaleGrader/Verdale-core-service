import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { PDFDocument } from 'pdf-lib';
import type { PrismaClient, User } from '../../../generated/prisma/client';
import { PDF_MAX_BYTES, PDF_MAX_PAGES } from '@/constants/limits';
import { NotFoundError, ServiceUnavailableError, ValidationError } from '@/errors';
import {
  FileStorage,
  StorageNotFoundError,
  StorageUnavailableError,
  statementPdfKey,
} from '@/libs/storage/file-storage';
import { formatBytes } from '@/libs/test-file';
import TLogger, { Layer } from '@/logging/logger';
import ProblemRepository from '@/repositories/problem.repository';
import { assertDraftEditable, assertAuthor } from '@/services/problem/problem.access';
import { currentVersionOf } from '@/services/problem/problem.mapper';
import ProblemService from '@/services/problem/problem.service';

export interface PdfFile {
  body: Readable;
  size: number;
  sha256: string;
}

const PDF_MAGIC = Buffer.from('%PDF-');

/** Counts the pages of a PDF, or says in plain words why it cannot be used. */
async function readPdf(bytes: Buffer, label: string): Promise<{ pages: number }> {
  if (!bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new ValidationError([{ field: 'file', message: `${label} is not a PDF.` }]);
  }
  let pages: number;
  try {
    const document = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    pages = document.getPageCount();
  } catch (error) {
    const encrypted = (error as Error)?.constructor?.name === 'EncryptedPDFError';
    throw new ValidationError([
      {
        field: 'file',
        message: encrypted
          ? `${label} is password-protected. Remove the password and upload it again.`
          : `${label} could not be read as a PDF.`,
      },
    ]);
  }
  if (pages < 1) {
    throw new ValidationError([{ field: 'file', message: `${label} has no pages.` }]);
  }
  if (pages > PDF_MAX_PAGES) {
    throw new ValidationError([
      {
        field: 'file',
        message: `${label} has ${pages} pages. A statement can have at most ${PDF_MAX_PAGES}.`,
      },
    ]);
  }
  return { pages };
}

/** PDF statements (GRD-73): upload, remove, and delivery after the same checks as the problem. */
export default class StatementService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly problems: ProblemRepository,
    private readonly problemService: ProblemService,
    /** The private bucket. Files are named by their SHA-256. */
    private readonly storage: FileStorage
  ) {}

  async upload(
    user: User,
    slug: string,
    problemSlug: string,
    file: { filename: string; bytes: Buffer },
    requestId: string
  ) {
    const logger = this.logger.setContext('service.statement.upload', requestId);
    const { access, problem: found } = await this.problemService.loadForAuthor(
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
    if (file.bytes.length > PDF_MAX_BYTES) {
      throw new ValidationError([
        { field: 'file', message: `${label} is larger than ${formatBytes(PDF_MAX_BYTES)}.` },
      ]);
    }
    const { pages } = await readPdf(file.bytes, label);
    const sha256 = createHash('sha256').update(file.bytes).digest('hex');
    try {
      await this.storage.put(statementPdfKey(sha256), file.bytes, {
        size: file.bytes.length,
        contentType: 'application/pdf',
      });
    } catch (error) {
      if (error instanceof StorageUnavailableError) throw new ServiceUnavailableError();
      throw error;
    }
    const problem = await this.prisma.$transaction(async (tx) => {
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
      message: 'statement pdf uploaded',
      data: { problemId: problem.id, sha256, pages, size: file.bytes.length },
    });
    return this.problemService.editorView(this.prisma, problem, access);
  }

  /** Takes the PDF off the draft and goes back to Markdown. The file stays in storage (other versions may use it). */
  async remove(user: User, slug: string, problemSlug: string, requestId: string) {
    const logger = this.logger.setContext('service.statement.remove', requestId);
    const { access, problem: found } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    const problem = await this.prisma.$transaction(async (tx) => {
      await this.problems.lock(tx, found.id);
      const fresh = (await this.problems.findById(tx, found.id))!;
      const draft = await this.problems.findDraftVersion(tx, fresh.id);
      assertDraftEditable(fresh, draft);
      await this.problems.updateVersion(tx, draft!.id, {
        statement_mode: 'markdown',
        statement_pdf_sha256: null,
        statement_pdf_size_bytes: null,
        statement_pdf_pages: null,
      });
      await this.problems.touch(tx, fresh.id);
      return (await this.problems.findById(tx, fresh.id))!;
    });
    logger.info({ message: 'statement pdf removed', data: { problemId: problem.id } });
    return this.problemService.editorView(this.prisma, problem, access);
  }

  /**
   * The PDF of a problem. Solvers get the current version and only when they could
   * open the problem (anything else is 404, a private Space included). Staff can ask
   * for the draft they are editing with `draft`.
   */
  async read(
    user: User | null,
    slug: string,
    problemSlug: string,
    options: { draft: boolean }
  ): Promise<PdfFile> {
    const { access, problem } = await this.problemService.loadForReader(
      this.prisma,
      user,
      slug,
      problemSlug
    );
    let version;
    if (options.draft) {
      assertAuthor(user, 'problem.view_private', access);
      version = await this.problemService.editorVersion(this.prisma, problem);
    } else {
      await this.problemService.assertVisible(user, access, problem);
      version = currentVersionOf(problem);
      if (version.statement_mode !== 'pdf') throw new NotFoundError('This problem has no PDF.');
    }
    if (!version.statement_pdf_sha256) throw new NotFoundError('This problem has no PDF.');
    try {
      const object = await this.storage.get(statementPdfKey(version.statement_pdf_sha256));
      return { body: object.body, size: object.size, sha256: version.statement_pdf_sha256 };
    } catch (error) {
      if (error instanceof StorageNotFoundError) {
        this.logger.setContext('service.statement.read').error({
          message: 'A statement PDF is missing from storage',
          data: { versionId: version.id },
          error,
        });
        throw new NotFoundError('This problem has no PDF.');
      }
      if (error instanceof StorageUnavailableError) throw new ServiceUnavailableError();
      throw error;
    }
  }
}
