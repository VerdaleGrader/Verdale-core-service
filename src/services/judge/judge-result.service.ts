import { z } from 'zod';
import type { PrismaClient } from '../../../generated/prisma/client';
import { BadRequestError, ConflictError, NotFoundError, VError } from '@/errors';
import { CAPTURE } from '@/constants/limits';
import { verify } from '@/libs/hmac';
import TLogger, { Layer } from '@/logging/logger';
import SubmissionRepository, { SubmissionResultInput } from '@/repositories/submission.repository';
import TestCaseRepository from '@/repositories/test-case.repository';
import GenerateService from '@/services/problem/generate.service';

const VERDICTS = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'OLE', 'ISE'] as const;
const TEST_VERDICTS = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'OLE', 'ISE', 'SKIPPED'] as const;

/** JobResult from contracts/judge.openapi.yaml. Unknown fields are ignored. */
const jobResultSchema = z.object({
  job_id: z.uuid(),
  kind: z.string(),
  verdict: z.enum(VERDICTS),
  compile: z.object({ ok: z.boolean(), message: z.string(), time_ms: z.number() }).optional(),
  tests: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(TEST_VERDICTS),
      time_ms: z.number().int().min(0),
      memory_kb: z.number().int().min(0),
      exit_code: z.number().int().optional(),
      signal: z.number().int().optional(),
      stdout_preview: z.string().optional(),
      checker_message: z.string().optional(),
      // Present when Core asked for `capture`, for every test that ran (GRD-93).
      stdout: z.string().optional(),
      stdout_size_bytes: z.number().int().min(0).optional(),
      stderr: z.string().optional(),
      stderr_size_bytes: z.number().int().min(0).optional(),
    })
  ),
  summary: z.object({
    passed: z.number().int().min(0),
    total: z.number().int().min(0),
    time_ms: z.number().int().min(0),
    memory_kb: z.number().int().min(0),
  }),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  judged_at: z.iso.datetime({ offset: true }),
  judge_version: z.string(),
});

/** Bounds on what is stored of a program's output, whatever Judge sends. */
const STORED_STDOUT_CHARS = CAPTURE.stdout_bytes;
const STORED_STDERR_CHARS = CAPTURE.stderr_bytes;

/** Postgres text cannot hold NUL, and a runaway result must not fill the table. */
const clean = (text: string, limit: number) => text.replaceAll('\u0000', '\uFFFD').slice(0, limit);

function capturedOutput(test: {
  stdout?: string;
  stdout_size_bytes?: number;
  stderr?: string;
  stderr_size_bytes?: number;
}): SubmissionResultInput['output'] {
  if (test.stdout === undefined && test.stderr === undefined) return null;
  return {
    stdout: test.stdout === undefined ? null : clean(test.stdout, STORED_STDOUT_CHARS),
    stdout_size_bytes: test.stdout === undefined ? null : (test.stdout_size_bytes ?? null),
    stderr: test.stderr === undefined ? null : clean(test.stderr, STORED_STDERR_CHARS),
    stderr_size_bytes: test.stderr === undefined ? null : (test.stderr_size_bytes ?? null),
  };
}

export type ReceiveOutcome = 'stored' | 'duplicate';

/** An answer Judge treats as final (it will not retry): 404, 409, 422. */
const unprocessable = (message: string) =>
  new VError({ message, status: 422, error_code: 'UNPROCESSABLE' });

/**
 * Receives results from Judge (GRD-45). Safe against everything an
 * at-least-once channel does: the signature, key id and timestamp are checked
 * on the raw bytes before anything is parsed; a result is applied once per
 * job id; a duplicate is acknowledged and changes nothing; a result for a job
 * Core no longer knows (for example the one replaced by a re-judge) is refused
 * and can never overwrite a newer state.
 */
