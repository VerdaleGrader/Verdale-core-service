import {
  GenerateJobStatus,
  GenerateRunStatus,
  Language,
  TestVerdict,
} from '../../generated/prisma/enums';
import { Db } from '@/repositories/db';

const WITH_RUNS = {
  runs: { orderBy: [{ position: 'asc' as const }, { id: 'asc' as const }] },
};

export default class GenerateRepository {
  create(
    db: Db,
    data: {
      problem_version_id: string;
      created_by_id: string;
      language: Language;
      source: string;
      deadline_at: Date;
      runs: Array<{ test_case_id: string; position: number }>;
    }
  ) {
    const { runs, ...job } = data;
    return db.generateJob.create({
      data: { ...job, runs: { create: runs } },
      include: WITH_RUNS,
    });
  }

  find(db: Db, id: string) {
    return db.generateJob.findUnique({ where: { id }, include: WITH_RUNS });
  }

  findRunning(db: Db, versionId: string) {
    return db.generateJob.findFirst({
      where: { problem_version_id: versionId, status: 'running' },
      select: { id: true },
    });
  }

  findRunByJudgeJob(db: Db, judgeJobId: string) {
    return db.generateRun.findUnique({ where: { judge_job_id: judgeJobId } });
  }

  async lock(db: Db, jobId: string): Promise<void> {
    await db.$queryRaw`SELECT id FROM generate_jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
  }

  listRunningJobIds(db: Db) {
    return db.generateJob.findMany({ where: { status: 'running' }, select: { id: true } });
  }

  finishJob(
    db: Db,
    id: string,
    data: { status: GenerateJobStatus; error_code?: string | null; error_message?: string | null },
    at: Date
  ) {
    return db.generateJob.update({ where: { id }, data: { ...data, finished_at: at } });
  }

  claimRun(db: Db, id: string, judgeJobId: string) {
    return db.generateRun.update({
      where: { id },
      data: {
        status: 'running',
        judge_job_id: judgeJobId,
        attempts: { increment: 1 },
        next_dispatch_at: null,
      },
    });
  }

  /** Back to the queue (Judge was away, or the author stopped the job). */
  requeueRun(db: Db, id: string, nextDispatchAt: Date | null) {
    return db.generateRun.update({
      where: { id },
      data: { status: 'queued', judge_job_id: null, next_dispatch_at: nextDispatchAt },
    });
  }

  finishRun(
    db: Db,
    id: string,
    data: {
      status: Extract<GenerateRunStatus, 'done' | 'failed'>;
      verdict?: TestVerdict | null;
      time_ms?: number | null;
      memory_kb?: number | null;
      stderr?: string | null;
      output_sha256?: string | null;
      output_size_bytes?: number | null;
      same_as_current?: boolean | null;
      error_code?: string | null;
    },
    at: Date
  ) {
    return db.generateRun.update({ where: { id }, data: { ...data, finished_at: at } });
  }

  deleteOlderThan(db: Db, cutoff: Date) {
    return db.generateJob.deleteMany({ where: { created_at: { lt: cutoff } } });
  }
}

export type GenerateJobRecord = NonNullable<Awaited<ReturnType<GenerateRepository['find']>>>;
