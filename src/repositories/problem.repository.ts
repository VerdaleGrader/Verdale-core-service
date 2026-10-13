import {
  Language,
  ProblemStatus,
  ProblemVersionStatus,
  StatementMode,
} from '../../generated/prisma/enums';
import { Db, Prisma } from '@/repositories/db';

const WITH_AUTHOR = {
  created_by: { select: { username: true, display_name: true, avatar_url: true } },
} as const;

export interface ProblemListFilter {
  spaceId: string;
  q?: string;
  statuses: ProblemStatus[];
  createdById?: string;
  /** Extra condition, e.g. "sits in a Track the viewer can see" for solvers (GRD-81). */
  and?: Prisma.ProblemWhereInput;
  skip: number;
  take: number;
}

/** Versions that are still being worked on: at most one per problem. */
export const IN_PROGRESS: ProblemVersionStatus[] = ['draft', 'verifying', 'verified'];

export interface VersionContent {
  title?: string;
  statement?: string;
  statement_mode?: StatementMode;
  statement_pdf_sha256?: string | null;
  statement_pdf_size_bytes?: number | null;
  statement_pdf_pages?: number | null;
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

  /** The version in progress (draft, verifying or verified), if any; at most one exists. */
  findDraftVersion(db: Db, problemId: string) {
    return db.problemVersion.findFirst({
      where: { problem_id: problemId, status: { in: IN_PROGRESS } },
    });
  }

  setVersionStatus(db: Db, id: string, status: ProblemVersionStatus) {
    return db.problemVersion.update({ where: { id }, data: { status } });
  }

  /** Minor update: the new content and the next Minor number in one write. */
  applyMinor(db: Db, id: string, data: VersionContent) {
    return db.problemVersion.update({ where: { id }, data: { ...data, minor: { increment: 1 } } });
  }

  deleteVersion(db: Db, id: string) {
    return db.problemVersion.delete({ where: { id } });
  }

  /**
   * A draft of the next Major: a row for `source`'s content (Minor fields, PDF,
   * limits, languages) with Major + 1 and Minor 0; tests and reference
   * solutions are copied by `copyChildren`.
   */
  createDraftFrom(
    db: Db,
    source: {
      problem_id: string;
      version_number: number;
      title: string;
      statement: string;
      statement_mode: StatementMode;
      statement_pdf_sha256: string | null;
      statement_pdf_size_bytes: number | null;
      statement_pdf_pages: number | null;
      time_limit_ms: number;
      memory_limit_kb: number;
      allowed_languages: Language[];
    }
  ) {
    return db.problemVersion.create({
      data: {
        problem_id: source.problem_id,
        version_number: source.version_number + 1,
        minor: 0,
        status: 'draft',
        title: source.title,
        statement: source.statement,
        statement_mode: source.statement_mode,
        statement_pdf_sha256: source.statement_pdf_sha256,
        statement_pdf_size_bytes: source.statement_pdf_size_bytes,
        statement_pdf_pages: source.statement_pdf_pages,
        time_limit_ms: source.time_limit_ms,
        memory_limit_kb: source.memory_limit_kb,
        allowed_languages: source.allowed_languages,
      },
    });
  }

  /** Copies the test cases and reference solutions of one version into another (new rows, same files). */
  async copyChildren(db: Db, fromId: string, toId: string): Promise<void> {
    await db.$executeRaw`
      INSERT INTO "test_cases" ("id", "problem_version_id", "position", "input_sha256", "output_sha256",
                                "input_size_bytes", "output_size_bytes", "is_sample", "updated_at")
      SELECT gen_random_uuid(), ${toId}::uuid, "position", "input_sha256", "output_sha256",
             "input_size_bytes", "output_size_bytes", "is_sample", CURRENT_TIMESTAMP
      FROM "test_cases" WHERE "problem_version_id" = ${fromId}::uuid`;
    await db.$executeRaw`
      INSERT INTO "reference_solutions" ("id", "problem_version_id", "created_by_id", "language", "source",
                                         "source_bytes", "is_primary", "updated_at")
      SELECT gen_random_uuid(), ${toId}::uuid, "created_by_id", "language", "source",
             "source_bytes", "is_primary", CURRENT_TIMESTAMP
      FROM "reference_solutions" WHERE "problem_version_id" = ${fromId}::uuid`;
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
      ...(filter.and ? { AND: [filter.and] } : {}),
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
