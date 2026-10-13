import { randomUUID } from 'node:crypto';
import type { PrismaClient, User } from '../../../generated/prisma/client';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/errors';
import { can } from '@/permissions/can';
import TLogger, { Layer } from '@/logging/logger';
import ProblemRepository from '@/repositories/problem.repository';
import SpaceRepository from '@/repositories/space.repository';
import SubmissionRepository, { SubmissionRecord } from '@/repositories/submission.repository';
import TrackRepository from '@/repositories/track.repository';
import TestCaseRepository from '@/repositories/test-case.repository';
import { isWriter } from '@/permissions/can';
import { isAuthor } from '@/services/problem/problem.access';
import { currentVersionOf } from '@/services/problem/problem.mapper';
import ProblemService from '@/services/problem/problem.service';
import JudgeDispatcher from '@/services/submission/dispatcher';
import {
  SubmissionDto,
  SubmissionSummaryDto,
  toSubmissionDto,
  toSubmissionSummary,
} from '@/services/submission/submission.mapper';
import { Page } from '@/services/space/space.mapper';
import { Role, SpaceAccess, actorOf, assertCan, resourceOf } from '@/services/space/space.access';

export interface CreateSubmissionInput {
  language: string;
  source: string;
  /** The Track the solver is working in; must reach the problem. Left out: the first that does. */
  track?: string;
}

export interface SubmissionListInput {
  scope: 'mine' | 'all';
  page: number;
  page_size: number;
}

export interface SubmissionPageDto extends Page<SubmissionSummaryDto> {
  /** The caller's best submission of this problem; null for scope=all or when none passed a test. */
  best: SubmissionSummaryDto | null;
}

