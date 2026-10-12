import { Language, SubmissionStatus, TestVerdict, Verdict } from '../../generated/prisma/enums';
import { Db, Prisma } from '@/repositories/db';

const FOR_DISPLAY = {
  user: { select: { username: true, display_name: true } },
  problem: { select: { slug: true, space_id: true, status: true } },
  version: { select: { title: true } },
} as const;

export interface SubmissionResultInput {
  position: number;
  test_case_id: string | null;
  is_sample: boolean;
  verdict: TestVerdict;
  time_ms: number;
  memory_kb: number;
  exit_code: number | null;
  signal: number | null;
  stdout_preview: string | null;
  checker_message: string | null;
}

export interface SubmissionCompletion {
  verdict: Verdict;
  time_ms: number | null;
  memory_kb: number | null;
  tests_passed: number | null;
  tests_total: number | null;
  compile_message: string | null;
  error_code: string | null;
  judge_version: string | null;
  judged_at: Date;
}

export default class SubmissionRepository {
  create(
    db: Db,
    data: {
      user_id: string;
      problem_id: string;
      problem_version_id: string;
      language: Language;
      source: string;
      source_bytes: number;
      tests_total: number;
      next_dispatch_at: Date;
    }
  ) {
    return db.submission.create({ data, include: FOR_DISPLAY });
  }

  findById(db: Db, id: string) {
    return db.submission.findUnique({
      where: { id },
      include: { ...FOR_DISPLAY, results: { orderBy: { position: 'asc' } } },
    });
  }

  findByJobId(db: Db, jobId: string) {
    return db.submission.findUnique({ where: { judge_job_id: jobId } });
  }

  /** Locks the row until the transaction ends; result callbacks and re-judges take turns. */
  async lock(db: Db, id: string): Promise<void> {
    await db.$queryRaw`SELECT id FROM submissions WHERE id = ${id}::uuid FOR UPDATE`;
  }

  async list(db: Db, filter: { problemId: string; userId?: string; skip: number; take: number }) {
    const where: Prisma.SubmissionWhereInput = {
      problem_id: filter.problemId,
      ...(filter.userId ? { user_id: filter.userId } : {}),
    };
    const [rows, total] = await Promise.all([
      db.submission.findMany({
        where,
        include: FOR_DISPLAY,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: filter.skip,
        take: filter.take,
      }),
      db.submission.count({ where }),
    ]);
    return { rows, total };
  }

  /** Queued submissions that Judge has not accepted yet and are due for another try. */
  dueForDispatch(db: Db, now: Date, take: number) {
    return db.submission.findMany({
      where: { status: 'queued', dispatched_at: null, next_dispatch_at: { lte: now } },
      orderBy: { next_dispatch_at: 'asc' },
      take,
      select: { id: true },
    });
  }

  /** Assigns the job id once; returns the id that is now stored. */
  async assignJobId(db: Db, id: string, candidate: string): Promise<string> {
    await db.submission.updateMany({
      where: { id, judge_job_id: null },
      data: { judge_job_id: candidate },
    });
    const row = await db.submission.findUnique({ where: { id }, select: { judge_job_id: true } });
    return row?.judge_job_id ?? candidate;
  }

  markDispatched(db: Db, id: string, at: Date) {
    return db.submission.updateMany({
      where: { id },
      data: { dispatched_at: at, next_dispatch_at: null, dispatch_attempts: { increment: 1 } },
    });
  }

  scheduleRetry(db: Db, id: string, nextAt: Date) {
    return db.submission.updateMany({
      where: { id, status: 'queued' },
      data: { next_dispatch_at: nextAt, dispatch_attempts: { increment: 1 } },
    });
  }

  markRunning(db: Db, id: string) {
    return db.submission.updateMany({
      where: { id, status: 'queued' },
      data: { status: 'running' },
    });
  }

  complete(db: Db, id: string, completion: SubmissionCompletion) {
    return db.submission.update({
      where: { id },
      data: { status: 'completed', next_dispatch_at: null, ...completion },
    });
  }

  /** Back to the start with a new job id, for a re-check after ISE. */
  reset(db: Db, id: string, jobId: string, nextDispatchAt: Date) {
    return db.submission.update({
      where: { id },
      data: {
        status: SubmissionStatus.queued,
        verdict: null,
        time_ms: null,
        memory_kb: null,
        tests_passed: null,
        compile_message: null,
        error_code: null,
        judge_version: null,
        judged_at: null,
        dispatched_at: null,
        dispatch_attempts: 0,
        judge_job_id: jobId,
        next_dispatch_at: nextDispatchAt,
      },
    });
  }

  deleteResults(db: Db, submissionId: string) {
    return db.submissionTestResult.deleteMany({ where: { submission_id: submissionId } });
  }

  createResults(db: Db, submissionId: string, results: SubmissionResultInput[]) {
    return db.submissionTestResult.createMany({
      data: results.map((result) => ({ ...result, submission_id: submissionId })),
    });
  }
}

export type SubmissionRecord = NonNullable<Awaited<ReturnType<SubmissionRepository['findById']>>>;
export type SubmissionListRow = Awaited<ReturnType<SubmissionRepository['list']>>['rows'][number];
