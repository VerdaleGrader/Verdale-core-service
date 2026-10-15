import { randomUUID } from 'node:crypto';
import type { AiProvider, PrismaClient, User } from '../../../generated/prisma/client';
import { AI_TEST_LIMITS, OUTPUT_LIMIT_KB } from '@/constants/limits';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '@/errors';
import { AiClient, AiProviderError, AiProviderErrorCode } from '@/libs/ai-provider';
import { JudgeClient, JudgeRejectedError, JudgeUnavailableError, JobRequest } from '@/libs/judge';
import {
  FileStorage,
  StorageNotFoundError,
  StorageUnavailableError,
  readAll,
  testFileKey,
} from '@/libs/storage/file-storage';
import { NormalizedFile, TestFileError, normalizeTestFile } from '@/libs/test-file';
import TLogger, { Layer } from '@/logging/logger';
import AiTestRepository, { NewAiTestItem } from '@/repositories/ai-test.repository';
import ProblemRepository from '@/repositories/problem.repository';
import SolutionRepository from '@/repositories/solution.repository';
import { assertDraftEditable } from '@/services/problem/problem.access';
import ProblemService from '@/services/problem/problem.service';
import AiCredentialService from '@/services/user/ai-credential.service';

export const AI_CATEGORIES = ['edge', 'max', 'random'] as const;
export type AiCategory = (typeof AI_CATEGORIES)[number];

export interface StartAiTestsInput {
  provider: AiProvider;
  count: number;
  /** Left empty, the model follows the statement. */
  categories?: AiCategory[];
  solution_id: string;
  /** Send the reference solution's code to the provider as well. Off unless the author turns it on. */
  include_solution?: boolean;
}

export interface AiTestItemDto {
  id: string;
  position: number;
  status: 'pending' | 'ok' | 'skipped';
  input: { sha256: string; size_bytes: number } | null;
  /** The generated input, so the author can read and edit it before adding it. */
  input_text: string | null;
  output: { sha256: string; size_bytes: number } | null;
  /** The first lines of the expected output Judge produced. */
  output_preview: string | null;
  skip_reason: string | null;
}

export interface AiTestJobDto {
  id: string;
  status: 'generating' | 'computing' | 'completed' | 'failed';
  provider: AiProvider;
  requested_count: number;
  error: { code: string; message: string } | null;
  created_at: string;
  deadline_at: string;
  finished_at: string | null;
  usable_count: number;
  skipped_count: number;
  items: AiTestItemDto[];
}

/** The parts of a Judge JobResult this service reads. */
export interface AiTestResultInput {
  job_id: string;
  verdict: string;
  compile?: { ok: boolean; message: string };
  tests: Array<{ id: string; verdict: string; stdout?: string }>;
  error?: { code: string; message: string };
}

const PREVIEW_CHARS = 600;
const EXPLAIN: Record<AiProviderErrorCode, string> = {
  AI_KEY_INVALID: 'The provider did not accept your API key. Check it and save it again.',
  AI_QUOTA_EXCEEDED: 'Your provider account is out of quota or rate limited. Try again later.',
  AI_BAD_RESPONSE: 'The provider answered in a form we could not read. Try again.',
  AI_UNAVAILABLE: 'The provider could not be reached. Try again in a moment.',
};
const VERDICT_REASON: Record<string, string> = {
  WA: 'The solution gave an answer Judge could not use',
  TLE: 'Time limit exceeded on this input',
  MLE: 'Memory limit exceeded on this input',
  RE: 'Runtime error on this input',
  OLE: 'Output limit exceeded on this input',
  ISE: 'Internal error while running this input',
  SKIPPED: 'Skipped',
};

const CATEGORY_TEXT: Record<AiCategory, string> = {
  edge: 'edge cases: smallest sizes, boundary values, degenerate shapes',
  max: 'values at the largest the constraints allow (but keep one input under 60 KB)',
  random: 'random values spread across what the constraints allow',
};

