import { randomUUID } from 'node:crypto';
import type { PrismaClient, User } from '../../../generated/prisma/client';
import { ConflictError, VError } from '@/errors';
import { JudgeClient, JudgeRejectedError, JudgeUnavailableError } from '@/libs/judge';
import TLogger, { Layer } from '@/logging/logger';
import { Db, Prisma } from '@/repositories/db';
import ProblemRepository from '@/repositories/problem.repository';
import SolutionRepository from '@/repositories/solution.repository';
import TestCaseRepository from '@/repositories/test-case.repository';
import VerificationRepository, {
  RunFinish,
  VerificationRunRecord,
} from '@/repositories/verification.repository';
import { buildJudgeJob } from '@/services/judge/job-builder';
import { assertDraftEditable } from '@/services/problem/problem.access';
import ProblemService from '@/services/problem/problem.service';
import { assertTransition } from '@/services/problem/transitions';
import {
  VerificationRunDto,
  VerificationTestResultDto,
  toVerificationRun,
} from '@/services/problem/verification.mapper';
import type { BackgroundWork } from '@/services/submission/dispatcher';

/** A run the Judge never answers is closed after at least this long (decision GRD-51). */
export const VERIFY_MIN_TIMEOUT_MS = 5 * 60 * 1000;
export const VERIFY_MAX_TIMEOUT_MS = 30 * 60 * 1000;
export const NO_ANSWER_REASON = 'Judge did not answer in time';
const MAX_BACKOFF_MS = 60_000;

/** The parts of a Judge JobResult the verification reads. */
export interface VerifyResultInput {
  job_id: string;
  verdict: string;
  compile?: { ok: boolean; message: string };
  tests: Array<{ id: string; verdict: string; time_ms: number; memory_kb: number }>;
  error?: { code: string; message: string };
}

type TestVerdict = VerificationTestResultDto['verdict'];

/**
 * The publish gate's verification (GRD-51): the primary reference solution against
 * every test, hidden ones included, as one Judge job of kind `verify`, built by the
 * same code and limits as a real submission. The run is bound to the content hash it
 * started with. A run Judge never answers is closed as an error after its deadline,
 * so the version never stays `verifying`.
 */
export default class VerificationService implements BackgroundWork {
  private readonly logger = new TLogger(Layer.SERVICE);
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly runs: VerificationRepository,
    private readonly problems: ProblemRepository,
    private readonly tests: TestCaseRepository,
    private readonly solutions: SolutionRepository,
    private readonly problemService: ProblemService,
    private readonly judge: JudgeClient,
    private readonly options: { callbackUrl: string; timeoutMs?: number; now?: () => Date }
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  // --- for the author -----------------------------------------------------

  async start(
    user: User,
    slug: string,
    problemSlug: string,
    requestId: string
  ): Promise<VerificationRunDto> {
    const logger = this.logger.setContext('service.verification.start', requestId);
    const { problem: found } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    const { run, hash } = await this.prisma.$transaction(async (tx) => {
      await this.problems.lock(tx, found.id);
      const fresh = (await this.problems.findById(tx, found.id))!;
      const draft = await this.problems.findDraftVersion(tx, fresh.id);
      if (fresh.status === 'archived') assertDraftEditable(fresh, draft);
      if (!draft) {
        throw new ConflictError(
          'There is no draft to verify. Start a Major update first.',
          'NO_DRAFT'
        );
      }
      if (draft.status === 'verifying' || (await this.runs.findOpen(tx, draft.id))) {
        throw new ConflictError('A verification is already running.', 'VERIFY_IN_PROGRESS');
      }
      if (draft.status === 'verified') {
        throw new ConflictError(
          'This version is already verified. Publish it, or change its tests, solutions, limits or languages to verify again.',
          'VERIFY_BLOCKED',
          [{ field: 'verified', message: 'The version is already verified.' }]
        );
      }
      // Everything cheap must be in place first; the verification itself is the last check.
      const { checks, hash } = await this.problemService.checksFor(tx, draft);
      const failed = checks.filter((check) => check.key !== 'verified' && !check.ok);
      if (failed.length > 0) {
        throw new ConflictError(
          `The problem cannot be verified yet: ${failed.map((check) => check.key).join(', ')}.`,
          'VERIFY_BLOCKED',
          failed.map((check) => ({ field: check.key, message: check.message }))
        );
      }
      assertTransition('draft', 'verifying');
      const tests = await this.tests.listByVersion(tx, draft.id);
      const now = this.now();
      const run = await this.runs.create(tx, {
        problem_version_id: draft.id,
        requested_by_id: user.id,
        content_hash: hash,
        tests_total: tests.length,
        deadline_at: new Date(now.getTime() + this.timeoutFor(draft.time_limit_ms, tests.length)),
        next_dispatch_at: now,
      });
      await this.problems.setVersionStatus(tx, draft.id, 'verifying');
      await this.problemService.recordState(tx, {
        problemId: fresh.id,
        version: draft,
        from: 'draft',
        to: 'verifying',
        actorId: user.id,
      });
      return { run, hash };
    });
    logger.info({
      message: 'verification requested',
      data: { problemId: found.id, runId: run.id, tests: run.tests_total },
    });
    this.schedule(run.id, requestId);
    return toVerificationRun(run, hash);
  }

