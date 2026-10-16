import type { PrismaClient, User } from '../../../generated/prisma/client';
import { ConflictError, NotFoundError, UnauthorizedError } from '@/errors';
import TLogger, { Layer } from '@/logging/logger';
import PlatformRepository, { AuditAction } from '@/repositories/platform.repository';
import { Page } from '@/services/space/space.mapper';
import {
  AuditEntryDto,
  ReportDto,
  toAuditEntryDto,
  toReportDto,
} from '@/services/platform/platform.mapper';

export type PlatformRoleName = 'user' | 'admin';

/**
 * What the platform administrators can do (GRD-58): read the reports of problems, take a
 * problem down, suspend a Space, a user, or only a user's submissions, and read the audit
 * log of all that. Nothing here is reachable by a Space role, and nothing is deleted: every
 * action can be undone, and every action is recorded.
 *
 * The role is given on the command line only (`setPlatformRole`), never through the API,
 * so there is no request that turns an account into an administrator.
 */
export default class PlatformAdminService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly platform: PlatformRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Administrators only. Everybody else gets "not found", as for a route that does not exist:
   * the admin API does not announce itself.
   */
  assertAdmin(user: User | null): User {
    if (!user) throw new UnauthorizedError('Please log in.');
    if (user.platform_role !== 'admin' || user.suspended_at !== null) {
      throw new NotFoundError('Route not found.');
    }
    return user;
  }

  // --- reports ------------------------------------------------------------

  async listReports(
    admin: User,
    input: { status: 'open' | 'dismissed' | 'actioned' | 'all'; page: number; page_size: number }
  ): Promise<Page<ReportDto>> {
    this.assertAdmin(admin);
    const { rows, total } = await this.platform.listReports(this.prisma, {
      status: input.status,
      skip: (input.page - 1) * input.page_size,
      take: input.page_size,
    });
    return { items: rows.map(toReportDto), page: input.page, page_size: input.page_size, total };
  }

  async resolveReport(
    admin: User,
    reportId: string,
    input: { outcome: 'dismissed' | 'actioned'; note?: string }
  ): Promise<ReportDto> {
    this.assertAdmin(admin);
    return this.prisma.$transaction(async (tx) => {
      const report = await this.platform.findReport(tx, reportId);
      if (!report) throw new NotFoundError('Report not found.');
      if (report.status !== 'open') {
        throw new ConflictError('This report has already been resolved.', 'REPORT_RESOLVED');
      }
      await this.platform.resolveReport(tx, reportId, {
        status: input.outcome,
        resolved_by_id: admin.id,
        resolution_note: input.note ?? null,
        resolved_at: this.now(),
      });
      await this.audit(
        tx,
        admin,
        'report.resolved',
        'report',
        report.id,
        `report of ${report.problem.space.slug}/${report.problem.slug}`,
        {
          outcome: input.outcome,
          note: input.note ?? null,
        }
      );
      return toReportDto((await this.platform.findReport(tx, reportId))!);
    });
  }

  // --- problems -----------------------------------------------------------

  /**
   * Takes a published problem down at once. It becomes a draft for everybody who is not staff of
   * its Space (solvers, outsiders and visitors get "not found"; submissions are refused); its
   * published version is not touched, and its authors cannot publish it again. Restoring puts it back.
   */
  async unpublishProblem(admin: User, slug: string, problemSlug: string, reason: string) {
    this.assertAdmin(admin);
    return this.prisma.$transaction(async (tx) => {
      const problem = await this.findProblem(tx, slug, problemSlug);
      if (problem.suspended_at !== null) {
        throw new ConflictError('This problem is already taken down.', 'ALREADY_SUSPENDED');
      }
      if (problem.status !== 'published') {
        throw new ConflictError('Only a published problem can be taken down.', 'NOT_PUBLISHED');
      }
      await tx.problem.update({
        where: { id: problem.id },
        data: { status: 'draft', suspended_at: this.now(), suspension_reason: reason },
      });
      await this.audit(
        tx,
        admin,
        'problem.unpublished',
        'problem',
        problem.id,
        `${slug}/${problemSlug}`,
        { reason }
      );
      return { space: slug, slug: problemSlug, suspended: true, status: 'draft' as const };
    });
  }

  async restoreProblem(admin: User, slug: string, problemSlug: string) {
    this.assertAdmin(admin);
    return this.prisma.$transaction(async (tx) => {
      const problem = await this.findProblem(tx, slug, problemSlug);
      if (problem.suspended_at === null) {
        throw new ConflictError('This problem is not taken down.', 'NOT_SUSPENDED');
      }
      await tx.problem.update({
        where: { id: problem.id },
        data: { status: 'published', suspended_at: null, suspension_reason: null },
      });
      await this.audit(
        tx,
        admin,
        'problem.restored',
        'problem',
        problem.id,
        `${slug}/${problemSlug}`
      );
      return { space: slug, slug: problemSlug, suspended: false, status: 'published' as const };
    });
  }

  // --- Spaces -------------------------------------------------------------

  async suspendSpace(admin: User, slug: string, reason: string) {
    this.assertAdmin(admin);
    return this.prisma.$transaction(async (tx) => {
      const space = await this.findSpace(tx, slug);
      if (space.suspended_at !== null) {
        throw new ConflictError('This Space is already suspended.', 'ALREADY_SUSPENDED');
      }
      await tx.space.update({
        where: { id: space.id },
        data: { suspended_at: this.now(), suspension_reason: reason },
      });
      await this.audit(tx, admin, 'space.suspended', 'space', space.id, space.slug, { reason });
      return { slug: space.slug, suspended: true };
    });
  }

  async restoreSpace(admin: User, slug: string) {
    this.assertAdmin(admin);
    return this.prisma.$transaction(async (tx) => {
      const space = await this.findSpace(tx, slug);
      if (space.suspended_at === null) {
        throw new ConflictError('This Space is not suspended.', 'NOT_SUSPENDED');
      }
      await tx.space.update({
        where: { id: space.id },
        data: { suspended_at: null, suspension_reason: null },
      });
      await this.audit(tx, admin, 'space.restored', 'space', space.id, space.slug);
      return { slug: space.slug, suspended: false };
    });
  }

  // --- users --------------------------------------------------------------

  /** Stops the whole account: every call but reading /me and signing out answers 403. */
  async suspendUser(admin: User, username: string, reason: string) {
    this.assertAdmin(admin);
    return this.prisma.$transaction(async (tx) => {
      const user = await this.findUser(tx, username);
      this.assertNotAdmin(user);
      if (user.suspended_at !== null) {
        throw new ConflictError('This account is already suspended.', 'ALREADY_SUSPENDED');
      }
      await tx.user.update({
        where: { id: user.id },
        data: { suspended_at: this.now(), suspension_reason: reason },
      });
      await this.audit(tx, admin, 'user.suspended', 'user', user.id, user.username, { reason });
      return {
        username: user.username,
        suspended: true,
        submissions_suspended: user.submissions_suspended_at !== null,
      };
    });
  }

  async restoreUser(admin: User, username: string) {
    this.assertAdmin(admin);
    return this.prisma.$transaction(async (tx) => {
      const user = await this.findUser(tx, username);
      if (user.suspended_at === null) {
        throw new ConflictError('This account is not suspended.', 'NOT_SUSPENDED');
      }
      await tx.user.update({
        where: { id: user.id },
        data: { suspended_at: null, suspension_reason: null },
      });
      await this.audit(tx, admin, 'user.restored', 'user', user.id, user.username);
      return {
        username: user.username,
        suspended: false,
        submissions_suspended: user.submissions_suspended_at !== null,
      };
    });
  }

  /** Stops only sending code (new submissions and re-checks); the rest of the account works. */
  async suspendSubmissions(admin: User, username: string, reason: string) {
    this.assertAdmin(admin);
    return this.prisma.$transaction(async (tx) => {
      const user = await this.findUser(tx, username);
      this.assertNotAdmin(user);
      if (user.submissions_suspended_at !== null) {
        throw new ConflictError(
          'Submissions of this account are already suspended.',
          'ALREADY_SUSPENDED'
        );
      }
      await tx.user.update({
        where: { id: user.id },
        data: { submissions_suspended_at: this.now(), submissions_suspension_reason: reason },
      });
      await this.audit(tx, admin, 'user.submissions_suspended', 'user', user.id, user.username, {
        reason,
      });
      return {
        username: user.username,
        suspended: user.suspended_at !== null,
        submissions_suspended: true,
      };
    });
  }

  async resumeSubmissions(admin: User, username: string) {
    this.assertAdmin(admin);
    return this.prisma.$transaction(async (tx) => {
      const user = await this.findUser(tx, username);
      if (user.submissions_suspended_at === null) {
        throw new ConflictError('Submissions of this account are not suspended.', 'NOT_SUSPENDED');
      }
      await tx.user.update({
        where: { id: user.id },
        data: { submissions_suspended_at: null, submissions_suspension_reason: null },
      });
      await this.audit(tx, admin, 'user.submissions_resumed', 'user', user.id, user.username);
      return {
        username: user.username,
        suspended: user.suspended_at !== null,
        submissions_suspended: false,
      };
    });
  }

  // --- the audit log ------------------------------------------------------

  async listAudit(
    admin: User,
    input: {
      target_type?: 'problem' | 'space' | 'user' | 'report';
      target_id?: string;
      actor?: string;
      page: number;
      page_size: number;
    }
  ): Promise<Page<AuditEntryDto>> {
    this.assertAdmin(admin);
    let actorId: string | undefined;
    if (input.actor) {
      const actor = await this.prisma.user.findUnique({
        where: { username: input.actor.toLowerCase() },
      });
      // An unknown username matches nothing, rather than everything.
      actorId = actor?.id ?? '00000000-0000-0000-0000-000000000000';
    }
    const { rows, total } = await this.platform.listAudit(this.prisma, {
      target_type: input.target_type,
      target_id: input.target_id,
      actor_id: actorId,
      skip: (input.page - 1) * input.page_size,
      take: input.page_size,
    });
    return {
      items: rows.map(toAuditEntryDto),
      page: input.page,
      page_size: input.page_size,
      total,
    };
  }

  // --- the role (command line only) ---------------------------------------

  /** Gives or takes away the platform role. Called by `npm run platform:grant` and `platform:revoke`, never by a request. */
  async setPlatformRole(username: string, role: PlatformRoleName) {
    return this.prisma.$transaction(async (tx) => {
      const user = await this.findUser(tx, username);
      if (user.platform_role === role) return { username: user.username, role, changed: false };
      await tx.user.update({ where: { id: user.id }, data: { platform_role: role } });
      await this.platform.record(tx, {
        actor_id: null,
        action: role === 'admin' ? 'admin.granted' : 'admin.revoked',
        target_type: 'user',
        target_id: user.id,
        target_label: user.username,
        data: { via: 'command line' },
      });
      this.logger.setContext('service.platform.role', 'cli').info({
        message: `platform role of ${user.username} is now ${role}`,
      });
      return { username: user.username, role, changed: true };
    });
  }

  // --- helpers ------------------------------------------------------------

  private audit(
    tx: Parameters<PlatformRepository['record']>[0],
    admin: User,
    action: AuditAction,
    targetType: 'problem' | 'space' | 'user' | 'report',
    targetId: string,
    label: string,
    data: Record<string, string | null> = {}
  ) {
    return this.platform.record(tx, {
      actor_id: admin.id,
      action,
      target_type: targetType,
      target_id: targetId,
      target_label: label,
      data,
    });
  }

  private assertNotAdmin(user: { platform_role: string }) {
    if (user.platform_role === 'admin') {
      throw new ConflictError(
        'A platform administrator cannot be suspended. Take the role away first.',
        'CANNOT_SUSPEND_ADMIN'
      );
    }
  }

  private async findSpace(tx: Parameters<PlatformRepository['record']>[0], slug: string) {
    const space = await tx.space.findUnique({ where: { slug: slug.toLowerCase() } });
    if (!space) throw new NotFoundError('Space not found.');
    return space;
  }

  private async findProblem(
    tx: Parameters<PlatformRepository['record']>[0],
    slug: string,
    problemSlug: string
  ) {
    const space = await this.findSpace(tx, slug);
    const problem = await tx.problem.findUnique({
      where: { space_id_slug: { space_id: space.id, slug: problemSlug.toLowerCase() } },
    });
    if (!problem) throw new NotFoundError('Problem not found.');
    return problem;
  }

  private async findUser(tx: Parameters<PlatformRepository['record']>[0], username: string) {
    const user = await tx.user.findUnique({ where: { username: username.toLowerCase() } });
    if (!user) throw new NotFoundError('User not found.');
    return user;
  }
}