export default class SubmissionService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly submissions: SubmissionRepository,
    private readonly tests: TestCaseRepository,
    private readonly problems: ProblemRepository,
    private readonly spaces: SpaceRepository,
    private readonly problemService: ProblemService,
    private readonly dispatcher: JudgeDispatcher,
    private readonly tracks: TrackRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Accepts the code, records it as queued, and returns before Judge has looked at it. */
  async create(
    user: User,
    slug: string,
    problemSlug: string,
    input: CreateSubmissionInput,
    requestId: string
  ): Promise<SubmissionSummaryDto> {
    const logger = this.logger.setContext('service.submission.create', requestId);
    const { access, problem, inTrack } = await this.problemService.loadForReader(
      this.prisma,
      user,
      slug,
      problemSlug
    );
    // A problem outside every Track the caller can see does not exist for them (GRD-81): 404,
    // also for someone who solved it before it was taken out. Their history stays readable.
    if (!inTrack) throw new NotFoundError('Problem not found.');
    // 404 when the Space is hidden from the caller, 403 when it is archived.
    assertCan(user, 'submission.create', access, { problemInTrack: inTrack });

    if (problem.status === 'draft') {
      // Solvers must not learn that a draft exists.
      if (!isAuthor(user, access)) throw new NotFoundError('Problem not found.');
      throw new ConflictError(
        'This problem is a draft. Publish it before submitting solutions.',
        'PROBLEM_NOT_PUBLISHED'
      );
    }
    if (problem.status === 'archived') {
      throw new ConflictError(
        'This problem is archived and no longer accepts submissions.',
        'PROBLEM_NOT_OPEN'
      );
    }
    const version = currentVersionOf(problem);
    if (!version.allowed_languages.includes(input.language as never)) {
      throw new ValidationError([
        {
          field: 'language',
          message: `This problem accepts: ${version.allowed_languages.join(', ')}.`,
        },
      ]);
    }

    // The Track it was submitted from (GRD-93). Staff may try a problem that sits in no Track.
    const track = await this.tracks.trackForSubmission(
      this.prisma,
      access.space.id,
      problem.id,
      { userId: user.id },
      isAuthor(user, access),
      input.track?.toLowerCase()
    );
    if (track === undefined) {
      throw new ValidationError([
        { field: 'track', message: 'This Track does not reach this problem.' },
      ]);
    }

    const testStats = await this.tests.stats(this.prisma, version.id);
    const created = await this.submissions.create(this.prisma, {
      user_id: user.id,
      problem_id: problem.id,
      track_id: track?.id ?? null,
      problem_version_id: version.id,
      language: input.language as 'c' | 'cpp' | 'python',
      source: input.source,
      source_bytes: Buffer.byteLength(input.source, 'utf8'),
      tests_total: testStats.count,
      next_dispatch_at: this.now(),
    });
    logger.info({
      message: 'submission accepted',
      data: { submissionId: created.id, problemId: problem.id, versionId: version.id },
    });
    this.dispatcher.schedule(created.id, requestId);
    const numbers = await this.submissions.numbersOf(this.prisma, problem.id, [created]);
    return toSubmissionSummary(created, spaceRef(access), numbers.get(created.id) ?? 1);
  }

  async list(
    user: User,
    slug: string,
    problemSlug: string,
    input: SubmissionListInput
  ): Promise<SubmissionPageDto> {
    const { access, problem, inTrack } = await this.problemService.loadForReader(
      this.prisma,
      user,
      slug,
      problemSlug
    );
    const author = isAuthor(user, access);
    if (problem.status === 'draft' && !author) throw new NotFoundError('Problem not found.');
    // A problem taken out of the last Track stays listed for people who already submitted to it,
    // so their history survives; for everyone else it does not exist.
    if (!inTrack && !(await this.submissions.hasSubmitted(this.prisma, user.id, problem.id))) {
      throw new NotFoundError('Problem not found.');
    }
    if (input.scope === 'all' && !author) {
      throw new ForbiddenError("Only the Space's staff can see everyone's submissions.");
    }
    const { rows, total } = await this.submissions.list(this.prisma, {
      problemId: problem.id,
      userId: input.scope === 'mine' ? user.id : undefined,
      skip: (input.page - 1) * input.page_size,
      take: input.page_size,
    });
    const space = spaceRef(access);
    // "Best" is about the caller's own work, so it is only given with scope=mine.
    const best =
      input.scope === 'mine'
        ? await this.submissions.findBest(this.prisma, user.id, problem.id)
        : null;
    const numbers = await this.submissions.numbersOf(
      this.prisma,
      problem.id,
      best ? [...rows, best] : rows
    );
    const numberOf = (id: string) => numbers.get(id) ?? 0;
    return {
      items: rows.map((row) => toSubmissionSummary(row, space, numberOf(row.id))),
      best: best ? toSubmissionSummary(best, space, numberOf(best.id)) : null,
      page: input.page,
      page_size: input.page_size,
      total,
    };
  }

  /**
   * One submission. The author and the Space's staff can read it;
   * everyone else gets 404, so a submission's existence is not revealed.
   * `pollJudge` also asks Judge whether the job has started (for the live stream).
   */
  async get(
    user: User | null,
    id: string,
    options: { pollJudge?: boolean; includeSource?: boolean } = {}
  ) {
    if (!user) throw new UnauthorizedError('Please log in.');
    let submission = await this.submissions.findById(this.prisma, id);
    if (!submission) throw new NotFoundError('Submission not found.');
    const access = await this.accessTo(user, submission);
    this.assertViewable(user, access, submission);

    if (
      options.pollJudge &&
      submission.status === 'queued' &&
      submission.dispatched_at &&
      submission.judge_job_id
    ) {
      await this.dispatcher.observeRunning(submission.id, submission.judge_job_id);
      submission = (await this.submissions.findById(this.prisma, id)) ?? submission;
    }
    return this.present(user, submission, access, options.includeSource ?? true);
  }

  /** After an ISE: judge it again with a new job. */
  async rejudge(user: User, id: string, requestId: string): Promise<SubmissionDto> {
    const logger = this.logger.setContext('service.submission.rejudge', requestId);
    const found = await this.submissions.findById(this.prisma, id);
    if (!found) throw new NotFoundError('Submission not found.');
    const access = await this.accessTo(user, found);
    this.assertViewable(user, access, found);
    if (!(await this.mayRejudge(user, access, found))) {
      throw new ForbiddenError('You cannot ask for this submission to be checked again.');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.submissions.lock(tx, id);
      const current = await this.submissions.findById(tx, id);
      if (!current || current.status !== 'completed' || current.verdict !== 'ISE') {
        throw new ConflictError(
          'Only a submission that ended with a system error can be checked again.',
          'NOT_REJUDGEABLE'
        );
      }
      await this.submissions.deleteResults(tx, id);
      await this.submissions.reset(tx, id, randomUUID(), this.now());
    });
    logger.info({ message: 'submission queued again', data: { submissionId: id } });
    this.dispatcher.schedule(id, requestId);
    const fresh = (await this.submissions.findById(this.prisma, id))!;
    return this.present(user, fresh, access, true);
  }

  // --- helpers ------------------------------------------------------------

  private async accessTo(user: User, submission: SubmissionRecord): Promise<SpaceAccess> {
    const space = await this.spaces.findById(this.prisma, submission.problem.space_id);
    if (!space) throw new NotFoundError('Submission not found.');
    const membership = await this.spaces.findMembership(this.prisma, space.id, user.id);
    return { space, role: (membership?.role as Role | undefined) ?? null };
  }

  private assertViewable(user: User, access: SpaceAccess, submission: SubmissionRecord) {
    const allowed = can(actorOf(user), 'submission.view', {
      ...resourceOf(access),
      submissionAuthorId: submission.user_id,
    });
    if (!allowed) throw new NotFoundError('Submission not found.');
  }

  /** Checking again needs the right to submit here, and being the author or someone who can edit problems. */
  private async mayRejudge(
    user: User,
    access: SpaceAccess,
    submission: SubmissionRecord
  ): Promise<boolean> {
    if (submission.status !== 'completed' || submission.verdict !== 'ISE') return false;
    const inTrack =
      isAuthor(user, access) ||
      (await this.tracks.isProblemInVisibleTrack(
        this.prisma,
        access.space.id,
        submission.problem_id,
        { userId: user.id }
      ));
    if (!can(actorOf(user), 'submission.create', resourceOf(access, { problemInTrack: inTrack }))) {
      return false;
    }
    // An observer reads everything but changes nothing, so cannot trigger a re-judge.
    return submission.user_id === user.id || isWriter(access.role);
  }

  private async present(
    user: User,
    submission: SubmissionRecord,
    access: SpaceAccess,
    includeSource: boolean
  ) {
    const numbers = await this.submissions.numbersOf(this.prisma, submission.problem_id, [
      submission,
    ]);
    return toSubmissionDto(submission, spaceRef(access), {
      number: numbers.get(submission.id) ?? 0,
      includeSource,
      canRejudge: await this.mayRejudge(user, access, submission),
    });
  }
}

function spaceRef(access: SpaceAccess) {
  return { name: access.space.name, slug: access.space.slug };
}
