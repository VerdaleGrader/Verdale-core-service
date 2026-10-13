import { Language, SubmissionStatus, TestVerdict, Verdict } from '../../generated/prisma/enums';
import { Db, Prisma } from '@/repositories/db';

const FOR_DISPLAY = {
  user: { select: { username: true, display_name: true, avatar_url: true } },
  problem: { select: { slug: true, space_id: true, status: true } },
  version: { select: { title: true } },
} as const;

/** Just enough of each test to draw a progress bar: no times, no previews. */
const WITH_VERDICTS = {
  ...FOR_DISPLAY,
  results: { orderBy: { position: 'asc' as const }, select: { position: true, verdict: true } },
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
  /** What the program printed, kept for staff only (GRD-93); null when Judge sent none. */
  output?: {
    stdout: string | null;
    stdout_size_bytes: number | null;
    stderr: string | null;
    stderr_size_bytes: number | null;
  } | null;
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
      track_id?: string | null;
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
        include: WITH_VERDICTS,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: filter.skip,
        take: filter.take,
      }),
      db.submission.count({ where }),
    ]);
    return { rows, total };
  }

  /**
   * The best finished submission of one user for a problem: the most tests passed, and among
   * equals the one sent first. A submission that is still queued or running, ended in a system
   * error, or passed no test is never the best.
   */
  findBest(db: Db, userId: string, problemId: string) {
    return db.submission.findFirst({
      where: {
        user_id: userId,
        problem_id: problemId,
        status: 'completed',
        verdict: { not: 'ISE' },
        tests_passed: { gt: 0 },
      },
      include: WITH_VERDICTS,
      orderBy: [{ tests_passed: 'desc' }, { created_at: 'asc' }, { id: 'asc' }],
    });
  }

  /** For each user, the problems among `problemIds` that they solved (an AC on any version). */
  async solvedBy(
    db: Db,
    userIds: string[],
    problemIds: string[]
  ): Promise<Map<string, Set<string>>> {
    const solved = new Map<string, Set<string>>(userIds.map((id) => [id, new Set<string>()]));
    if (userIds.length === 0 || problemIds.length === 0) return solved;
    const rows = await db.submission.findMany({
      where: { user_id: { in: userIds }, problem_id: { in: problemIds }, verdict: 'AC' },
      distinct: ['user_id', 'problem_id'],
      select: { user_id: true, problem_id: true },
    });
    for (const row of rows) solved.get(row.user_id)?.add(row.problem_id);
    return solved;
  }

  /** The verdict of the latest finished submission of each problem, for one user. */
  async latestVerdicts(
    db: Db,
    userId: string,
    problemIds: string[]
  ): Promise<Map<string, Verdict>> {
    if (problemIds.length === 0) return new Map();
    const rows = await db.submission.findMany({
      where: { user_id: userId, problem_id: { in: problemIds }, status: 'completed' },
      orderBy: [{ problem_id: 'asc' }, { created_at: 'desc' }, { id: 'desc' }],
      distinct: ['problem_id'],
      select: { problem_id: true, verdict: true },
    });
    return new Map(
      rows.flatMap((row) => (row.verdict ? [[row.problem_id, row.verdict] as const] : []))
    );
  }

  /** Has this user ever submitted to the problem? (Keeps their history readable after it leaves every Track.) */
  async hasSubmitted(db: Db, userId: string, problemId: string): Promise<boolean> {
    const found = await db.submission.findFirst({
      where: { user_id: userId, problem_id: problemId },
      select: { id: true },
    });
    return found !== null;
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

  async createResults(db: Db, submissionId: string, results: SubmissionResultInput[]) {
    for (const { output, ...result } of results) {
      await db.submissionTestResult.create({
        data: {
          ...result,
          submission_id: submissionId,
          ...(output ? { output: { create: output } } : {}),
        },
      });
    }
  }
}

export type SubmissionRecord = NonNullable<Awaited<ReturnType<SubmissionRepository['findById']>>>;
export type SubmissionListRow = Awaited<ReturnType<SubmissionRepository['list']>>['rows'][number];