export default class JudgeResultService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly submissions: SubmissionRepository,
    private readonly tests: TestCaseRepository,
    private readonly callbackKeys: Record<string, string>,
    private readonly generate: GenerateService,
    private readonly now: () => Date = () => new Date()
  ) {}

  async receive(
    request: {
      method: string;
      path: string;
      headers: Record<string, string | string[] | undefined>;
      rawBody: Buffer;
    },
    requestId: string
  ): Promise<ReceiveOutcome> {
    const logger = this.logger.setContext('service.judgeResult.receive', requestId);

    const verified = verify(
      request.headers,
      this.callbackKeys,
      request.method,
      request.path,
      request.rawBody,
      { now: this.now().getTime() }
    );
    if (!verified.ok) {
      logger.warn({ message: 'Judge callback rejected', data: { reason: verified.reason } });
      throw new VError({
        message: 'The request signature is not valid.',
        status: 401,
        error_code: verified.reason,
      });
    }

    let json: unknown;
    try {
      json = JSON.parse(request.rawBody.toString('utf8'));
    } catch {
      throw new BadRequestError('The body is not valid JSON.');
    }
    const parsed = jobResultSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn({
        message: 'Judge callback has an unexpected shape',
        data: { issues: parsed.error.issues.slice(0, 5).map((issue) => issue.path.join('.')) },
      });
      throw unprocessable('The result does not match the contract.');
    }
    const result = parsed.data;
    if (result.kind === 'generate') {
      // Expected outputs being created from a solution (GRD-108), not a submission.
      const known = await this.generate.receive(
        {
          job_id: result.job_id,
          verdict: result.verdict,
          compile: result.compile,
          tests: result.tests,
          error: result.error,
        },
        requestId
      );
      if (!known) throw new NotFoundError('Unknown job.');
      return 'stored';
    }
    if (result.kind !== 'submission') {
      throw unprocessable(`Core only accepts results of "submission" jobs, not "${result.kind}".`);
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
      const known = await this.submissions.findByJobId(tx, result.job_id);
      if (!known) return null;
      await this.submissions.lock(tx, known.id);
      const submission = await this.submissions.findById(tx, known.id);
      // A re-judge may have replaced the job while we waited for the lock.
      if (!submission || submission.judge_job_id !== result.job_id) return null;

      if (submission.status === 'completed') {
        if (submission.verdict === result.verdict)
          return { kind: 'duplicate' as const, id: submission.id };
        return {
          kind: 'conflict' as const,
          id: submission.id,
          stored: submission.verdict,
        };
      }

      const cases = new Map(
        (await this.tests.listByVersion(tx, submission.problem_version_id)).map((test) => [
          test.id,
          test,
        ])
      );
      const seen = new Set<string>();
      const rows: SubmissionResultInput[] = [];
      for (const test of result.tests) {
        const known = cases.get(test.id);
        if (!known || seen.has(test.id)) {
          throw unprocessable(
            `The result mentions a test (${test.id}) that is not part of this problem version.`
          );
        }
        seen.add(test.id);
        // Whether a test is a sample comes from our own record, never from the result.
        const isSample = known.is_sample;
        rows.push({
          position: known.position,
          test_case_id: known.id,
          is_sample: isSample,
          verdict: test.verdict,
          time_ms: test.time_ms,
          memory_kb: test.memory_kb,
          exit_code: test.exit_code ?? null,
          signal: test.signal ?? null,
          stdout_preview: isSample ? (test.stdout_preview?.slice(0, 1024) ?? null) : null,
          checker_message: isSample ? (test.checker_message?.slice(0, 256) ?? null) : null,
          output: capturedOutput(test),
        });
      }
      rows.sort((left, right) => left.position - right.position);

      const noTimings = result.verdict === 'CE' || result.verdict === 'ISE';
      await this.submissions.deleteResults(tx, submission.id);
      if (rows.length > 0) await this.submissions.createResults(tx, submission.id, rows);
      await this.submissions.complete(tx, submission.id, {
        verdict: result.verdict,
        time_ms: noTimings ? null : result.summary.time_ms,
        memory_kb: noTimings ? null : result.summary.memory_kb,
        tests_passed: result.summary.passed,
        tests_total: submission.tests_total ?? result.summary.total,
        compile_message:
          result.verdict === 'CE' && result.compile ? result.compile.message.slice(0, 8192) : null,
        error_code:
          result.verdict === 'ISE' ? (result.error?.code ?? 'UNKNOWN').slice(0, 64) : null,
        judge_version: result.judge_version.slice(0, 64),
        judged_at: new Date(result.judged_at),
      });
      return { kind: 'stored' as const, id: submission.id };
    });

    if (outcome === null) {
      logger.warn({
        message: 'Judge sent a result for an unknown job',
        data: { jobId: result.job_id },
      });
      throw new NotFoundError('Unknown job.');
    }
    if (outcome.kind === 'conflict') {
      logger.warn({
        message: 'Judge sent a different result for a job that already finished',
        data: { jobId: result.job_id, stored: outcome.stored, received: result.verdict },
      });
      throw new ConflictError('This job already has a different result.');
    }
    if (outcome.kind === 'duplicate') {
      logger.info({ message: 'duplicate Judge result ignored', data: { jobId: result.job_id } });
      return 'duplicate';
    }
    logger.info({
      message: 'Judge result stored',
      data: { submissionId: outcome.id, jobId: result.job_id, verdict: result.verdict },
    });
    return 'stored';
  }
}
