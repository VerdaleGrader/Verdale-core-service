import type { Prisma as PrismaTypes } from '../../generated/prisma/client';
import { Db, Prisma } from '@/repositories/db';

export type AuditAction =
  | 'admin.granted'
  | 'admin.revoked'
  | 'problem.unpublished'
  | 'problem.restored'
  | 'space.suspended'
  | 'space.restored'
  | 'user.suspended'
  | 'user.restored'
  | 'user.submissions_suspended'
  | 'user.submissions_resumed'
  | 'report.resolved';

export type AuditTargetType = 'problem' | 'space' | 'user' | 'report';

const REPORT_INCLUDE = {
  reporter: { select: { username: true, display_name: true } },
  resolved_by: { select: { username: true } },
  problem: {
    select: {
      id: true,
      slug: true,
      status: true,
      suspended_at: true,
      space: { select: { slug: true } },
      current_version: { select: { title: true } },
    },
  },
} satisfies PrismaTypes.ProblemReportInclude;

export type ReportRecord = PrismaTypes.ProblemReportGetPayload<{ include: typeof REPORT_INCLUDE }>;

const AUDIT_INCLUDE = {
  actor: { select: { username: true } },
} satisfies PrismaTypes.PlatformAuditLogInclude;

export type AuditRecord = PrismaTypes.PlatformAuditLogGetPayload<{ include: typeof AUDIT_INCLUDE }>;

/** Reports of problems and the platform audit log (GRD-58). */
export default class PlatformRepository {
  // --- reports ------------------------------------------------------------

  findOpenReport(db: Db, reporterId: string, problemId: string) {
    return db.problemReport.findFirst({
      where: { reporter_id: reporterId, problem_id: problemId, status: 'open' },
    });
  }

  createReport(
    db: Db,
    data: {
      problem_id: string;
      reporter_id: string;
      category: 'abuse' | 'copyright' | 'cheating' | 'other';
      reason: string;
    }
  ) {
    return db.problemReport.create({ data });
  }

  findReport(db: Db, id: string) {
    return db.problemReport.findUnique({ where: { id }, include: REPORT_INCLUDE });
  }

  async listReports(
    db: Db,
    filter: { status: 'open' | 'dismissed' | 'actioned' | 'all'; skip: number; take: number }
  ) {
    const where: PrismaTypes.ProblemReportWhereInput =
      filter.status === 'all' ? {} : { status: filter.status };
    const [rows, total] = await Promise.all([
      db.problemReport.findMany({
        where,
        include: REPORT_INCLUDE,
        // Waiting reports: the oldest first, so nothing is forgotten. Resolved ones: the newest first.
        orderBy: [{ created_at: filter.status === 'open' ? 'asc' : 'desc' }, { id: 'asc' }],
        skip: filter.skip,
        take: filter.take,
      }),
      db.problemReport.count({ where }),
    ]);
    return { rows, total };
  }

  resolveReport(
    db: Db,
    id: string,
    data: {
      status: 'dismissed' | 'actioned';
      resolved_by_id: string;
      resolution_note: string | null;
      resolved_at: Date;
    }
  ) {
    return db.problemReport.update({ where: { id }, data });
  }

  // --- audit log ----------------------------------------------------------

  record(
    db: Db,
    entry: {
      actor_id: string | null;
      action: AuditAction;
      target_type: AuditTargetType;
      target_id: string | null;
      target_label: string;
      data?: PrismaTypes.InputJsonObject;
    }
  ) {
    return db.platformAuditLog.create({ data: { ...entry, data: entry.data ?? {} } });
  }

  async listAudit(
    db: Db,
    filter: {
      target_type?: AuditTargetType;
      target_id?: string;
      actor_id?: string;
      skip: number;
      take: number;
    }
  ) {
    const where: PrismaTypes.PlatformAuditLogWhereInput = {
      ...(filter.target_type ? { target_type: filter.target_type } : {}),
      ...(filter.target_id ? { target_id: filter.target_id } : {}),
      ...(filter.actor_id ? { actor_id: filter.actor_id } : {}),
    };
    const [rows, total] = await Promise.all([
      db.platformAuditLog.findMany({
        where,
        include: AUDIT_INCLUDE,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: filter.skip,
        take: filter.take,
      }),
      db.platformAuditLog.count({ where }),
    ]);
    return { rows, total };
  }
}

export { Prisma };
