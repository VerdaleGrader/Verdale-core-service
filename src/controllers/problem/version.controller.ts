import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from '@/middleware/session';
import VerificationService from '@/services/problem/verification.service';
import VersionService from '@/services/problem/version.service';
import { historyQuery, problemSlugParams, publishedUpdateBody } from '@/validation/schemas';

/** The publish gate and versions (GRD-50 to GRD-54, GRD-116, GRD-117). */
export default class VersionController {
  constructor(
    private readonly verification: VerificationService,
    private readonly versions: VersionService
  ) {}

  /** POST /api/v1/spaces/:slug/problems/:problemSlug/verify */
  async verify(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    return reply
      .status(202)
      .send(await this.verification.start(user, slug, problemSlug, request.id));
  }

  /** GET /api/v1/spaces/:slug/problems/:problemSlug/verify */
  async getVerification(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    return reply.send(await this.verification.latest(user, slug, problemSlug));
  }

  /** POST /api/v1/spaces/:slug/problems/:problemSlug/updates */
  async update(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    // The permission is checked inside the service before the body matters; a body that is
    // invalid for a solver is still a 400 here, which tells nobody anything about the problem.
    return reply.send(
      await this.versions.updatePublished(
        user,
        slug,
        problemSlug,
        publishedUpdateBody.parse(request.body),
        request.id
      )
    );
  }

  /** POST /api/v1/spaces/:slug/problems/:problemSlug/draft */
  async createDraft(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    return reply
      .status(201)
      .send(await this.versions.createMajorDraft(user, slug, problemSlug, request.id));
  }

  /** DELETE /api/v1/spaces/:slug/problems/:problemSlug/draft */
  async discardDraft(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    return reply.send(await this.versions.discardMajorDraft(user, slug, problemSlug, request.id));
  }

  /** GET /api/v1/spaces/:slug/problems/:problemSlug/history */
  async history(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    return reply.send(
      await this.versions.historyOf(user, slug, problemSlug, historyQuery.parse(request.query))
    );
  }
}
