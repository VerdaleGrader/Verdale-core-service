import { Language, ProblemStatus } from '../../generated/prisma/enums';
import { Db, Prisma } from '@/repositories/db';
import { PUBLIC_USER_SELECT } from '@/services/user/user.mapper';

const WITH_AUTHOR = { created_by: { select: PUBLIC_USER_SELECT } } as const;

export interface ProblemListFilter {
  spaceId: string;
  q?: string;
  statuses: ProblemStatus[];
  createdById?: string;
  skip: number;
  take: number;
}

export interface VersionContent {
  title?: string;
  statement?: string;
  time_limit_ms?: number;
  memory_limit_kb?: number;
  allowed_languages?: Language[];
}

export default class ProblemRepository {
  /** The problem with its current version and author, or null. */
  findBySlug(db: Db, spaceId: string, slug: string) {
    return db.problem.findUnique({
      where: { space_id_slug: { space_id: spaceId, slug } },
      include: { current_version: true, ...WITH_AUTHOR },
    });
  }

  findById(db: Db, id: string) {
    return db.problem.findUnique({
      where: { id },
      include: { current_version: true, ...WITH_AUTHOR },
    });
  }

  /** Marks the problem as changed (list order) without changing any column. */
  touch(db: Db, id: string) {
    return db.problem.update({ where: { id }, data: { updated_at: new Date() } });
  }

  async isSlugTaken(db: Db, spaceId: string, slug: string): Promise<boolean> {
    const found = await db.problem.findUnique({
      where: { space_id_slug: { space_id: spaceId, slug } },
      select: { id: true },
    });
    return found !== null;
  }

  create(db: Db, data: { space_id: string; created_by_id: string; slug: string }) {
    return db.problem.create({ data });
  }

  createVersion(
    db: Db,
    data: {
      problem_id: string;
      version_number: number;
      title: string;
      statement: string;
      time_limit_ms: number;
      memory_limit_kb: number;
      allowed_languages: Language[];
    }
  ) {
    return db.problemVersion.create({ data });
  }

  update(
    db: Db,
    id: string,
    data: {
      status?: ProblemStatus;
      current_version_id?: string | null;
      archived_at?: Date | null;
    }
  ) {
    return db.problem.update({ where: { id }, data });
  }

  delete(db: Db, id: string) {
    return db.problem.delete({ where: { id } });
  }

  /** Serialises everything that changes one problem (edits, tests, publish) until the transaction ends. */
  async lock(db: Db, problemId: string): Promise<void> {
    await db.$queryRaw`SELECT id FROM problems WHERE id = ${problemId}::uuid FOR UPDATE`;
  }

  findDraftVersion(db: Db, problemId: string) {
    return db.problemVersion.findFirst({ where: { problem_id: problemId, status: 'draft' } });
  }

  findVersion(db: Db, id: string) {
    return db.problemVersion.findUnique({ where: { id } });
  }

  countPublishedVersions(db: Db, problemId: string) {
    return db.problemVersion.count({ where: { problem_id: problemId, status: 'published' } });
  }

  updateVersion(db: Db, id: string, data: VersionContent) {
    return db.problemVersion.update({ where: { id }, data });
  }

  markVersionPublished(db: Db, id: string, at: Date) {
    return db.problemVersion.update({
      where: { id },
      data: { status: 'published', published_at: at },
    });
  }

  async list(db: Db, filter: ProblemListFilter) {
    const where: Prisma.ProblemWhereInput = {
      space_id: filter.spaceId,
      status: { in: filter.statuses },
      ...(filter.createdById ? { created_by_id: filter.createdById } : {}),
      ...(filter.q
        ? {
            OR: [
              { slug: { contains: filter.q, mode: 'insensitive' } },
              { current_version: { title: { contains: filter.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.problem.findMany({
        where,
        include: { current_version: true, ...WITH_AUTHOR },
        orderBy: [{ updated_at: 'desc' }, { id: 'asc' }],
        skip: filter.skip,
        take: filter.take,
      }),
      db.problem.count({ where }),
    ]);
    return { rows, total };
  }
}

export type ProblemWithVersion = NonNullable<Awaited<ReturnType<ProblemRepository['findBySlug']>>>;
