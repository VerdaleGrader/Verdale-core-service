import { Verdict, VerificationStatus } from '../../generated/prisma/enums';
import { Db, Prisma } from '@/repositories/db';

const WITH_REQUESTER = {
  requested_by: { select: { username: true, display_name: true, avatar_url: true } },
} as const;

export interface RunFinish {
  status: 'passed' | 'failed' | 'error';
  verdict: Verdict | null;
  reason: string | null;
  results: Prisma.InputJsonValue;
  tests_passed: number | null;
  max_time_ms: number | null;
  max_memory_kb: number | null;
}

export default class VerificationRepository {
  create(
    db: Db,
    data: {
      problem_version_id: string;
      requested_by_id: string;
      content_hash: string;
      tests_total: number;
      deadline_at: Date;
      next_dispatch_at: Date;
    }
  ) {
    return db.verificationRun.create({ data, include: WITH_REQUESTER });
  }

  find(db: Db, id: string) {
    return db.verificationRun.findUnique({ where: { id }, include: WITH_REQUESTER });
  }

  findByJobId(db: Db, jobId: string) {
    return db.verificationRun.findUnique({
      where: { judge_job_id: jobId },
      include: WITH_REQUESTER,
    });
  }

  latestFor(db: Db, versionId: string) {
    return db.verificationRun.findFirst({
      where: { problem_version_id: versionId },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      include: WITH_REQUESTER,
    });
  }

  findOpen(db: Db, versionId: string) {
    return db.verificationRun.findFirst({
      where: { problem_version_id: versionId, status: { in: ['queued', 'running'] } },
    });
  }

  async lock(db: Db, id: string): Promise<void> {
    await db.$queryRaw`SELECT id FROM verification_runs WHERE id = ${id}::uuid FOR UPDATE`;
  }

  /** Stored before the request goes out: Judge may call back before we hear its answer. */
  assignJobId(db: Db, id: string, jobId: string) {
    return db.verificationRun.update({
      where: { id },
      data: { judge_job_id: jobId, attempts: { increment: 1 } },
    });
  }

  markDispatched(db: Db, id: string) {
    return db.verificationRun.update({
      where: { id },
      data: { status: 'running', next_dispatch_at: null },
    });
  }

  scheduleRetry(db: Db, id: string, at: Date) {
    return db.verificationRun.update({ where: { id }, data: { next_dispatch_at: at } });
  }

  finish(db: Db, id: string, data: RunFinish, at: Date) {
    return db.verificationRun.update({
      where: { id },
      data: { ...data, finished_at: at, next_dispatch_at: null },
    });
  }

  /** Runs still waiting for Judge to accept them. */
  dueForDispatch(db: Db, now: Date, limit: number) {
    return db.verificationRun.findMany({
      where: { status: 'queued', next_dispatch_at: { lte: now } },
      orderBy: { next_dispatch_at: 'asc' },
      take: limit,
      select: { id: true },
    });
  }

  /** Runs that are still open after their deadline. */
  overdue(db: Db, now: Date, limit: number) {
    return db.verificationRun.findMany({
      where: {
        status: { in: ['queued', 'running'] as VerificationStatus[] },
        deadline_at: { lte: now },
      },
      orderBy: { deadline_at: 'asc' },
      take: limit,
      select: { id: true },
    });
  }
}

export type VerificationRunRecord = NonNullable<
  Awaited<ReturnType<VerificationRepository['find']>>
>;
