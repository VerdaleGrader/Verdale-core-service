import { createHash } from 'node:crypto';
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
import { SLICE_LIMITS, TextSlice, sliceText } from '@/libs/text-slice';
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
  /**
   * Changes whenever the testcases do. A save sends the one it started from, so
   * two people editing at once cannot silently overwrite each other (409 TESTS_CHANGED).
   */
  revision: string;
}

/** A file that was checked, normalised and stored, ready to be used in a save. */
export interface StagedFileDto {
  sha256: string;
  size_bytes: number;
  total_lines: number;
}

export interface BatchTestInput {
  /** An existing testcase; left out for a new one. */
  id?: string;
  is_sample: boolean;
  /** Left out: unchanged for an existing testcase (required for a new one). */
  input?: { sha256: string };
  /** Left out: unchanged for an existing testcase, none for a new one. */
  output?: { sha256: string };
}

export interface BatchSaveInput {
  revision?: string;
  /** The testcases the problem should have afterwards, in order. Those not listed are removed. */
  tests: BatchTestInput[];
}

/** Identifies the testcases of a version: their order, files and visibility. */
export function testsRevision(
  rows: Array<Pick<TestCase, 'id' | 'position' | 'input_sha256' | 'output_sha256' | 'is_sample'>>
): string {
  const text = rows
    .map(
      (row) =>
        `${row.id}|${row.position}|${row.input_sha256}|${row.output_sha256 ?? ''}|${row.is_sample}`
    )
    .join('\n');
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
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
    return {
      items: items.map(toTestCaseDto),
      summary,
      limits: testLimits(),
      editable,
      revision: testsRevision(items),
    };
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
    if (!sha) throw new NotFoundError('This testcase has no expected output yet.');
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
          (files.output?.size ?? current.output_size_bytes ?? 0);
        const stats = await this.tests.stats(tx, version.id);
        this.assertRoom(
          stats,
          newBytes,
          current.input_size_bytes + (current.output_size_bytes ?? 0),
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

  // --- the whole page at once (GRD-108) -----------------------------------

  /**
   * Checks, normalises and stores one file so a later save can refer to it by
   * its hash. Nothing in the problem changes: storage is content-addressed, so
   * a file nobody uses is only an unreferenced object.
   */
  async stageFile(
    user: User,
    slug: string,
    problemSlug: string,
    file: UploadedFile
  ): Promise<StagedFileDto> {
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    await this.draftOrFail(this.prisma, problem);
    let normalized: NormalizedFile;
    try {
      normalized = normalizeTestFile(file.bytes, { maxBytes: TEST_LIMITS.max_file_bytes });
    } catch (error) {
      if (!(error instanceof TestFileError)) throw error;
      const label = file.filename ? `“${file.filename}”` : 'The file';
      throw new ValidationError([{ field: 'file', message: `${label} ${error.reason}.` }]);
    }
    await this.store({ input: normalized });
    return {
      sha256: normalized.sha256,
      size_bytes: normalized.size,
      total_lines:
        normalized.size === 0 ? 0 : normalized.bytes.toString('utf8').split('\n').length - 1,
    };
  }

  /**
   * Saves every change of the testcases page in one transaction: order,
   * visibility, new testcases, removed ones, replaced files. Either all of it
   * is saved or none (GRD-108). Files are referred to by hash, uploaded
   * earlier with `stageFile` (or created by Generate).
   */
  async batchSave(
    user: User,
    slug: string,
    problemSlug: string,
    input: BatchSaveInput,
    requestId: string
  ): Promise<TestCaseListDto> {
    const logger = this.logger.setContext('service.testCase.batchSave', requestId);
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    const version = await this.draftOrFail(this.prisma, problem);

    // Sizes of every file the request mentions; a file that was never uploaded is refused.
    const wanted = new Set<string>();
    for (const test of input.tests) {
      if (test.input) wanted.add(test.input.sha256);
      if (test.output) wanted.add(test.output.sha256);
    }
    const sizes = new Map<string, number>();
    try {
      for (const sha of wanted) {
        const info = await this.storage.head(testFileKey(sha));
        if (info) sizes.set(sha, info.size);
      }
    } catch (error) {
      throw this.storageFailure(error, 'service.testCase.batchSave');
    }

    try {
      const view = await this.prisma.$transaction(async (tx) => {
        await this.problems.lock(tx, problem.id);
        const fresh = (await this.problems.findById(tx, problem.id))!;
        assertDraftEditable(fresh, await this.problems.findDraftVersion(tx, problem.id));
        const current = await this.tests.listByVersion(tx, version.id);

        if (input.revision && input.revision !== testsRevision(current)) {
          throw new ConflictError(
            'The testcases changed since you opened this page. Reload to see the latest, then make your changes again.',
            'TESTS_CHANGED'
          );
        }
        const byId = new Map(current.map((test) => [test.id, test]));
        const seen = new Set<string>();
        const problems: Array<{ field: string; message: string }> = [];

        type Planned = {
          existing: TestCase | null;
          is_sample: boolean;
          input_sha256: string;
          input_size_bytes: number;
          output_sha256: string | null;
          output_size_bytes: number | null;
        };
        const planned: Planned[] = [];
        for (const [index, test] of input.tests.entries()) {
          const field = `tests[${index}]`;
          const existing = test.id ? (byId.get(test.id) ?? null) : null;
          if (test.id && !existing) {
            problems.push({
              field: `${field}.id`,
              message: 'This testcase does not belong to this problem.',
            });
            continue;
          }
          if (existing) {
            if (seen.has(existing.id)) {
              problems.push({ field: `${field}.id`, message: 'List each testcase once.' });
              continue;
            }
            seen.add(existing.id);
          }
          const resolve = (side: 'input' | 'output', ref?: { sha256: string }) => {
            if (!ref) return undefined;
            const size = sizes.get(ref.sha256);
            if (size === undefined) {
              problems.push({
                field: `${field}.${side}`,
                message: 'This file was not uploaded. Upload it first, then save.',
              });
              return undefined;
            }
            return { sha256: ref.sha256, size };
          };
          const newInput = resolve('input', test.input);
          const newOutput = resolve('output', test.output);
          if (!existing && !test.input) {
            problems.push({ field: `${field}.input`, message: 'A new testcase needs an input.' });
            continue;
          }
          planned.push({
            existing,
            is_sample: test.is_sample,
            input_sha256: newInput?.sha256 ?? existing?.input_sha256 ?? '',
            input_size_bytes: newInput?.size ?? existing?.input_size_bytes ?? 0,
            output_sha256: newOutput?.sha256 ?? existing?.output_sha256 ?? null,
            output_size_bytes: newOutput?.size ?? existing?.output_size_bytes ?? null,
          });
        }
        if (problems.length > 0) throw new ValidationError(problems);

        if (planned.length > TEST_LIMITS.max_count) {
          throw new ConflictError(
            `A problem can have at most ${TEST_LIMITS.max_count} tests.`,
            'TEST_LIMIT_REACHED'
          );
        }
        const samples = planned.filter((test) => test.is_sample);
        if (samples.length > TEST_LIMITS.max_samples) throw sampleCountError();
        for (const test of samples) {
          const tooBig = [test.input_size_bytes, test.output_size_bytes ?? 0].find(
            (size) => size > TEST_LIMITS.max_sample_bytes
          );
          if (tooBig !== undefined) {
            throw new ConflictError(
              `A sample can be at most ${formatBytes(TEST_LIMITS.max_sample_bytes)} (one is ${formatBytes(tooBig)}). Keep large testcases hidden.`,
              'SAMPLE_TOO_LARGE'
            );
          }
        }
        const total = planned.reduce(
          (sum, test) => sum + test.input_size_bytes + (test.output_size_bytes ?? 0),
          0
        );
        if (total > TEST_LIMITS.max_total_bytes) {
          throw new ConflictError(
            `All tests together can be at most ${formatBytes(TEST_LIMITS.max_total_bytes)}.`,
            'TEST_SIZE_LIMIT_REACHED'
          );
        }

        for (const old of current.filter((test) => !seen.has(test.id))) {
          await this.tests.delete(tx, old.id);
        }
        for (const [index, test] of planned.entries()) {
          const data = {
            position: index + 1,
            is_sample: test.is_sample,
            input_sha256: test.input_sha256,
            input_size_bytes: test.input_size_bytes,
            output_sha256: test.output_sha256,
            output_size_bytes: test.output_size_bytes,
          };
          if (test.existing) {
            const same =
              test.existing.position === data.position &&
              test.existing.is_sample === data.is_sample &&
              test.existing.input_sha256 === data.input_sha256 &&
              test.existing.output_sha256 === data.output_sha256;
            if (!same) await this.tests.update(tx, test.existing.id, data);
          } else {
            await this.tests.create(tx, { problem_version_id: version.id, ...data });
          }
        }
        await this.problems.touch(tx, problem.id);
        return this.listView(tx, version.id, { editable: true });
      });
      logger.info({
        message: 'tests saved',
        data: { problemId: problem.id, count: view.items.length },
      });
      return view;
    } catch (error) {
      if (isCheckViolation(error)) throw versionPublishedError();
      throw error;
    }
  }

  /** A window of lines of one file of a testcase, for the preview and "View all". */
  async slice(
    user: User,
    slug: string,
    problemSlug: string,
    testId: string,
    side: FileSide,
    window: { fromLine: number; maxLines: number }
  ): Promise<TextSlice & { position: number; side: FileSide }> {
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
    if (!sha) throw new NotFoundError('This testcase has no expected output yet.');
    try {
      const object = await this.storage.get(testFileKey(sha));
      const slice = await sliceText(object.body, {
        fromLine: window.fromLine,
        maxLines: window.maxLines,
        maxLineChars: SLICE_LIMITS.max_line_chars,
      });
      return { ...slice, position: test.position, side };
    } catch (error) {
      throw this.storageFailure(error, 'service.testCase.slice');
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
      if (size !== null && size > TEST_LIMITS.max_sample_bytes) {
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
    `A problem can have at most ${TEST_LIMITS.max_samples} sample testcases.`,
    'SAMPLE_LIMIT_REACHED'
  );
}
