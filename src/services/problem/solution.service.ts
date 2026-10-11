import type { PrismaClient, User } from '../../../generated/prisma/client';
import { SOLUTIONS_MAX_COUNT } from '@/constants/limits';
import { ConflictError, NotFoundError } from '@/errors';
import TLogger, { Layer } from '@/logging/logger';
import { Db, isCheckViolation } from '@/repositories/db';
import ProblemRepository from '@/repositories/problem.repository';
import SolutionRepository from '@/repositories/solution.repository';
import { assertDraftEditable, versionPublishedError } from '@/services/problem/problem.access';
import ProblemService from '@/services/problem/problem.service';
import { Language } from '@/services/problem/problem.mapper';
import { PublicUser, toPublicUser } from '@/services/user/user.mapper';

export interface ReferenceSolutionDto {
  id: string;
  language: Language;
  source: string;
  source_bytes: number;
  is_primary: boolean;
  created_by: PublicUser;
  created_at: string;
  updated_at: string;
}

type SolutionRow = NonNullable<Awaited<ReturnType<SolutionRepository['find']>>>;

function toDto(solution: SolutionRow): ReferenceSolutionDto {
  return {
    id: solution.id,
    language: solution.language,
    source: solution.source,
    source_bytes: solution.source_bytes,
    is_primary: solution.is_primary,
    created_by: toPublicUser(solution.created_by),
    created_at: solution.created_at.toISOString(),
    updated_at: solution.updated_at.toISOString(),
  };
}

/**
 * Reference solutions (GRD-26). They are the author's answer key: every method
 * here goes through `problem.view_private` or `problem.update`, so owners and
 * editors are the only people who can ever read one, and no solver-facing
 * endpoint touches this service.
 */
export default class SolutionService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly problems: ProblemRepository,
    private readonly solutions: SolutionRepository,
    private readonly problemService: ProblemService
  ) {}

  async list(user: User, slug: string, problemSlug: string): Promise<ReferenceSolutionDto[]> {
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.view_private',
      slug,
      problemSlug
    );
    const version = await this.problemService.editorVersion(this.prisma, problem);
    return (await this.solutions.list(this.prisma, version.id)).map(toDto);
  }

  async create(
    user: User,
    slug: string,
    problemSlug: string,
    input: { language: string; source: string; is_primary?: boolean },
    requestId: string
  ): Promise<ReferenceSolutionDto> {
    const logger = this.logger.setContext('service.solution.create', requestId);
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const version = await this.lockDraft(tx, problem.id);
        const stats = await this.solutions.stats(tx, version.id);
        if (stats.count >= SOLUTIONS_MAX_COUNT) {
          throw new ConflictError(
            `A problem can have at most ${SOLUTIONS_MAX_COUNT} reference solutions.`,
            'SOLUTION_LIMIT_REACHED'
          );
        }
        // The first solution is the primary one unless the author says otherwise.
        const primary = input.is_primary ?? stats.count === 0;
        if (primary) await this.solutions.clearPrimary(tx, version.id);
        const row = await this.solutions.create(tx, {
          problem_version_id: version.id,
          created_by_id: user.id,
          language: input.language as Language,
          source: input.source,
          source_bytes: Buffer.byteLength(input.source, 'utf8'),
          is_primary: primary,
        });
        await this.problems.touch(tx, problem.id);
        return row;
      });
      logger.info({
        message: 'reference solution added',
        data: { problemId: problem.id, solutionId: created.id, language: created.language },
      });
      return toDto(created);
    } catch (error) {
      if (isCheckViolation(error)) throw versionPublishedError();
      throw error;
    }
  }

  async update(
    user: User,
    slug: string,
    problemSlug: string,
    solutionId: string,
    input: { language?: string; source?: string; is_primary?: boolean },
    requestId: string
  ): Promise<ReferenceSolutionDto> {
    const logger = this.logger.setContext('service.solution.update', requestId);
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const version = await this.lockDraft(tx, problem.id);
        const existing = await this.solutions.find(tx, version.id, solutionId);
        if (!existing) throw new NotFoundError('Reference solution not found.');
        if (input.is_primary === true && !existing.is_primary) {
          await this.solutions.clearPrimary(tx, version.id);
        }
        const row = await this.solutions.update(tx, solutionId, {
          ...(input.language ? { language: input.language as Language } : {}),
          ...(input.source !== undefined
            ? { source: input.source, source_bytes: Buffer.byteLength(input.source, 'utf8') }
            : {}),
          ...(input.is_primary !== undefined ? { is_primary: input.is_primary } : {}),
        });
        await this.problems.touch(tx, problem.id);
        return row;
      });
      logger.info({ message: 'reference solution updated', data: { solutionId } });
      return toDto(updated);
    } catch (error) {
      if (isCheckViolation(error)) throw versionPublishedError();
      throw error;
    }
  }

  async remove(
    user: User,
    slug: string,
    problemSlug: string,
    solutionId: string,
    requestId: string
  ): Promise<void> {
    const logger = this.logger.setContext('service.solution.remove', requestId);
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    try {
      await this.prisma.$transaction(async (tx) => {
        const version = await this.lockDraft(tx, problem.id);
        const existing = await this.solutions.find(tx, version.id, solutionId);
        if (!existing) throw new NotFoundError('Reference solution not found.');
        await this.solutions.delete(tx, solutionId);
        await this.problems.touch(tx, problem.id);
      });
    } catch (error) {
      if (isCheckViolation(error)) throw versionPublishedError();
      throw error;
    }
    logger.info({ message: 'reference solution removed', data: { solutionId } });
  }

  /** Locks the problem and returns its draft; a published version cannot be touched. */
  private async lockDraft(tx: Db, problemId: string) {
    await this.problems.lock(tx, problemId);
    const fresh = (await this.problems.findById(tx, problemId))!;
    const draft = await this.problems.findDraftVersion(tx, problemId);
    assertDraftEditable(fresh, draft);
    return draft!;
  }
}
