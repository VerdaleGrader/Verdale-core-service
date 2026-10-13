import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../../generated/prisma/client';
import { DISPATCH_GIVE_UP_MS } from '@/constants/limits';
import { JobRequest, JudgeClient, JudgeRejectedError, JudgeUnavailableError } from '@/libs/judge';
import TLogger, { Layer } from '@/logging/logger';
import ProblemRepository from '@/repositories/problem.repository';
import SubmissionRepository from '@/repositories/submission.repository';
import TestCaseRepository from '@/repositories/test-case.repository';
import { buildJudgeJob } from '@/services/judge/job-builder';

export interface DispatcherOptions {
  /** Where Judge POSTs the result (Core's /internal/judge/result). */
  callbackUrl: string;
  now?: () => Date;
  /** After this long without Judge accepting the job, the submission becomes an ISE. */
  giveUpMs?: number;
  /** How often the background loop looks for submissions that are due. */
  intervalMs?: number;
}

const MAX_BACKOFF_MS = 60_000;

/** Work other services want done on each tick of the background loop. */
export interface BackgroundWork {
  tick(): Promise<void>;
  /** Resolves when the work started so far has finished. */
  idle(): Promise<void>;
}

/**
 * Hands queued submissions to Judge (GRD-44). The submission row exists before
 * the first try, so nothing is lost when Judge is down: the row stays `queued`
 * and the background loop tries again with exponential backoff until Judge
 * accepts it, or until `giveUpMs` has passed and the submission is closed as
 * an ISE with `JUDGE_UNAVAILABLE` (a system error, never the submitter's fault,
 * and it can be checked again).
 */
export default class JudgeDispatcher {
  private readonly logger = new TLogger(Layer.SERVICE, 'service.dispatcher');
  private readonly inflight = new Set<Promise<unknown>>();
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => Date;
  private readonly giveUpMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly submissions: SubmissionRepository,
    private readonly tests: TestCaseRepository,
    private readonly problems: ProblemRepository,
    private readonly judge: JudgeClient,
    private readonly options: DispatcherOptions
  ) {
    this.now = options.now ?? (() => new Date());
    this.giveUpMs = options.giveUpMs ?? DISPATCH_GIVE_UP_MS;
  }

  private verifier: BackgroundWork | undefined;

  /** Verification runs ride the same loop: hand-overs with backoff, and the deadline sweep. */
  attachVerifier(verifier: BackgroundWork): void {
    this.verifier = verifier;
  }

  /** Starts a dispatch in the background; the caller does not wait for Judge. */
  schedule(submissionId: string, requestId?: string): void {
    const run = this.dispatch(submissionId, requestId)
      .catch((error: unknown) => {
        this.logger.error({
          message: 'dispatch failed unexpectedly',
          data: { submissionId },
          error: error as Error,
        });
      })
      .finally(() => this.inflight.delete(run));
    this.inflight.add(run);
  }

  /** Resolves when every dispatch started so far has finished (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
    await this.verifier?.idle();
  }

  async dispatch(submissionId: string, requestId?: string): Promise<void> {
    const logger = this.logger.setContext('service.dispatcher.dispatch', requestId);
    const submission = await this.submissions.findById(this.prisma, submissionId);
    if (!submission || submission.status !== 'queued' || submission.dispatched_at) return;

    const [version, tests] = await Promise.all([
      this.problems.findVersion(this.prisma, submission.problem_version_id),
      this.tests.listByVersion(this.prisma, submission.problem_version_id),
    ]);
    // A published version has an output for every test (the database insists); never send half a job.
    if (!version || tests.length === 0 || tests.some((test) => !test.output_sha256)) {
      await this.giveUp(submissionId, 'JOB_INVALID');
      logger.error({ message: 'submission has no version or no tests', data: { submissionId } });
      return;
    }

    // Stored before the request goes out: Judge may call back before we hear its answer.
    const jobId = await this.submissions.assignJobId(this.prisma, submissionId, randomUUID());
    const request: JobRequest = buildJudgeJob({
      jobId,
      kind: 'submission',
      language: submission.language,
      source: submission.source,
      version,
      tests,
      callbackUrl: this.options.callbackUrl,
    });

    try {
      await this.judge.createJob(request);
      await this.submissions.markDispatched(this.prisma, submissionId, this.now());
      logger.info({ message: 'job accepted by Judge', data: { submissionId, jobId } });
    } catch (error) {
      if (error instanceof JudgeRejectedError) {
        logger.error({
          message: 'Judge rejected the job for good',
          data: { submissionId, jobId, status: error.status },
          error,
        });
        await this.giveUp(submissionId, 'JUDGE_REJECTED');
        return;
      }
      if (!(error instanceof JudgeUnavailableError)) throw error;
      const waitedMs = this.now().getTime() - submission.created_at.getTime();
      if (waitedMs >= this.giveUpMs) {
        logger.error({
          message: 'Judge stayed unavailable, closing the submission as a system error',
          data: { submissionId },
          error,
        });
        await this.giveUp(submissionId, 'JUDGE_UNAVAILABLE');
        return;
      }
      const delay = Math.min(1000 * 2 ** submission.dispatch_attempts, MAX_BACKOFF_MS);
      await this.submissions.scheduleRetry(
        this.prisma,
        submissionId,
        new Date(this.now().getTime() + delay)
      );
      logger.warn({
        message: 'Judge is unavailable, will try again',
        data: { submissionId, retryInMs: delay },
        error,
      });
    }
  }

  /** Closes a submission that can never be judged as ISE, unless a result arrived meanwhile. */
  private async giveUp(submissionId: string, errorCode: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.submissions.lock(tx, submissionId);
      const current = await this.submissions.findById(tx, submissionId);
      if (!current || current.status === 'completed') return;
      await this.submissions.complete(tx, submissionId, {
        verdict: 'ISE',
        time_ms: null,
        memory_kb: null,
        tests_passed: null,
        tests_total: current.tests_total,
        compile_message: null,
        error_code: errorCode,
        judge_version: null,
        judged_at: this.now(),
      });
    });
  }

  /** One pass of the background loop: dispatch everything that is due. */
  async dispatchDue(limit = 20): Promise<number> {
    const due = await this.submissions.dueForDispatch(this.prisma, this.now(), limit);
    await Promise.all(due.map((row) => this.dispatch(row.id)));
    // Verification runs: hand-overs that failed while Judge was down, runs past their deadline.
    await this.verifier?.tick();
    return due.length;
  }

  /** Asks Judge whether a dispatched job has started, so the web app can show "Running". */
  async observeRunning(submissionId: string, jobId: string): Promise<void> {
    try {
      const state = await this.judge.getJob(jobId);
      if (state?.status === 'running')
        await this.submissions.markRunning(this.prisma, submissionId);
    } catch {
      // Not knowing is fine: the submission simply stays "queued" until the result arrives.
    }
  }

  start(intervalMs = this.options.intervalMs ?? 5000): void {
    if (this.timer) return;
    const tick = async () => {
      try {
        await this.dispatchDue();
      } catch (error) {
        this.logger.error({ message: 'dispatch loop failed', error: error as Error });
      }
    };
    // Ticks are tracked like other dispatches, so stop() waits for one that is running.
    // A tick that is still running is not overlapped: two would pick the same due rows.
    let ticking = false;
    this.timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      const run = tick().finally(() => {
        ticking = false;
        this.inflight.delete(run);
      });
      this.inflight.add(run);
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.idle();
  }
}
