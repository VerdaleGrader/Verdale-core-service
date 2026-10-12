import type { Readable } from 'node:stream';
import type { PrismaClient, TestCase, User } from '../../../generated/prisma/client';
import { TEST_LIMITS } from '@/constants/limits';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '@/errors';
import {
  FileStorage,
  StorageNotFoundError,
  StorageUnavailableError,
  testFileKey,
} from '@/libs/storage/file-storage';
import { NormalizedFile, TestFileError, formatBytes, normalizeTestFile } from '@/libs/test-file';
import TLogger, { Layer } from '@/logging/logger';
import { Db, isCheckViolation } from '@/repositories/db';
import ProblemRepository from '@/repositories/problem.repository';
import TestCaseRepository from '@/repositories/test-case.repository';
import { assertDraftEditable, versionPublishedError } from '@/services/problem/problem.access';
import ProblemService from '@/services/problem/problem.service';
import {
  TestCaseDto,
  TestLimitsDto,
  TestSummaryDto,
  testLimits,
  toTestCaseDto,
} from '@/services/problem/problem.mapper';

/** A file as it arrived in the upload. */
export interface UploadedFile {
  filename: string;
  bytes: Buffer;
}

export interface NewTestInput {
  input: UploadedFile;
  output: UploadedFile;
  is_sample: boolean;
}

export interface ReplaceTestInput {
  input?: UploadedFile;
  output?: UploadedFile;
}

export interface TestCaseListDto {
  items: TestCaseDto[];
  summary: TestSummaryDto;
  limits: TestLimitsDto;
  editable: boolean;
}

type FileSide = 'input' | 'output';

