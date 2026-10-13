import { ProblemHistoryType, ProblemVersionStatus } from '../../generated/prisma/enums';
import { Db, Prisma } from '@/repositories/db';

const WITH_ACTOR = {
  actor: { select: { username: true, display_name: true, avatar_url: true } },
} as const;

export interface HistoryInput {
  problem_id: string;
  problem_version_id: string | null;
  type: ProblemHistoryType;
  actor_id: string;
  at: Date;
  label: string;
  forced?: boolean;
  changes?: Prisma.InputJsonValue;
  state_from?: ProblemVersionStatus | null;
  state_to?: ProblemVersionStatus | null;
}

export default class HistoryRepository {
  add(db: Db, data: HistoryInput) {
    return db.problemHistory.create({
      data: { ...data, changes: data.changes ?? [], forced: data.forced ?? false },
    });
  }

  async list(db: Db, problemId: string, skip: number, take: number) {
    const [rows, total] = await Promise.all([
      db.problemHistory.findMany({
        where: { problem_id: problemId },
        include: WITH_ACTOR,
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      db.problemHistory.count({ where: { problem_id: problemId } }),
    ]);
    return { rows, total };
  }
}