export function buildPrompt(input: {
  title: string;
  statement: string;
  timeLimitMs: number;
  memoryLimitKb: number;
  count: number;
  categories: AiCategory[];
  solution?: { language: string; source: string };
}): { system: string; user: string } {
  const system = [
    'You write testcase inputs for programming contest problems.',
    'Reply with JSON only, in this shape: {"inputs": ["<complete input 1>", "<complete input 2>"]}.',
    'Each string is the complete standard input of one testcase, in exactly the format the statement describes, and ends with a newline.',
    'Never write expected outputs, explanations or code fences. Every input must satisfy every constraint in the statement.',
    'Keep each input under 60 KB. Give each input a different content.',
  ].join('\n');
  const focus =
    input.categories.length > 0
      ? `Spread the inputs over these categories: ${input.categories
          .map((category) => CATEGORY_TEXT[category])
          .join('; ')}.`
      : 'Choose a sensible mix of small, tricky and larger inputs from what the statement says.';
  const parts = [
    `Problem title: ${input.title}`,
    `Time limit: ${input.timeLimitMs} ms. Memory limit: ${Math.round(input.memoryLimitKb / 1024)} MB.`,
    '',
    'Statement (Markdown):',
    input.statement,
    '',
    `Write exactly ${input.count} inputs. ${focus}`,
  ];
  if (input.solution) {
    parts.push(
      '',
      `Reference solution (${input.solution.language}), shown so you can aim at its edge cases:`,
      input.solution.source
    );
  }
  return { system, user: parts.join('\n') };
}

const firstLine = (text: string, limit: number) =>
  (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, limit);

/**
 * Drafts testcases with a generative model and the author's own key (GRD-124).
 * The model only writes inputs; the expected outputs come from running a
 * reference solution on Judge, as in "generate expected output". Nothing here
 * touches the problem: drafts are stored content-addressed, and they become
 * testcases only when the author saves the testcases page with a reference to
 * them. The provider call and the hand-over to Judge run in the background so
 * the request returns at once and the page polls.
 */
