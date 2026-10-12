import { randomUUID } from 'node:crypto';
import type { PrismaClient, User } from '../../../generated/prisma/client';
import { OUTPUT_LIMIT_KB, TEST_LIMITS } from '@/constants/limits';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '@/errors';
import { JudgeClient, JudgeRejectedError, JudgeUnavailableError, JobRequest } from '@/libs/judge';
import {
  FileStorage,
  StorageNotFoundError,
  StorageUnavailableError,
  testFileKey,
} from '@/libs/storage/file-storage';
import { TestFileError, normalizeTestFile } from '@/libs/test-file';
import TLogger, { Layer } from '@/logging/logger';
import GenerateRepository, { GenerateJobRecord } from '@/repositories/generate.repository';
import ProblemRepository from '@/repositories/problem.repository';
import SolutionRepository from '@/repositories/solution.repository';
import TestCaseRepository from '@/repositories/test-case.repository';
import { assertDraftEditable } from '@/services/problem/problem.access';
import ProblemService from '@/services/problem/problem.service';
import { readAll } from '@/libs/storage/file-storage';

/** At most this many testcases run on Judge at the same time for one job. */
const MAX_PARALLEL = 3;
/** The whole job gives up after this long (decision GRD-108, 2026-10-12). */
export const GENERATE_TIMEOUT_MS = 10 * 60 * 1000;
/** Finished jobs are kept this long, so closing the page does not lose the results. */
export const GENERATE_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_DISPATCH_ATTEMPTS = 4;
const STDERR_KEPT = 1000;

export type RunStatusName = 'queued' | 'running' | 'done' | 'failed';

export interface GenerateRunDto {
  test_id: string;
  position: number;
  status: RunStatusName;
  /** Why a run failed: TLE, MLE, RE, OLE or ISE. */
  verdict: string | null;
  error_code: string | null;
  time_ms: number | null;
  memory_kb: number | null;
  stderr: string | null;
  /** The generated expected output, ready to be put in a batch save. */
  output: { sha256: string; size_bytes: number } | null;
  /** Same as the current expected output when compared the way Judge compares. */
  same_as_current: boolean | null;
}

export interface GenerateJobDto {
  id: string;
  status: 'running' | 'completed' | 'stopped' | 'timed_out' | 'failed';
  /** Set when the job failed as a whole, e.g. the solution does not compile. */
  error: { code: string; message: string } | null;
  created_at: string;
  deadline_at: string;
  finished_at: string | null;
  progress: { total: number; done: number; failed: number };
  runs: GenerateRunDto[];
}

export interface StartGenerateInput {
  solution_id: string;
  /** Testcases to run; the others keep what they have. All of them when left out. */
  test_ids?: string[];
}

/** The parts of a Judge JobResult the generator reads. */
export interface GenerateResultInput {
  job_id: string;
  verdict: string;
  compile?: { ok: boolean; message: string };
  tests: Array<{
    verdict: string;
    time_ms: number;
    memory_kb: number;
    stdout?: string;
    stderr?: string;
  }>;
  error?: { code: string; message: string };
}

/** The checker Judge uses: trailing whitespace on a line and trailing blank lines do not count. */
export function sameOutput(left: string, right: string): boolean {
  const lines = (text: string) => {
    const result = text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''));
    while (result.length > 0 && result[result.length - 1] === '') result.pop();
    return result;
  };
  const a = lines(left);
  const b = lines(right);
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

const firstLine = (text: string, limit: number) =>
  (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, limit);

/**
 * Creates the expected outputs of testcases by running a saved solution on their
 * inputs (GRD-108). One Judge job per testcase, so progress is visible per
 * testcase, "stop" keeps what already finished, and one bad testcase does not
 * lose the others. Nothing here changes the problem: results are stored as
 * content-addressed files and become part of it only when the author saves the
 * testcases page with a reference to them.
 */
