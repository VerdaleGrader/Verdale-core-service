import type { FastifyReply, FastifyRequest } from 'fastify';
import PlatformAdminService from '@/services/platform/platform-admin.service';
import ReportService from '@/services/platform/report.service';
import {
  adminAuditQuery,
  adminReportsQuery,
  problemSlugParams,
  reportParams,
  reportProblemBody,
  resolveReportBody,
  slugParams,
  suspendBody,
  usernameParams,
} from '@/validation/schemas';
import { requireUser } from '@/middleware/session';

/** POST .../report: any signed-in person who can see a problem may report it. */
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  async report(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    const created = await this.reportService.report(
      user,
      slug,
      problemSlug,
      reportProblemBody.parse(request.body),
      request.id
    );
    return reply.status(201).send(created);
  }
}

/**
 * /api/v1/admin/*: platform administrators only. Anybody else, signed in or not, sees what they
 * would see for a route that does not exist (the service answers 404, or 401 for a visitor).
 */
export default class PlatformAdminController {
  constructor(private readonly admin: PlatformAdminService) {}

  async listReports(request: FastifyRequest, reply: FastifyReply) {
    const user = this.admin.assertAdmin(request.currentUser);
    return reply.send(await this.admin.listReports(user, adminReportsQuery.parse(request.query)));
  }

  async resolveReport(request: FastifyRequest, reply: FastifyReply) {
    const user = this.admin.assertAdmin(request.currentUser);
    const { reportId } = reportParams.parse(request.params);
    return reply.send(
      await this.admin.resolveReport(user, reportId, resolveReportBody.parse(request.body))
    );
  }

  async unpublishProblem(request: FastifyRequest, reply: FastifyReply) {
    const user = this.admin.assertAdmin(request.currentUser);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    const { reason } = suspendBody.parse(request.body);
    return reply.send(await this.admin.unpublishProblem(user, slug, problemSlug, reason));
  }

  async restoreProblem(request: FastifyRequest, reply: FastifyReply) {
    const user = this.admin.assertAdmin(request.currentUser);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    return reply.send(await this.admin.restoreProblem(user, slug, problemSlug));
  }

  async suspendSpace(request: FastifyRequest, reply: FastifyReply) {
    const user = this.admin.assertAdmin(request.currentUser);
    const { slug } = slugParams.parse(request.params);
    const { reason } = suspendBody.parse(request.body);
    return reply.send(await this.admin.suspendSpace(user, slug, reason));
  }

  async restoreSpace(request: FastifyRequest, reply: FastifyReply) {
    const user = this.admin.assertAdmin(request.currentUser);
    const { slug } = slugParams.parse(request.params);
    return reply.send(await this.admin.restoreSpace(user, slug));
  }

  async suspendUser(request: FastifyRequest, reply: FastifyReply) {
    const user = this.admin.assertAdmin(request.currentUser);
    const { username } = usernameParams.parse(request.params);
    const { reason } = suspendBody.parse(request.body);
    return reply.send(await this.admin.suspendUser(user, username, reason));
  }

  async restoreUser(request: FastifyRequest, reply: FastifyReply) {
    const user = this.admin.assertAdmin(request.currentUser);
    const { username } = usernameParams.parse(request.params);
    return reply.send(await this.admin.restoreUser(user, username));
  }

  async suspendSubmissions(request: FastifyRequest, reply: FastifyReply) {
    const user = this.admin.assertAdmin(request.currentUser);
    const { username } = usernameParams.parse(request.params);
    const { reason } = suspendBody.parse(request.body);
    return reply.send(await this.admin.suspendSubmissions(user, username, reason));
  }

  async resumeSubmissions(request: FastifyRequest, reply: FastifyReply) {
    const user = this.admin.assertAdmin(request.currentUser);
    const { username } = usernameParams.parse(request.params);
    return reply.send(await this.admin.resumeSubmissions(user, username));
  }

  async listAudit(request: FastifyRequest, reply: FastifyReply) {
    const user = this.admin.assertAdmin(request.currentUser);
    return reply.send(await this.admin.listAudit(user, adminAuditQuery.parse(request.query)));
  }
}