export default class AiTestService {
  private readonly logger = new TLogger(Layer.SERVICE);
  private timer: NodeJS.Timeout | undefined;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly jobs: AiTestRepository,
    private readonly problems: ProblemRepository,
    private readonly solutions: SolutionRepository,
    private readonly problemService: ProblemService,
    private readonly credentials: AiCredentialService,
    private readonly ai: AiClient,
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
    input: StartAiTestsInput,
    requestId: string
  ): Promise<AiTestJobDto> {
    const logger = this.logger.setContext('service.aiTest.start', requestId);
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
    if (version.statement_mode === 'pdf' || version.statement.trim() === '') {
      throw new ValidationError([
        {
          field: 'statement',
          message: 'Write the statement in Markdown first; the model reads the statement text.',
        },
      ]);
    }
    const solution = await this.solutions.find(this.prisma, version.id, input.solution_id);
    if (!solution) throw new NotFoundError('Solution not found.');
    // Fails early, before a job exists, when there is no key or it cannot be read.
    const apiKey = await this.credentials.reveal(user.id, input.provider);

    const includeSolution = input.include_solution === true;
    const categories = [...new Set(input.categories ?? [])];
    const job = await this.prisma.$transaction(async (tx) => {
      await this.problems.lock(tx, problem.id);
      if (await this.jobs.findActive(tx, version.id)) {
        throw new ConflictError(
          'Testcases are already being drafted for this problem. Wait for that run to finish.',
          'AI_TEST_RUNNING'
        );
      }
      return this.jobs.create(tx, {
        problem_version_id: version.id,
        created_by_id: user.id,
        provider: input.provider,
        requested_count: input.count,
        categories,
        include_solution: includeSolution,
        deadline_at: new Date(
          this.now().getTime() + (this.options.timeoutMs ?? AI_TEST_LIMITS.timeout_ms)
        ),
      });
    });
    logger.info({
      message: 'AI testcase job started',
      data: {
        jobId: job.id,
        problemId: problem.id,
        provider: input.provider,
        count: input.count,
        includeSolution,
      },
    });

    const prompt = buildPrompt({
      title: version.title,
      statement: version.statement,
      timeLimitMs: version.time_limit_ms,
      memoryLimitKb: version.memory_limit_kb,
      count: input.count,
      categories,
      solution: includeSolution
        ? { language: solution.language, source: solution.source }
        : undefined,
    });
    const run = this.run(
      job.id,
      { provider: input.provider, apiKey, prompt, count: input.count },
      {
        language: solution.language,
        source: solution.source,
        timeLimitMs: version.time_limit_ms,
        memoryLimitKb: version.memory_limit_kb,
      },
      requestId
    ).catch((error) => this.crashed(job.id, error as Error, requestId));
    this.inflight.add(run);
    void run.finally(() => this.inflight.delete(run));
    return this.view(job.id);
  }

  async get(user: User, slug: string, problemSlug: string, jobId: string): Promise<AiTestJobDto> {
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.view_private',
      slug,
      problemSlug
    );
    const job = await this.jobs.find(this.prisma, jobId);
    const version = job
      ? await this.problems.findVersion(this.prisma, job.problem_version_id)
      : null;
    if (!job || !version || version.problem_id !== problem.id) {
      throw new NotFoundError('AI testcase job not found.');
    }
    await this.expire(jobId);
    return this.view(jobId);
  }

  /** Waits for background work to end (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  // --- the background run -------------------------------------------------

  private async run(
    jobId: string,
    request: {
      provider: AiProvider;
      apiKey: string;
      prompt: { system: string; user: string };
      count: number;
    },
    solution: {
      language: JobRequest['language'];
      source: string;
      timeLimitMs: number;
      memoryLimitKb: number;
    },
    requestId: string
  ): Promise<void> {
    const logger = this.logger.setContext('service.aiTest.run', requestId);
    let texts: string[];
    try {
      texts = await this.ai.generateInputs(request.provider, request.apiKey, request.prompt);
    } catch (error) {
      if (!(error instanceof AiProviderError)) throw error;
      logger.warn({ message: 'AI provider call failed', data: { jobId, code: error.code } });
      await this.fail(jobId, error.code, EXPLAIN[error.code]);
      return;
    }
    if (texts.length === 0) {
      await this.fail(jobId, 'AI_BAD_RESPONSE', EXPLAIN.AI_BAD_RESPONSE);
      return;
    }

    const drafted = await this.stageInputs(texts.slice(0, request.count));
    const items = await this.prisma.$transaction(async (tx) => {
      await this.jobs.lock(tx, jobId);
      const job = await this.jobs.find(tx, jobId);
      if (!job || job.status !== 'generating') return null;
      return this.jobs.createItems(tx, jobId, drafted);
    });
    if (!items) return;

    const pending = items.filter((item) => item.status === 'pending');
    if (pending.length === 0) {
      await this.finish(jobId);
      return;
    }
    const judgeJobId = randomUUID();
    const moved = await this.prisma.$transaction(async (tx) => {
      await this.jobs.lock(tx, jobId);
      const job = await this.jobs.find(tx, jobId);
      if (!job || job.status !== 'generating') return false;
      await this.jobs.setComputing(tx, jobId, judgeJobId);
      return true;
    });
    if (!moved) return;

    const judgeRequest: JobRequest = {
      job_id: judgeJobId,
      kind: 'generate',
      language: solution.language,
      source: solution.source,
      limits: {
        time_ms: solution.timeLimitMs,
        memory_kb: solution.memoryLimitKb,
        output_kb: Math.min(OUTPUT_LIMIT_KB, Math.ceil(AI_TEST_LIMITS.stdout_bytes / 1024)),
      },
      capture: {
        stdout_bytes: AI_TEST_LIMITS.stdout_bytes,
        stderr_bytes: 1024,
        total_bytes: AI_TEST_LIMITS.total_bytes + 64 * 1024,
      },
      tests: pending.map((item) => ({
        id: item.id,
        input: { sha256: item.input_sha256!, size_bytes: item.input_size_bytes! },
        sample: false,
      })),
      callback_url: this.options.callbackUrl,
    };
    try {
      await this.judge.createJob(judgeRequest);
    } catch (error) {
      if (error instanceof JudgeRejectedError) {
        logger.error({ message: 'Judge rejected an AI testcase job', data: { jobId }, error });
        await this.fail(
          jobId,
          'JUDGE_REJECTED',
          'Judge could not run the solution on these inputs.'
        );
        return;
      }
      if (!(error instanceof JudgeUnavailableError)) throw error;
      logger.warn({
        message: 'Judge is unavailable for an AI testcase job',
        data: { jobId },
        error,
      });
      await this.fail(
        jobId,
        'JUDGE_UNAVAILABLE',
        'Judge is not responding. Try again in a moment.'
      );
    }
  }

  /** Normalises and stores every input the model wrote; refused ones are kept as skipped items with the reason. */
  private async stageInputs(texts: string[]): Promise<NewAiTestItem[]> {
    const seen = new Map<string, number>();
    const items: NewAiTestItem[] = [];
    for (const [index, text] of texts.entries()) {
      const label = `Input ${index + 1}`;
      const skipped = (reason: string): NewAiTestItem => ({
        position: index,
        status: 'skipped',
        input_sha256: null,
        input_size_bytes: null,
        skip_reason: reason.slice(0, 200),
      });
      let file: NormalizedFile;
      try {
        file = normalizeTestFile(Buffer.from(text, 'utf8'), {
          maxBytes: AI_TEST_LIMITS.max_input_bytes,
        });
      } catch (error) {
        if (!(error instanceof TestFileError)) throw error;
        items.push(skipped(`${label} ${error.reason}.`));
        continue;
      }
      if (file.size === 0) {
        items.push(skipped(`${label} is empty.`));
        continue;
      }
      const same = seen.get(file.sha256);
      if (same !== undefined) {
        items.push(skipped(`${label} repeats input ${same + 1}.`));
        continue;
      }
      try {
        await this.putFile(file);
      } catch (error) {
        if (!(error instanceof StorageUnavailableError)) throw error;
        items.push(skipped(`${label} could not be stored.`));
        continue;
      }
      seen.set(file.sha256, index);
      items.push({
        position: index,
        status: 'pending',
        input_sha256: file.sha256,
        input_size_bytes: file.size,
        skip_reason: null,
      });
    }
    return items;
  }

  private async putFile(file: NormalizedFile) {
    const key = testFileKey(file.sha256);
    const existing = await this.storage.head(key);
    if (!existing || existing.size !== file.size) {
      await this.storage.put(key, file.bytes, {
        size: file.size,
        contentType: 'text/plain; charset=utf-8',
      });
    }
  }

  // --- results from Judge -------------------------------------------------

  /** Returns false when the job id is not one of ours (the caller then tries the next kind of job). */
  async receive(result: AiTestResultInput, requestId?: string): Promise<boolean> {
    const logger = this.logger.setContext('service.aiTest.receive', requestId);
    const known = await this.jobs.findByJudgeJob(this.prisma, result.job_id);
    if (!known) return false;
    const jobId = known.id;

    const before = await this.jobs.find(this.prisma, jobId);
    // A duplicate, or one that arrives after a timeout: acknowledged and ignored.
    if (!before || before.status !== 'computing') return true;

    if (result.verdict === 'CE') {
      await this.fail(
        jobId,
        'COMPILE_ERROR',
        firstLine(result.compile?.message ?? '', 300) || 'The solution does not compile.'
      );
      return true;
    }
    if (result.verdict === 'ISE' || result.tests.length === 0) {
      await this.fail(jobId, 'JUDGE_ERROR', 'Judge could not run the solution. Try again.');
      return true;
    }

    const byItem = new Map(result.tests.map((test) => [test.id, test]));
    const decided = new Map<
      string,
      | { status: 'ok'; output_sha256: string; output_size_bytes: number }
      | { status: 'skipped'; skip_reason: string }
    >();
    for (const item of before.items.filter((candidate) => candidate.status === 'pending')) {
      const test = byItem.get(item.id);
      if (!test) {
        decided.set(item.id, {
          status: 'skipped',
          skip_reason: 'Judge sent no result for this input.',
        });
      } else if (test.verdict !== 'AC' || test.stdout === undefined) {
        decided.set(item.id, {
          status: 'skipped',
          skip_reason: `${VERDICT_REASON[test.verdict] ?? 'The solution could not run on this input'}.`,
        });
      } else {
        decided.set(item.id, await this.storeOutput(test.stdout));
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await this.jobs.lock(tx, jobId);
      const job = await this.jobs.find(tx, jobId);
      if (!job || job.status !== 'computing') return;
      for (const [itemId, change] of decided) await this.jobs.markItem(tx, itemId, change);
      await this.jobs.finish(tx, jobId, { status: 'completed' }, this.now());
    });
    logger.info({ message: 'AI testcase outputs stored', data: { jobId, items: decided.size } });
    return true;
  }

  private async storeOutput(
    stdout: string
  ): Promise<
    | { status: 'ok'; output_sha256: string; output_size_bytes: number }
    | { status: 'skipped'; skip_reason: string }
  > {
    try {
      const file = normalizeTestFile(Buffer.from(stdout, 'utf8'), {
        maxBytes: AI_TEST_LIMITS.stdout_bytes,
      });
      await this.putFile(file);
      return { status: 'ok', output_sha256: file.sha256, output_size_bytes: file.size };
    } catch (error) {
      if (error instanceof TestFileError) {
        return {
          status: 'skipped',
          skip_reason: 'The solution wrote output that is not plain text.',
        };
      }
      if (error instanceof StorageUnavailableError || error instanceof StorageNotFoundError) {
        return { status: 'skipped', skip_reason: 'The output could not be stored.' };
      }
      throw error;
    }
  }

  // --- finishing ----------------------------------------------------------

  private async fail(jobId: string, code: string, message: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.jobs.lock(tx, jobId);
      const job = await this.jobs.find(tx, jobId);
      if (!job || (job.status !== 'generating' && job.status !== 'computing')) return;
      await this.jobs.finish(
        tx,
        jobId,
        { status: 'failed', error_code: code.slice(0, 64), error_message: message.slice(0, 300) },
        this.now()
      );
    });
  }

  private async finish(jobId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.jobs.lock(tx, jobId);
      const job = await this.jobs.find(tx, jobId);
      if (!job || (job.status !== 'generating' && job.status !== 'computing')) return;
      await this.jobs.finish(tx, jobId, { status: 'completed' }, this.now());
    });
  }

  private async crashed(jobId: string, error: Error, requestId: string) {
    // The error may come from anywhere in the run; it is logged without the prompt or the key.
    this.logger
      .setContext('service.aiTest.crashed', requestId)
      .error({ message: 'AI testcase job crashed', data: { jobId }, error });
    await this.fail(jobId, 'INTERNAL_ERROR', 'Something went wrong on our side. Try again.').catch(
      () => undefined
    );
  }

  /** Fails a job whose deadline has passed (the server may have restarted while it ran). */
  private async expire(jobId: string) {
    const job = await this.jobs.find(this.prisma, jobId);
    if (job && (job.status === 'generating' || job.status === 'computing')) {
      if (this.now() >= job.deadline_at) {
        await this.fail(jobId, 'TIMED_OUT', 'This took too long and was stopped. Try again.');
      }
    }
  }

  // --- background work ----------------------------------------------------

  async tick(): Promise<void> {
    for (const { id } of await this.jobs.listActiveIds(this.prisma)) await this.expire(id);
    await this.jobs.deleteOlderThan(
      this.prisma,
      new Date(this.now().getTime() - AI_TEST_LIMITS.retention_ms)
    );
  }

  startLoop(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const run = this.tick().catch((error) =>
        this.logger.error({ message: 'AI testcase loop failed', error: error as Error })
      );
      this.inflight.add(run);
      void run.finally(() => this.inflight.delete(run));
    }, intervalMs);
    this.timer.unref();
  }

  async stopLoop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.idle();
  }

  // --- views --------------------------------------------------------------

  private async view(jobId: string): Promise<AiTestJobDto> {
    const job = await this.jobs.find(this.prisma, jobId);
    if (!job) throw new ServiceUnavailableError();
    const ready = job.status === 'completed';
    const items: AiTestItemDto[] = [];
    for (const item of job.items) {
      items.push({
        id: item.id,
        position: item.position,
        status: item.status,
        input:
          item.input_sha256 && item.input_size_bytes !== null
            ? { sha256: item.input_sha256, size_bytes: item.input_size_bytes }
            : null,
        input_text: ready && item.input_sha256 ? await this.read(item.input_sha256, null) : null,
        output:
          item.output_sha256 && item.output_size_bytes !== null
            ? { sha256: item.output_sha256, size_bytes: item.output_size_bytes }
            : null,
        output_preview:
          ready && item.output_sha256 ? await this.read(item.output_sha256, PREVIEW_CHARS) : null,
        skip_reason: item.skip_reason,
      });
    }
    return {
      id: job.id,
      status: job.status,
      provider: job.provider,
      requested_count: job.requested_count,
      error: job.error_code
        ? { code: job.error_code, message: job.error_message ?? job.error_code }
        : null,
      created_at: job.created_at.toISOString(),
      deadline_at: job.deadline_at.toISOString(),
      finished_at: job.finished_at?.toISOString() ?? null,
      usable_count: items.filter((item) => item.status === 'ok').length,
      skipped_count: items.filter((item) => item.status === 'skipped').length,
      items,
    };
  }

  private async read(sha256: string, limit: number | null): Promise<string | null> {
    try {
      const text = (await readAll((await this.storage.get(testFileKey(sha256))).body)).toString(
        'utf8'
      );
      return limit === null ? text : text.slice(0, limit);
    } catch {
      return null;
    }
  }
}
