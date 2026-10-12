import type { PrismaClient, User } from '../../../generated/prisma/client';
import {
  isValidProblemSlug,
  PROBLEM_SLUG_PATTERN,
  RESERVED_PROBLEM_SLUGS,
} from '@/constants/identifiers';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '@/errors';
import {
  StorageNotFoundError,
  StorageUnavailableError,
  FileStorage,
  readAll,
  testFileKey,
} from '@/libs/storage/file-storage';
import TLogger, { Layer } from '@/logging/logger';
import { Db, isCheckViolation, isUniqueViolation } from '@/repositories/db';
import ProblemRepository, { ProblemWithVersion } from '@/repositories/problem.repository';
import SolutionRepository from '@/repositories/solution.repository';
import TrackRepository from '@/repositories/track.repository';
import TestCaseRepository from '@/repositories/test-case.repository';
import {
  assertDraftEditable,
  assertAuthor,
  isAuthor,
  versionPublishedError,
} from '@/services/problem/problem.access';
import {
  Language,
  ProblemConstraintsDto,
  ProblemStatusName,
  ProblemSummaryDto,
  StatementModeName,
  ProblemVersionDto,
  TestSummaryDto,
  constraints,
  currentVersionOf,
  toProblemSummary,
  toVersionDto,
} from '@/services/problem/problem.mapper';
import { PublishCheck, buildPublishChecks } from '@/services/problem/publish-checks';
import { SpaceAccess, actorOf, assertCan, resourceOf } from '@/services/space/space.access';
import { can } from '@/permissions/can';
import SpaceService from '@/services/space/space.service';
import { Page } from '@/services/space/space.mapper';
import { PublicUser, toPublicUser } from '@/services/user/user.mapper';

export interface CreateProblemInput {
  slug: string;
  title: string;
  statement: string;
  time_limit_ms: number;
  memory_limit_kb: number;
  allowed_languages: string[];
}

export interface UpdateProblemInput {
  title?: string;
  statement?: string;
  statement_mode?: 'markdown' | 'pdf';
  time_limit_ms?: number;
  memory_limit_kb?: number;
  allowed_languages?: string[];
}

export interface ProblemListInput {
  q?: string;
  status: 'published' | 'draft' | 'archived' | 'all';
  mine: boolean;
  page: number;
  page_size: number;
}

export interface ProblemDto {
  id: string;
  slug: string;
  status: ProblemStatusName;
  space: { name: string; slug: string };
  title: string;
  statement: string;
  /** Which of `statement` (Markdown) and `statement_pdf` the page shows; samples always come with it. */
  statement_mode: StatementModeName;
  statement_pdf: { url: string; pages: number; size_bytes: number } | null;
  version_number: number;
  time_limit_ms: number;
  memory_limit_kb: number;
  allowed_languages: Language[];
  samples: Array<{ position: number; input: string; output: string }>;
  accepts_submissions: boolean;
  created_by: PublicUser;
  published_at: string | null;
}

export interface ProblemEditorDto {
  id: string;
  slug: string;
  status: ProblemStatusName;
  space: { name: string; slug: string };
  version: ProblemVersionDto;
  editable: boolean;
  created_by: PublicUser;
  created_at: string;
  updated_at: string;
  tests: TestSummaryDto;
  solutions: { count: number; has_primary: boolean };
  publish_checks: PublishCheck[];
  can_publish: boolean;
  constraints: ProblemConstraintsDto;
}