  /** The newest run of the version being worked on; 404 NO_VERIFICATION when none was started. */
  async latest(user: User, slug: string, problemSlug: string): Promise<VerificationRunDto> {
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.view_private',
      slug,
      problemSlug
    );
    const draft = await this.problems.findDraftVersion(this.prisma, problem.id);
    const run = draft ? await this.runs.latestFor(this.prisma, draft.id) : null;
    if (!draft || !run) {
      throw new VError({
        message: 'No verification has been started for this version.',
        status: 404,
        error_code: 'NO_VERIFICATION',
      });
    }
    return toVerificationRun(run, await this.problemService.contentHashOf(this.prisma, draft));
  }

  // --- handing the job to Judge -------------------------------------------

  private timeoutFor(timeLimitMs: number, tests: number): number {
    if (this.options.timeoutMs !== undefined) return this.options.timeoutMs;
    const estimate = 2 * 60 * 1000 + tests * timeLimitMs * 1.5;
    return Math.min(VERIFY_MAX_TIMEOUT_MS, Math.max(VERIFY_MIN_TIMEOUT_MS, estimate));
  }

  private schedule(runId: string, requestId?: string): void {
    const work = this.dispatch(runId, requestId)
      .catch((error: unknown) => {
        this.logger.error({
          message: 'verification dispatch failed unexpectedly',
          data: { runId },
          error: error as Error,
        });
      })
      .finally(() => this.inflight.delete(work));
    this.inflight.add(work);
  }

  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** Sends the job to Judge; Judge being down means a retry with backoff until the deadline. */
  async dispatch(runId: string, requestId?: string): Promise<void> {
    const logger = this.logger.setContext('service.verification.dispatch', requestId);
    const run = await this.runs.find(this.prisma, runId);
    if (!run || run.status !== 'queued') return;
    const [version, tests, solutions] = await Promise.all([
      this.problems.findVersion(this.prisma, run.problem_version_id),
      this.tests.listByVersion(this.prisma, run.problem_version_id),
      this.solutions.list(this.prisma, run.problem_version_id),
    ]);
    const primary = solutions.find((solution) => solution.is_primary);
    if (!version || !primary || tests.length === 0 || tests.some((test) => !test.output_sha256)) {
      await this.close(runId, {
        status: 'error',
        verdict: null,
        reason: 'The verification job could not be built from the current tests and solutions.',
        results: [],
        tests_passed: null,
        max_time_ms: null,
        max_memory_kb: null,
      });
      return;
    }

    // Stored before the request goes out: Judge may call back before we hear its answer.
    const updated = await this.runs.assignJobId(this.prisma, runId, randomUUID());
    const request = buildJudgeJob({
      jobId: updated.judge_job_id!,
      kind: 'verify',
      language: primary.language,
      source: primary.source,
      version,
      tests,
      callbackUrl: this.options.callbackUrl,
    });
    try {
      await this.judge.createJob(request);
      await this.runs.markDispatched(this.prisma, runId);
      logger.info({ message: 'verify job accepted by Judge', data: { runId } });
    } catch (error) {
      if (error instanceof JudgeRejectedError) {
        logger.error({ message: 'Judge rejected the verify job', data: { runId }, error });
        await this.close(runId, this.failure('error', 'Judge rejected the verification job.'));
        return;
      }
      if (!(error instanceof JudgeUnavailableError)) throw error;
      const delay = Math.min(1000 * 2 ** run.attempts, MAX_BACKOFF_MS);
      await this.runs.scheduleRetry(this.prisma, runId, new Date(this.now().getTime() + delay));
      logger.warn({
        message: 'Judge is unavailable, will try the verification again',
        data: { runId, retryInMs: delay },
        error,
      });
    }
  }

  /** One pass of the background loop: hand over what is due, close what is past its deadline. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const row of await this.runs.dueForDispatch(this.prisma, now, 20)) {
      await this.dispatch(row.id);
    }
    for (const row of await this.runs.overdue(this.prisma, now, 20)) {
      await this.close(row.id, this.failure('error', NO_ANSWER_REASON));
      this.logger
        .setContext('service.verification.tick')
        .warn({ message: 'verification closed at its deadline', data: { runId: row.id } });
    }
  }

  // --- the result ---------------------------------------------------------

  /** Applies Judge's result once; returns null for a job this service does not know. */
  async receive(
    result: VerifyResultInput,
    requestId?: string
  ): Promise<'stored' | 'duplicate' | null> {
    const logger = this.logger.setContext('service.verification.receive', requestId);
    const known = await this.runs.findByJobId(this.prisma, result.job_id);
    if (!known) return null;
    const outcome = await this.close(known.id, await this.outcomeOf(known, result), {
      jobId: result.job_id,
    });
    logger.info({
      message: outcome ? 'verification result stored' : 'duplicate verification result ignored',
      data: { runId: known.id, verdict: result.verdict },
    });
    return outcome ? 'stored' : 'duplicate';
  }

  private failure(status: 'failed' | 'error', reason: string): RunFinish {
    return {
      status,
      verdict: null,
      reason,
      results: [],
      tests_passed: null,
      max_time_ms: null,
      max_memory_kb: null,
    };
  }

  /** What a Judge result means for the run: all AC passes, anything else says which test. */
  private async outcomeOf(
    run: VerificationRunRecord,
    result: VerifyResultInput
  ): Promise<RunFinish> {
    const verdict = result.verdict as RunFinish['verdict'];
    if (result.verdict === 'CE') {
      const detail = result.compile?.message.split('\n').find((line) => line.trim() !== '');
      return {
        ...this.failure(
          'failed',
          `The reference solution does not compile${detail ? `: ${detail.trim().slice(0, 300)}` : '.'}`
        ),
        verdict,
      };
    }
    if (result.verdict === 'ISE') {
      return {
        ...this.failure(
          'error',
          `Judge had a system error${result.error?.code ? ` (${result.error.code})` : ''}. Try again.`
        ),
        verdict,
      };
    }
    const cases = await this.tests.listByVersion(this.prisma, run.problem_version_id);
    const byId = new Map(cases.map((test) => [test.id, test]));
    const reported = new Map<string, VerifyResultInput['tests'][number]>();
    for (const test of result.tests) {
      if (!byId.has(test.id) || reported.has(test.id)) {
        return {
          ...this.failure('error', 'Judge reported a test that is not part of this version.'),
          verdict,
        };
      }
      reported.set(test.id, test);
    }
    const results: VerificationTestResultDto[] = cases.map((test) => {
      const got = reported.get(test.id);
      return {
        position: test.position,
        verdict: (got?.verdict ?? 'SKIPPED') as TestVerdict,
        time_ms: got ? got.time_ms : null,
        memory_kb: got ? got.memory_kb : null,
        is_sample: test.is_sample,
      };
    });
    const ran = results.filter((entry) => entry.time_ms !== null);
    const first = results.find((entry) => entry.verdict !== 'AC');
    const passed = result.verdict === 'AC' && first === undefined;
    return {
      status: passed ? 'passed' : 'failed',
      verdict,
      reason: passed
        ? null
        : first
          ? `Test ${first.position} is ${first.verdict}`
          : `Judge answered ${result.verdict}`,
      results: results as unknown as Prisma.InputJsonValue,
      tests_passed: results.filter((entry) => entry.verdict === 'AC').length,
      max_time_ms: ran.length ? Math.max(...ran.map((entry) => entry.time_ms ?? 0)) : null,
      max_memory_kb: ran.length ? Math.max(...ran.map((entry) => entry.memory_kb ?? 0)) : null,
    };
  }

  /**
   * Closes a run and moves its version: `verified` when it passed and the content is still
   * the one it started with, otherwise back to `draft` (the reason stays on the run). Does
   * nothing for a run that is already closed, so a duplicate or late answer changes nothing.
   * Returns whether it closed the run.
   */
  private async close(
    runId: string,
    finish: RunFinish,
    options: { jobId?: string } = {}
  ): Promise<boolean> {
    const peek = await this.runs.find(this.prisma, runId);
    if (!peek) return false;
    const version = await this.problems.findVersion(this.prisma, peek.problem_version_id);
    if (!version) return false;
    return this.prisma.$transaction(async (tx: Db) => {
      await this.problems.lock(tx, version.problem_id);
      await this.runs.lock(tx, runId);
      const run = await this.runs.find(tx, runId);
      if (!run || (run.status !== 'queued' && run.status !== 'running')) return false;
      // A re-dispatch may have replaced the job while we waited for the lock.
      if (options.jobId && run.judge_job_id !== options.jobId) return false;
      await this.runs.finish(tx, runId, finish, this.now());
      const current = await this.problems.findVersion(tx, version.id);
      if (current && current.status === 'verifying') {
        const stillValid =
          finish.status === 'passed' &&
          run.content_hash === (await this.problemService.contentHashOf(tx, current));
        const to = stillValid ? 'verified' : 'draft';
        assertTransition('verifying', to);
        await this.problems.setVersionStatus(tx, current.id, to);
        await this.problemService.recordState(tx, {
          problemId: current.problem_id,
          version: current,
          from: 'verifying',
          to,
          actorId: run.requested_by_id,
        });
      }
      return true;
    });
  }
}
