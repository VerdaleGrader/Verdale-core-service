import type { AiProvider, AiTestJobStatus } from '../../generated/prisma/enums';
import { Db } from '@/repositories/db';

const WITH_ITEMS = {
  items: { orderBy: [{ position: 'asc' as const }, { id: 'asc' as const }] },
};

const ACTIVE: AiTestJobStatus[] = ['generating', 'computing'];

export interface NewAiTestItem {
  position: number;
  status: 'pending' | 'skipped';
  input_sha256: string | null;
  input_size_bytes: number | null;
  skip_reason: string | null;
}

export default class AiTestRepository {
  create(
    db: Db,
    data: {
      problem_version_id: string;
      created_by_id: string;
      provider: AiProvider;
      requested_count: number;
      categories: string[];
      include_solution: boolean;
      deadline_at: Date;
    }
  ) {
    return db.aiTestJob.create({ data, include: WITH_ITEMS });
  }

  find(db: Db, id: string) {
    return db.aiTestJob.findUnique({ where: { id }, include: WITH_ITEMS });
  }

  findByJudgeJob(db: Db, judgeJobId: string) {
    return db.aiTestJob.findUnique({ where: { judge_job_id: judgeJobId }, select: { id: true } });
  }

  findActive(db: Db, versionId: string) {
    return db.aiTestJob.findFirst({
      where: { problem_version_id: versionId, status: { in: ACTIVE } },
      select: { id: true },
    });
  }

  async lock(db: Db, jobId: string): Promise<void> {
    await db.$queryRaw`SELECT id FROM ai_test_jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
  }

  listActiveIds(db: Db) {
    return db.aiTestJob.findMany({ where: { status: { in: ACTIVE } }, select: { id: true } });
  }

  createItems(db: Db, jobId: string, items: NewAiTestItem[]) {
    return db.aiTestItem.createManyAndReturn({
      data: items.map((item) => ({ job_id: jobId, ...item })),
    });
  }

  setComputing(db: Db, jobId: string, judgeJobId: string) {
    return db.aiTestJob.update({
      where: { id: jobId },
      data: { status: 'computing', judge_job_id: judgeJobId },
    });
  }

  finish(
    db: Db,
    jobId: string,
    data: {
      status: 'completed' | 'failed';
      error_code?: string | null;
      error_message?: string | null;
    },
    at: Date
  ) {
    return db.aiTestJob.update({
      where: { id: jobId },
      data: { error_code: null, error_message: null, ...data, finished_at: at },
    });
  }

  markItem(
    db: Db,
    itemId: string,
    data:
      | { status: 'ok'; output_sha256: string; output_size_bytes: number }
      | { status: 'skipped'; skip_reason: string }
  ) {
    return db.aiTestItem.update({ where: { id: itemId }, data });
  }

  deleteOlderThan(db: Db, before: Date) {
    return db.aiTestJob.deleteMany({ where: { created_at: { lt: before } } });
  }
}