export default class ProblemService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly problems: ProblemRepository,
    private readonly tests: TestCaseRepository,
    private readonly solutions: SolutionRepository,
    private readonly spaceService: SpaceService,
    private readonly testStorage: FileStorage,
    private readonly tracks: TrackRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  // --- shared lookups -----------------------------------------------------

  /**
   * The Space (404 when the caller may not see it) and the problem (404 when
   * missing). `inTrack` says whether the problem sits in a Collection of a
   * Track the caller can see; owners and editors do not need one (GRD-81).
   */
  async loadForReader(db: Db, user: User | null, slug: string, problemSlug: string) {
    const access = await this.spaceService.load(db, slug, user);
    assertCan(user, 'space.view', access);
    const problem = await this.problems.findBySlug(db, access.space.id, problemSlug.toLowerCase());
    if (!problem) throw new NotFoundError('Problem not found.');
    const inTrack =
      isAuthor(user, access) ||
      (await this.tracks.isProblemInVisibleTrack(db, access.space.id, problem.id, {
        userId: user?.id ?? null,
      }));
    return { access, problem, inTrack };
  }

  /**
   * The reading rule for one problem, answered with 404 so that a hidden
   * problem looks the same as a missing one: drafts are for owners and
   * editors, and anyone else needs the problem to be in a Track they can see.
   */
  assertReadable(
    user: User | null,
    access: SpaceAccess,
    problem: Pick<ProblemWithVersion, 'status'>,
    inTrack: boolean
  ): void {
    const allowed = can(
      actorOf(user),
      'problem.view',
      resourceOf(access, {
        problemStatus: problem.status === 'draft' ? 'draft' : 'published',
        problemInTrack: inTrack,
      })
    );
    if (!allowed) throw new NotFoundError('Problem not found.');
  }

  /** For authors: the permission is checked first, then the problem is looked up. */
  async loadForAuthor(
    db: Db,
    user: User | null,
    action: Parameters<typeof assertAuthor>[1],
    slug: string,
    problemSlug: string
  ) {
    const access = await this.spaceService.load(db, slug, user);
    const author = assertAuthor(user, action, access);
    const problem = await this.problems.findBySlug(db, access.space.id, problemSlug.toLowerCase());
    if (!problem) throw new NotFoundError('Problem not found.');
    return { access, problem, user: author };
  }

  /** Checks the right to author this problem without loading anything else (used before reading an upload). */
  async authorize(
    user: User | null,
    action: Parameters<typeof assertAuthor>[1],
    slug: string,
    problemSlug: string
  ) {
    await this.loadForAuthor(this.prisma, user, action, slug, problemSlug);
  }

  /** The version the editor works on: the draft, else the current one. */
  async editorVersion(db: Db, problem: ProblemWithVersion) {
    return (await this.problems.findDraftVersion(db, problem.id)) ?? currentVersionOf(problem);
  }

  async editorView(
    db: Db,
    problem: ProblemWithVersion,
    access: SpaceAccess
  ): Promise<ProblemEditorDto> {
    const version = await this.editorVersion(db, problem);
    const [testStats, solutionStats] = await Promise.all([
      this.tests.stats(db, version.id),
      this.solutions.stats(db, version.id),
    ]);
    const editable =
      version.status === 'draft' &&
      problem.status !== 'archived' &&
      access.space.archived_at === null;
    const checks = buildPublishChecks({
      statement: version.statement,
      statementMode: version.statement_mode,
      hasPdf: version.statement_pdf_sha256 !== null,
      languageCount: version.allowed_languages.length,
      testCount: testStats.count,
      sampleCount: testStats.sample_count,
      missingOutputCount: testStats.missing_output_count,
      hasPrimarySolution: solutionStats.has_primary,
    });
    return {
      id: problem.id,
      slug: problem.slug,
      status: problem.status,
      space: { name: access.space.name, slug: access.space.slug },
      version: toVersionDto(version),
      editable,
      created_by: toPublicUser(problem.created_by),
      created_at: problem.created_at.toISOString(),
      updated_at: problem.updated_at.toISOString(),
      tests: testStats,
      solutions: solutionStats,
      publish_checks: checks,
      can_publish: editable && checks.every((check) => check.ok),
      constraints: constraints(),
    };
  }

  // --- reading ------------------------------------------------------------

  /** Problems of a Space. Solvers see published ones only; owners and editors can look at the rest. */
  async list(
    user: User | null,
    slug: string,
    input: ProblemListInput
  ): Promise<Page<ProblemSummaryDto>> {
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, 'space.view', access);
    const author = isAuthor(user, access);
    const statuses: ProblemStatusName[] = author
      ? input.status === 'all'
        ? ['draft', 'published', 'archived']
        : [input.status]
      : ['published'];
    const { rows, total } = await this.problems.list(this.prisma, {
      spaceId: access.space.id,
      q: input.q,
      statuses,
      createdById: author && input.mine && user ? user.id : undefined,
      // Solvers, outsiders and visitors only see problems that are in a Track they can see.
      and: author
        ? undefined
        : this.tracks.problemInVisibleTrackWhere({ userId: user?.id ?? null }),
      skip: (input.page - 1) * input.page_size,
      take: input.page_size,
    });
    return {
      items: rows.map((row) => toProblemSummary(row)),
      page: input.page,
      page_size: input.page_size,
      total,
    };
  }

  /** What a solver sees: the statement, limits, languages and the sample tests, nothing else. */
  async get(user: User | null, slug: string, problemSlug: string): Promise<ProblemDto> {
    const { access, problem, inTrack } = await this.loadForReader(
      this.prisma,
      user,
      slug,
      problemSlug
    );
    // A draft is invisible to everyone but owners and editors, who see a preview of it; so is
    // a problem outside every Track the caller can see (GRD-81).
    this.assertReadable(user, access, problem, inTrack);
    const version = currentVersionOf(problem);
    const samples = await this.readSamples(version.id);
    return {
      id: problem.id,
      slug: problem.slug,
      status: problem.status,
      space: { name: access.space.name, slug: access.space.slug },
      title: version.title,
      statement: version.statement,
      statement_mode: version.statement_mode,
      statement_pdf:
        version.statement_mode === 'pdf' && version.statement_pdf_pages !== null
          ? {
              url: `/api/v1/spaces/${access.space.slug}/problems/${problem.slug}/statement/pdf`,
              pages: version.statement_pdf_pages,
              size_bytes: version.statement_pdf_size_bytes ?? 0,
            }
          : null,
      version_number: version.version_number,
      time_limit_ms: version.time_limit_ms,
      memory_limit_kb: version.memory_limit_kb,
      allowed_languages: version.allowed_languages,
      samples,
      accepts_submissions: problem.status === 'published' && access.space.archived_at === null,
      created_by: toPublicUser(problem.created_by),
      published_at: version.published_at?.toISOString() ?? null,
    };
  }

  /** Content of the sample tests only. Hidden tests are never read here. */
  private async readSamples(versionId: string) {
    const samples = await this.tests.listSamples(this.prisma, versionId);
    try {
      return await Promise.all(
        samples.map(async (test, index) => ({
          position: index + 1,
          input: (
            await readAll((await this.testStorage.get(testFileKey(test.input_sha256))).body)
          ).toString('utf8'),
          // A draft sample may still wait for its expected output; publishing needs it.
          output: test.output_sha256
            ? (
                await readAll((await this.testStorage.get(testFileKey(test.output_sha256))).body)
              ).toString('utf8')
            : '',
        }))
      );
    } catch (error) {
      if (error instanceof StorageUnavailableError) throw new ServiceUnavailableError();
      if (error instanceof StorageNotFoundError) {
        this.logger.setContext('service.problem.readSamples').error({
          message: 'A sample test file is missing from storage',
          data: { versionId },
          error,
        });
      }
      throw error;
    }
  }

  async editor(user: User, slug: string, problemSlug: string): Promise<ProblemEditorDto> {
    const { access, problem } = await this.loadForAuthor(
      this.prisma,
      user,
      'problem.view_private',
      slug,
      problemSlug
    );
    return this.editorView(this.prisma, problem, access);
  }

  // --- changing -----------------------------------------------------------

  async create(user: User, slug: string, input: CreateProblemInput, requestId: string) {
    const logger = this.logger.setContext('service.problem.create', requestId);
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertAuthor(user, 'problem.create', access);
    const problemSlug = input.slug.toLowerCase();
    if (!isValidProblemSlug(problemSlug)) {
      throw new ValidationError([
        {
          field: 'slug',
          message: RESERVED_PROBLEM_SLUGS.has(problemSlug)
            ? 'This slug is reserved. Pick another.'
            : `Use 2 to 64 lower-case letters, digits, "_" or "-", starting with a letter or digit (${PROBLEM_SLUG_PATTERN.source}).`,
        },
      ]);
    }
    try {
      const problem = await this.prisma.$transaction(async (tx) => {
        if (await this.problems.isSlugTaken(tx, access.space.id, problemSlug)) {
          throw new ConflictError('A problem with this slug already exists in this Space.');
        }
        const created = await this.problems.create(tx, {
          space_id: access.space.id,
          created_by_id: user.id,
          slug: problemSlug,
        });
        const version = await this.problems.createVersion(tx, {
          problem_id: created.id,
          version_number: 1,
          title: input.title,
          statement: input.statement,
          time_limit_ms: input.time_limit_ms,
          memory_limit_kb: input.memory_limit_kb,
          allowed_languages: input.allowed_languages as Language[],
        });
        await this.problems.update(tx, created.id, { current_version_id: version.id });
        return (await this.problems.findById(tx, created.id))!;
      });
      logger.info({
        message: 'problem created',
        data: { problemId: problem.id, spaceId: access.space.id },
      });
      return await this.editorView(this.prisma, problem, access);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('A problem with this slug already exists in this Space.');
      }
      throw error;
    }
  }

  async update(
    user: User,
    slug: string,
    problemSlug: string,
    input: UpdateProblemInput,
    requestId: string
  ) {
    const logger = this.logger.setContext('service.problem.update', requestId);
    const { access, problem: found } = await this.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    try {
      const problem = await this.prisma.$transaction(async (tx) => {
        await this.problems.lock(tx, found.id);
        const fresh = (await this.problems.findById(tx, found.id))!;
        const draft = await this.problems.findDraftVersion(tx, fresh.id);
        assertDraftEditable(fresh, draft);
        if (input.statement_mode === 'pdf' && draft!.statement_pdf_sha256 === null) {
          throw new ValidationError([
            { field: 'statement_mode', message: 'Upload a PDF before choosing the PDF mode.' },
          ]);
        }
        await this.problems.updateVersion(tx, draft!.id, {
          ...input,
          allowed_languages: input.allowed_languages as Language[] | undefined,
        });
        await this.problems.touch(tx, fresh.id);
        return (await this.problems.findById(tx, fresh.id))!;
      });
      logger.info({
        message: 'problem updated',
        data: { problemId: problem.id, fields: Object.keys(input) },
      });
      return await this.editorView(this.prisma, problem, access);
    } catch (error) {
      if (isCheckViolation(error)) throw versionPublishedError();
      throw error;
    }
  }

  async delete(user: User, slug: string, problemSlug: string, requestId: string): Promise<void> {
    const logger = this.logger.setContext('service.problem.delete', requestId);
    const { problem: found } = await this.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.problems.lock(tx, found.id);
        const fresh = (await this.problems.findById(tx, found.id))!;
        if (
          fresh.status !== 'draft' ||
          (await this.problems.countPublishedVersions(tx, fresh.id)) > 0
        ) {
          throw new ConflictError(
            'A problem that has been published cannot be deleted. Archive it instead.',
            'PROBLEM_PUBLISHED'
          );
        }
        await this.problems.delete(tx, fresh.id);
      });
    } catch (error) {
      if (isCheckViolation(error)) {
        throw new ConflictError(
          'A problem that has been published cannot be deleted. Archive it instead.',
          'PROBLEM_PUBLISHED'
        );
      }
      throw error;
    }
    logger.info({ message: 'problem deleted', data: { problemId: found.id } });
  }

  /**
   * Makes the draft the published, immutable version. Provisional: Milestone 4
   * puts the Judge verification run in front of this (GRD-50 to GRD-52).
   */
  async publish(user: User, slug: string, problemSlug: string, requestId: string) {
    const logger = this.logger.setContext('service.problem.publish', requestId);
    const { access, problem: found } = await this.loadForAuthor(
      this.prisma,
      user,
      'problem.publish',
      slug,
      problemSlug
    );
    const problem = await this.prisma.$transaction(async (tx) => {
      await this.problems.lock(tx, found.id);
      const fresh = (await this.problems.findById(tx, found.id))!;
      const draft = await this.problems.findDraftVersion(tx, fresh.id);
      assertDraftEditable(fresh, draft);
      const [testStats, solutionStats] = await Promise.all([
        this.tests.stats(tx, draft!.id),
        this.solutions.stats(tx, draft!.id),
      ]);
      const checks = buildPublishChecks({
        statement: draft!.statement,
        statementMode: draft!.statement_mode,
        hasPdf: draft!.statement_pdf_sha256 !== null,
        languageCount: draft!.allowed_languages.length,
        testCount: testStats.count,
        sampleCount: testStats.sample_count,
        missingOutputCount: testStats.missing_output_count,
        hasPrimarySolution: solutionStats.has_primary,
      });
      const failed = checks.filter((check) => !check.ok);
      if (failed.length > 0) {
        throw new ConflictError(
          'The problem is not ready to publish.',
          'PUBLISH_BLOCKED',
          failed.map((check) => ({ field: check.key, message: check.message }))
        );
      }
      await this.problems.markVersionPublished(tx, draft!.id, this.now());
      await this.problems.update(tx, fresh.id, {
        status: 'published',
        current_version_id: draft!.id,
      });
      return (await this.problems.findById(tx, fresh.id))!;
    });
    logger.info({
      message: 'problem published',
      data: { problemId: problem.id, versionId: problem.current_version_id },
    });
    return this.editorView(this.prisma, problem, access);
  }

  async archive(user: User, slug: string, problemSlug: string, requestId: string) {
    const logger = this.logger.setContext('service.problem.archive', requestId);
    const { access, problem: found } = await this.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    const problem = await this.prisma.$transaction(async (tx) => {
      await this.problems.lock(tx, found.id);
      const fresh = (await this.problems.findById(tx, found.id))!;
      if (fresh.status === 'archived') return fresh;
      if (fresh.status === 'draft') {
        throw new ConflictError(
          'A problem that was never published is deleted, not archived.',
          'PROBLEM_NOT_PUBLISHED'
        );
      }
      await this.problems.update(tx, fresh.id, { status: 'archived', archived_at: this.now() });
      return (await this.problems.findById(tx, fresh.id))!;
    });
    logger.info({ message: 'problem archived', data: { problemId: problem.id } });
    return this.editorView(this.prisma, problem, access);
  }
}