export default class GenerateService {
  private readonly logger = new TLogger(Layer.SERVICE);
  private timer: NodeJS.Timeout | undefined;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly generate: GenerateRepository,
    private readonly problems: ProblemRepository,
    private readonly tests: TestCaseRepository,
    private readonly solutions: SolutionRepository,
    private readonly problemService: ProblemService,
    private readonly judge: JudgeClient,
    private readonly storage: FileStorage,
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
    input: StartGenerateInput,
    requestId: string
  ): Promise<GenerateJobDto> {
    const logger = this.logger.setContext('service.generate.start', requestId);
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    const draft = await this.problems.findDraftVersion(this.prisma, problem.id);
    assertDraftEditable(problem, draft);
    const version = draft!;

    const solution = await this.solutions.find(this.prisma, version.id, input.solution_id);
    if (!solution) throw new NotFoundError('Solution not found.');
    const all = await this.tests.listByVersion(this.prisma, version.id);
    if (all.length === 0) {
      throw new ValidationError([{ field: 'test_ids', message: 'Add a testcase first.' }]);
    }
    const chosen = input.test_ids
      ? input.test_ids.map((id) => all.find((test) => test.id === id))
      : all;
    if (chosen.length === 0 || chosen.some((test) => !test)) {
      throw new ValidationError([
        { field: 'test_ids', message: 'Pick testcases of this problem, at least one.' },
      ]);
    }
    if (new Set(chosen.map((test) => test!.id)).size !== chosen.length) {
      throw new ValidationError([{ field: 'test_ids', message: 'List each testcase once.' }]);
    }

    const job = await this.prisma.$transaction(async (tx) => {
      await this.problems.lock(tx, problem.id);
      if (await this.generate.findRunning(tx, version.id)) {
        throw new ConflictError(
          'Expected outputs are already being generated for this problem. Stop that run or wait for it to finish.',
          'GENERATE_RUNNING'
        );
      }
      return this.generate.create(tx, {
        problem_version_id: version.id,
        created_by_id: user.id,
        language: solution.language,
        source: solution.source,
        deadline_at: new Date(
          this.now().getTime() + (this.options.timeoutMs ?? GENERATE_TIMEOUT_MS)
        ),
        runs: chosen
          .map((test) => ({ test_case_id: test!.id, position: test!.position }))
          .sort((a, b) => a.position - b.position),
      });
    });
    logger.info({
      message: 'generate started',
      data: { jobId: job.id, problemId: problem.id, runs: job.runs.length },
    });
    await this.pump(job.id, requestId);
    return this.view(job.id);
  }

  async get(user: User, slug: string, problemSlug: string, jobId: string): Promise<GenerateJobDto> {
    await this.authorJob(user, 'problem.view_private', slug, problemSlug, jobId);
    // Applies the deadline even if nothing else would have noticed it yet.
    await this.pump(jobId);
    return this.view(jobId);
  }

  /** Stops dispatching. What already finished is kept and returned. */
  async stop(
    user: User,
    slug: string,
    problemSlug: string,
    jobId: string,
    requestId: string
  ): Promise<GenerateJobDto> {
    const logger = this.logger.setContext('service.generate.stop', requestId);
    await this.authorJob(user, 'problem.update', slug, problemSlug, jobId);
    await this.prisma.$transaction(async (tx) => {
      await this.generate.lock(tx, jobId);
      const job = await this.generate.find(tx, jobId);
      if (!job || job.status !== 'running') return;
      // A run on Judge has no way to be called back: its late result is refused.
      for (const run of job.runs.filter((candidate) => candidate.status === 'running')) {
        await this.generate.requeueRun(tx, run.id, null);
      }
      await this.generate.finishJob(tx, jobId, { status: 'stopped' }, this.now());
    });
    logger.info({ message: 'generate stopped', data: { jobId } });
    return this.view(jobId);
  }

  // --- results from Judge -------------------------------------------------

  /** Returns false when the job id is not one of ours (Judge then stops retrying). */
  async receive(result: GenerateResultInput, requestId?: string): Promise<boolean> {
    const logger = this.logger.setContext('service.generate.receive', requestId);
    const known = await this.generate.findRunByJudgeJob(this.prisma, result.job_id);
    if (!known) return false;

    const outcome = await this.prisma.$transaction(async (tx) => {
      await this.generate.lock(tx, known.job_id);
      const run = await tx.generateRun.findUnique({ where: { id: known.id } });
      // A duplicate, or one that arrives after "stop" or a timeout: acknowledged and ignored.
      if (!run || run.status !== 'running' || run.judge_job_id !== result.job_id) {
        return { kind: 'ignored' as const };
      }
      const now = this.now();

      if (result.verdict === 'CE') {
        await this.generate.finishRun(
          tx,
          run.id,
          { status: 'failed', error_code: 'COMPILE_ERROR' },
          now
        );
        await this.generate.finishJob(
          tx,
          run.job_id,
          {
            status: 'failed',
            error_code: 'COMPILE_ERROR',
            error_message:
              firstLine(result.compile?.message ?? '', 300) || 'The solution does not compile.',
          },
          now
        );
        return { kind: 'stored' as const };
      }
      const test = result.tests[0];
      if (result.verdict === 'ISE' || !test) {
        await this.generate.finishRun(
          tx,
          run.id,
          {
            status: 'failed',
            verdict: 'ISE',
            error_code: (result.error?.code ?? 'ISE').slice(0, 64),
          },
          now
        );
        return { kind: 'stored' as const, next: true as const };
      }
      const stats = { time_ms: test.time_ms, memory_kb: test.memory_kb };
      const stderr = test.stderr ? test.stderr.slice(0, STDERR_KEPT) : null;
      if (test.verdict !== 'AC' || test.stdout === undefined) {
        await this.generate.finishRun(
          tx,
          run.id,
          {
            status: 'failed',
            verdict: (test.verdict === 'AC' ? 'ISE' : test.verdict) as 'TLE',
            error_code: test.verdict === 'AC' ? 'NO_OUTPUT' : null,
            stderr,
            ...stats,
          },
          now
        );
        return { kind: 'stored' as const, next: true as const };
      }
      return {
        kind: 'output' as const,
        run,
        test: { ...test, stdout: test.stdout },
        stats,
        stderr,
      };
    });

    if (outcome.kind === 'ignored') return true;
    if (outcome.kind === 'output') {
      await this.storeOutput(outcome.run, outcome.test.stdout, outcome.stats, outcome.stderr);
    }
    await this.pump(known.job_id, requestId);
    logger.info({ message: 'generate result stored', data: { runId: known.id } });
    return true;
  }

  /** Normalises and stores one generated output, then marks the run done (or failed when it is not text). */
  private async storeOutput(
    run: { id: string; job_id: string; test_case_id: string; judge_job_id: string | null },
    stdout: string,
    stats: { time_ms: number; memory_kb: number },
    stderr: string | null
  ) {
    let sha256: string | null = null;
    let size: number | null = null;
    let same: boolean | null = null;
    let failure: { code: string; message: string } | null = null;
    try {
      const file = normalizeTestFile(Buffer.from(stdout, 'utf8'), {
        maxBytes: TEST_LIMITS.max_file_bytes,
      });
      const key = testFileKey(file.sha256);
      const existing = await this.storage.head(key);
      if (!existing || existing.size !== file.size) {
        await this.storage.put(key, file.bytes, {
          size: file.size,
          contentType: 'text/plain; charset=utf-8',
        });
      }
      sha256 = file.sha256;
      size = file.size;
      const current = await this.prisma.testCase.findUnique({ where: { id: run.test_case_id } });
      if (current?.output_sha256) {
        same =
          current.output_sha256 === file.sha256 ||
          sameOutput(
            (
              await readAll((await this.storage.get(testFileKey(current.output_sha256))).body)
            ).toString('utf8'),
            file.bytes.toString('utf8')
          );
      }
    } catch (error) {
      if (error instanceof TestFileError) {
        failure = { code: 'OUTPUT_NOT_TEXT', message: error.reason };
      } else if (
        error instanceof StorageUnavailableError ||
        error instanceof StorageNotFoundError
      ) {
        failure = { code: 'STORAGE_UNAVAILABLE', message: 'The output could not be stored.' };
      } else {
        throw error;
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await this.generate.lock(tx, run.job_id);
      const fresh = await tx.generateRun.findUnique({ where: { id: run.id } });
      if (!fresh || fresh.status !== 'running' || fresh.judge_job_id !== run.judge_job_id) return;
      await this.generate.finishRun(
        tx,
        run.id,
        failure
          ? {
              status: 'failed',
              verdict: 'RE',
              error_code: failure.code,
              stderr: `${failure.message}`.slice(0, 300),
              ...stats,
            }
          : {
              status: 'done',
              verdict: 'AC',
              stderr,
              output_sha256: sha256,
              output_size_bytes: size,
              same_as_current: same,
              ...stats,
            },
        this.now()
      );
    });
  }

  // --- dispatching --------------------------------------------------------

  /**
   * Moves a job forward: applies the deadline, hands more testcases to Judge up
   * to the parallel limit, and completes the job when nothing is left to do.
   */
  async pump(jobId: string, requestId?: string): Promise<void> {
    const claimed = await this.prisma.$transaction(async (tx) => {
      await this.generate.lock(tx, jobId);
      const job = await this.generate.find(tx, jobId);
      if (!job || job.status !== 'running') return [];
      const now = this.now();
      if (now >= job.deadline_at) {
        for (const run of job.runs.filter((candidate) => candidate.status === 'running')) {
          await this.generate.requeueRun(tx, run.id, null);
        }
        await this.generate.finishJob(tx, jobId, { status: 'timed_out' }, now);
        return [];
      }
      const open = job.runs.filter((run) => run.status === 'queued' || run.status === 'running');
      if (open.length === 0) {
        await this.generate.finishJob(tx, jobId, { status: 'completed' }, now);
        return [];
      }
      const running = job.runs.filter((run) => run.status === 'running').length;
      const ready = job.runs.filter(
        (run) => run.status === 'queued' && (!run.next_dispatch_at || run.next_dispatch_at <= now)
      );
      const claims = [];
      for (const run of ready.slice(0, Math.max(0, MAX_PARALLEL - running))) {
        claims.push(await this.generate.claimRun(tx, run.id, randomUUID()));
      }
      return claims;
    });
    if (claimed.length === 0) return;
    await Promise.all(claimed.map((run) => this.dispatchRun(jobId, run, requestId)));
  }

  private async dispatchRun(
    jobId: string,
    run: { id: string; test_case_id: string; judge_job_id: string | null; attempts: number },
    requestId?: string
  ) {
    const logger = this.logger.setContext('service.generate.dispatch', requestId);
    const job = await this.generate.find(this.prisma, jobId);
    const [version, test] = await Promise.all([
      job ? this.problems.findVersion(this.prisma, job.problem_version_id) : null,
      this.prisma.testCase.findUnique({ where: { id: run.test_case_id } }),
    ]);
    if (!job || !version || !test || !run.judge_job_id) return;

    const request: JobRequest = {
      job_id: run.judge_job_id,
      kind: 'generate',
      language: job.language,
      source: job.source,
      limits: {
        time_ms: version.time_limit_ms,
        memory_kb: version.memory_limit_kb,
        output_kb: Math.min(OUTPUT_LIMIT_KB, Math.ceil(TEST_LIMITS.max_file_bytes / 1024)),
      },
      capture: {
        stdout_bytes: TEST_LIMITS.max_file_bytes,
        stderr_bytes: 4096,
        total_bytes: TEST_LIMITS.max_file_bytes + 8192,
      },
      tests: [
        {
          id: run.id,
          input: { sha256: test.input_sha256, size_bytes: test.input_size_bytes },
          sample: false,
        },
      ],
      callback_url: this.options.callbackUrl,
    };
    try {
      await this.judge.createJob(request);
    } catch (error) {
      if (error instanceof JudgeRejectedError) {
        logger.error({ message: 'Judge rejected a generate job', data: { runId: run.id }, error });
        await this.failRun(jobId, run.id, run.judge_job_id, 'JUDGE_REJECTED');
        await this.pump(jobId, requestId);
        return;
      }
      if (!(error instanceof JudgeUnavailableError)) throw error;
      await this.retryLater(jobId, run, error);
    }
  }

  private async failRun(jobId: string, runId: string, judgeJobId: string, code: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.generate.lock(tx, jobId);
      const run = await tx.generateRun.findUnique({ where: { id: runId } });
      if (!run || run.status !== 'running' || run.judge_job_id !== judgeJobId) return;
      await this.generate.finishRun(
        tx,
        runId,
        { status: 'failed', verdict: 'ISE', error_code: code },
        this.now()
      );
    });
  }

  private async retryLater(
    jobId: string,
    run: { id: string; judge_job_id: string | null; attempts: number },
    error: Error
  ) {
    this.logger.setContext('service.generate.retry').warn({
      message: 'Judge is unavailable for a generate job',
      data: { runId: run.id, attempts: run.attempts },
      error,
    });
    await this.prisma.$transaction(async (tx) => {
      await this.generate.lock(tx, jobId);
      const current = await tx.generateRun.findUnique({ where: { id: run.id } });
      if (!current || current.status !== 'running' || current.judge_job_id !== run.judge_job_id)
        return;
      if (run.attempts >= MAX_DISPATCH_ATTEMPTS) {
        await this.generate.finishJob(
          tx,
          jobId,
          {
            status: 'failed',
            error_code: 'JUDGE_UNAVAILABLE',
            error_message: 'Judge is not responding.',
          },
          this.now()
        );
        await this.generate.requeueRun(tx, run.id, null);
        return;
      }
      const delay = Math.min(1000 * 2 ** run.attempts, 30_000);
      await this.generate.requeueRun(tx, run.id, new Date(this.now().getTime() + delay));
    });
  }

  // --- background work ----------------------------------------------------

  /** One pass: keep every running job moving (retries, deadlines), and drop old jobs. */
  async tick(): Promise<void> {
    for (const { id } of await this.generate.listRunningJobIds(this.prisma)) {
      await this.pump(id);
    }
    await this.generate.deleteOlderThan(
      this.prisma,
      new Date(this.now().getTime() - GENERATE_RETENTION_MS)
    );
  }

  startLoop(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const run = this.tick().catch((error) =>
        this.logger.error({ message: 'generate loop failed', error: error as Error })
      );
      this.inflight.add(run);
      void run.finally(() => this.inflight.delete(run));
    }, intervalMs);
    this.timer.unref();
  }

  async stopLoop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.inflight]);
  }

  // --- views --------------------------------------------------------------

  private async authorJob(
    user: User,
    action: 'problem.update' | 'problem.view_private',
    slug: string,
    problemSlug: string,
    jobId: string
  ) {
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      action,
      slug,
      problemSlug
    );
    const job = await this.generate.find(this.prisma, jobId);
    const version = job
      ? await this.problems.findVersion(this.prisma, job.problem_version_id)
      : null;
    if (!job || !version || version.problem_id !== problem.id) {
      throw new NotFoundError('Generate job not found.');
    }
    return job;
  }

  private async view(jobId: string): Promise<GenerateJobDto> {
    const job = await this.generate.find(this.prisma, jobId);
    if (!job) throw new ServiceUnavailableError();
    return toGenerateJobDto(job);
  }
}

export function toGenerateJobDto(job: GenerateJobRecord): GenerateJobDto {
  const runs = job.runs.map(
    (run): GenerateRunDto => ({
      test_id: run.test_case_id,
      position: run.position,
      status: run.status,
      verdict: run.verdict,
      error_code: run.error_code,
      time_ms: run.time_ms,
      memory_kb: run.memory_kb,
      stderr: run.stderr,
      output:
        run.output_sha256 && run.output_size_bytes !== null
          ? { sha256: run.output_sha256, size_bytes: run.output_size_bytes }
          : null,
      same_as_current: run.same_as_current,
    })
  );
  return {
    id: job.id,
    status: job.status,
    error: job.error_code
      ? { code: job.error_code, message: job.error_message ?? job.error_code }
      : null,
    created_at: job.created_at.toISOString(),
    deadline_at: job.deadline_at.toISOString(),
    finished_at: job.finished_at?.toISOString() ?? null,
    progress: {
      total: runs.length,
      done: runs.filter((run) => run.status === 'done').length,
      failed: runs.filter((run) => run.status === 'failed').length,
    },
    runs,
  };
}