export default class TestCaseService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly problems: ProblemRepository,
    private readonly tests: TestCaseRepository,
    private readonly problemService: ProblemService,
    private readonly storage: FileStorage
  ) {}

  // --- reading ------------------------------------------------------------

  async list(user: User, slug: string, problemSlug: string): Promise<TestCaseListDto> {
    const { access, problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.view_private',
      slug,
      problemSlug
    );
    const version = await this.problemService.editorVersion(this.prisma, problem);
    return this.listView(this.prisma, version.id, {
      editable:
        version.status === 'draft' &&
        problem.status !== 'archived' &&
        access.space.archived_at === null,
    });
  }

  private async listView(db: Db, versionId: string, { editable }: { editable: boolean }) {
    const [items, summary] = await Promise.all([
      this.tests.listByVersion(db, versionId),
      this.tests.stats(db, versionId),
    ]);
    return { items: items.map(toTestCaseDto), summary, limits: testLimits(), editable };
  }

  /** One file of a test, for the author to look at. */
  async download(
    user: User,
    slug: string,
    problemSlug: string,
    testId: string,
    side: FileSide
  ): Promise<{ body: Readable; size: number; fileName: string }> {
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.view_private',
      slug,
      problemSlug
    );
    const version = await this.problemService.editorVersion(this.prisma, problem);
    const test = await this.tests.find(this.prisma, version.id, testId);
    if (!test) throw new NotFoundError('Test not found.');
    const sha = side === 'input' ? test.input_sha256 : test.output_sha256;
    try {
      const object = await this.storage.get(testFileKey(sha));
      return {
        body: object.body,
        size: object.size,
        fileName: `${problem.slug}-${test.position}.${side === 'input' ? 'in' : 'out'}`,
      };
    } catch (error) {
      throw this.storageFailure(error, 'service.testCase.download');
    }
  }

  // --- changing -----------------------------------------------------------

  async create(
    user: User,
    slug: string,
    problemSlug: string,
    input: NewTestInput,
    requestId: string
  ): Promise<TestCaseDto> {
    const logger = this.logger.setContext('service.testCase.create', requestId);
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    const version = await this.draftOrFail(this.prisma, problem);

    const files = this.normalizeFiles(
      { input: input.input, output: input.output },
      input.is_sample
    );
    const before = await this.tests.stats(this.prisma, version.id);
    this.assertRoom(before, files.input!.size + files.output!.size, 0);
    await this.store(files);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await this.problems.lock(tx, problem.id);
        const fresh = (await this.problems.findById(tx, problem.id))!;
        assertDraftEditable(fresh, await this.problems.findDraftVersion(tx, problem.id));
        const stats = await this.tests.stats(tx, version.id);
        this.assertRoom(stats, files.input!.size + files.output!.size, 0);
        if (input.is_sample && stats.sample_count >= TEST_LIMITS.max_samples) {
          throw sampleCountError();
        }
        const row = await this.tests.create(tx, {
          problem_version_id: version.id,
          position: await this.tests.nextPosition(tx, version.id),
          is_sample: input.is_sample,
          input_sha256: files.input!.sha256,
          output_sha256: files.output!.sha256,
          input_size_bytes: files.input!.size,
          output_size_bytes: files.output!.size,
        });
        await this.problems.touch(tx, problem.id);
        return row;
      });
      logger.info({
        message: 'test added',
        data: { problemId: problem.id, testId: created.id, position: created.position },
      });
      return toTestCaseDto(created);
    } catch (error) {
      if (isCheckViolation(error)) throw versionPublishedError();
      throw error;
    }
  }

  async replace(
    user: User,
    slug: string,
    problemSlug: string,
    testId: string,
    input: ReplaceTestInput,
    requestId: string
  ): Promise<TestCaseDto> {
    const logger = this.logger.setContext('service.testCase.replace', requestId);
    if (!input.input && !input.output) {
      throw new ValidationError([
        { field: 'input', message: 'Send a new input file, a new output file, or both.' },
      ]);
    }
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    const version = await this.draftOrFail(this.prisma, problem);
    const existing = await this.tests.find(this.prisma, version.id, testId);
    if (!existing) throw new NotFoundError('Test not found.');

    const files = this.normalizeFiles(input, existing.is_sample);
    await this.store(files);

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        await this.problems.lock(tx, problem.id);
        const fresh = (await this.problems.findById(tx, problem.id))!;
        assertDraftEditable(fresh, await this.problems.findDraftVersion(tx, problem.id));
        const current = await this.tests.find(tx, version.id, testId);
        if (!current) throw new NotFoundError('Test not found.');
        const newBytes =
          (files.input?.size ?? current.input_size_bytes) +
          (files.output?.size ?? current.output_size_bytes);
        const stats = await this.tests.stats(tx, version.id);
        this.assertRoom(
          stats,
          newBytes,
          current.input_size_bytes + current.output_size_bytes,
          false
        );
        const row = await this.tests.update(tx, testId, {
          ...(files.input
            ? { input_sha256: files.input.sha256, input_size_bytes: files.input.size }
            : {}),
          ...(files.output
            ? { output_sha256: files.output.sha256, output_size_bytes: files.output.size }
            : {}),
        });
        await this.problems.touch(tx, problem.id);
        return row;
      });
      logger.info({ message: 'test replaced', data: { problemId: problem.id, testId } });
      return toTestCaseDto(updated);
    } catch (error) {
      if (isCheckViolation(error)) throw versionPublishedError();
      throw error;
    }
  }

  async setSample(
    user: User,
    slug: string,
    problemSlug: string,
    testId: string,
    isSample: boolean,
    requestId: string
  ): Promise<TestCaseDto> {
    const logger = this.logger.setContext('service.testCase.setSample', requestId);
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    const version = await this.draftOrFail(this.prisma, problem);
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        await this.problems.lock(tx, problem.id);
        const fresh = (await this.problems.findById(tx, problem.id))!;
        assertDraftEditable(fresh, await this.problems.findDraftVersion(tx, problem.id));
        const test = await this.tests.find(tx, version.id, testId);
        if (!test) throw new NotFoundError('Test not found.');
        if (isSample && !test.is_sample) {
          this.assertFitsSample(test);
          const stats = await this.tests.stats(tx, version.id);
          if (stats.sample_count >= TEST_LIMITS.max_samples) throw sampleCountError();
        }
        const row = await this.tests.update(tx, testId, { is_sample: isSample });
        await this.problems.touch(tx, problem.id);
        return row;
      });
      logger.info({ message: 'test sample flag changed', data: { testId, isSample } });
      return toTestCaseDto(updated);
    } catch (error) {
      if (isCheckViolation(error)) throw versionPublishedError();
      throw error;
    }
  }

  async remove(
    user: User,
    slug: string,
    problemSlug: string,
    testId: string,
    requestId: string
  ): Promise<void> {
    const logger = this.logger.setContext('service.testCase.remove', requestId);
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    const version = await this.draftOrFail(this.prisma, problem);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.problems.lock(tx, problem.id);
        const fresh = (await this.problems.findById(tx, problem.id))!;
        assertDraftEditable(fresh, await this.problems.findDraftVersion(tx, problem.id));
        const test = await this.tests.find(tx, version.id, testId);
        if (!test) throw new NotFoundError('Test not found.');
        await this.tests.delete(tx, testId);
        await this.tests.closeGap(tx, version.id, test.position);
        await this.problems.touch(tx, problem.id);
      });
    } catch (error) {
      if (isCheckViolation(error)) throw versionPublishedError();
      throw error;
    }
    // The stored files stay: other tests (or other problems) may use the same content.
    logger.info({ message: 'test removed', data: { problemId: problem.id, testId } });
  }

  async reorder(
    user: User,
    slug: string,
    problemSlug: string,
    testIds: string[],
    requestId: string
  ): Promise<TestCaseListDto> {
    const logger = this.logger.setContext('service.testCase.reorder', requestId);
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    const version = await this.draftOrFail(this.prisma, problem);
    try {
      const view = await this.prisma.$transaction(async (tx) => {
        await this.problems.lock(tx, problem.id);
        const fresh = (await this.problems.findById(tx, problem.id))!;
        assertDraftEditable(fresh, await this.problems.findDraftVersion(tx, problem.id));
        const current = await this.tests.listByVersion(tx, version.id);
        const known = new Set(current.map((test) => test.id));
        const unique = new Set(testIds);
        if (
          testIds.length !== current.length ||
          unique.size !== testIds.length ||
          testIds.some((id) => !known.has(id))
        ) {
          throw new ValidationError([
            { field: 'test_ids', message: 'List every test of this problem exactly once.' },
          ]);
        }
        for (const [index, id] of testIds.entries()) {
          const test = current.find((candidate) => candidate.id === id)!;
          if (test.position !== index + 1) await this.tests.setPosition(tx, id, index + 1);
        }
        await this.problems.touch(tx, problem.id);
        return this.listView(tx, version.id, { editable: true });
      });
      logger.info({ message: 'tests reordered', data: { problemId: problem.id } });
      return view;
    } catch (error) {
      if (isCheckViolation(error)) throw versionPublishedError();
      throw error;
    }
  }

  // --- helpers ------------------------------------------------------------

  private async draftOrFail(
    db: Db,
    problem: { id: string; status: 'draft' | 'published' | 'archived' }
  ) {
    const draft = await this.problems.findDraftVersion(db, problem.id);
    assertDraftEditable(problem, draft);
    return draft!;
  }

  /**
   * Checks and normalises each file. Both sides are checked before anything is
   * reported, so one upload shows every problem at once, each against the file
   * that caused it.
   */
  private normalizeFiles(
    files: Partial<Record<FileSide, UploadedFile>>,
    isSample: boolean
  ): Partial<Record<FileSide, NormalizedFile>> {
    const problems: Array<{ field: string; message: string }> = [];
    const result: Partial<Record<FileSide, NormalizedFile>> = {};
    for (const side of ['input', 'output'] as const) {
      const file = files[side];
      if (!file) continue;
      const label = file.filename ? `“${file.filename}” (${side})` : `The ${side} file`;
      try {
        const normalized = normalizeTestFile(file.bytes, { maxBytes: TEST_LIMITS.max_file_bytes });
        if (isSample && normalized.size > TEST_LIMITS.max_sample_bytes) {
          throw new TestFileError(
            `is ${formatBytes(normalized.size)}, too large for a sample (at most ${formatBytes(TEST_LIMITS.max_sample_bytes)}); keep it as a hidden test`,
            'TOO_LARGE_FOR_SAMPLE'
          );
        }
        result[side] = normalized;
      } catch (error) {
        if (!(error instanceof TestFileError)) throw error;
        problems.push({ field: side, message: `${label} ${error.reason}.` });
      }
    }
    if (problems.length > 0) throw new ValidationError(problems);
    return result;
  }

  private assertFitsSample(test: TestCase) {
    for (const side of ['input', 'output'] as const) {
      const size = side === 'input' ? test.input_size_bytes : test.output_size_bytes;
      if (size > TEST_LIMITS.max_sample_bytes) {
        throw new ConflictError(
          `The ${side} file is ${formatBytes(size)}, too large for a sample (at most ${formatBytes(TEST_LIMITS.max_sample_bytes)}).`,
          'SAMPLE_TOO_LARGE'
        );
      }
    }
  }

  /** The per-problem limits. `replacedBytes` is what the changed test occupied before. */
  private assertRoom(
    stats: TestSummaryDto,
    addedBytes: number,
    replacedBytes: number,
    isNewTest = true
  ) {
    if (isNewTest && stats.count >= TEST_LIMITS.max_count) {
      throw new ConflictError(
        `A problem can have at most ${TEST_LIMITS.max_count} tests.`,
        'TEST_LIMIT_REACHED'
      );
    }
    if (stats.total_bytes - replacedBytes + addedBytes > TEST_LIMITS.max_total_bytes) {
      throw new ConflictError(
        `All tests together can be at most ${formatBytes(TEST_LIMITS.max_total_bytes)}.`,
        'TEST_SIZE_LIMIT_REACHED'
      );
    }
  }

  /** Content-addressed: identical content is stored once, so existing objects are skipped. */
  private async store(files: Partial<Record<FileSide, NormalizedFile>>) {
    try {
      const unique = new Map<string, NormalizedFile>();
      for (const file of Object.values(files)) if (file) unique.set(file.sha256, file);
      for (const file of unique.values()) {
        const key = testFileKey(file.sha256);
        const existing = await this.storage.head(key);
        if (existing && existing.size === file.size) continue;
        await this.storage.put(key, file.bytes, {
          size: file.size,
          contentType: 'text/plain; charset=utf-8',
        });
      }
    } catch (error) {
      throw this.storageFailure(error, 'service.testCase.store');
    }
  }

  private storageFailure(error: unknown, context: string): Error {
    if (error instanceof StorageUnavailableError) return new ServiceUnavailableError();
    if (error instanceof StorageNotFoundError) {
      this.logger
        .setContext(context)
        .error({ message: 'A test file is missing from storage', error });
    }
    return error as Error;
  }
}

function sampleCountError() {
  return new ConflictError(
    `A problem can have at most ${TEST_LIMITS.max_samples} sample tests.`,
    'SAMPLE_LIMIT_REACHED'
  );
}
