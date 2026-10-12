import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from '@/middleware/session';
import SubmissionReviewService from '@/services/submission/submission-review.service';
import {
  byMemberQuery,
  byProblemQuery,
  byTrackQuery,
  memberParams,
  memberProblemsQuery,
  slugParams,
  spaceSubmissionsQuery,
  submissionTestParams,
  testDetailQuery,
  trackParams,
  trackProblemsQuery,
  versionsQuery,
} from '@/validation/schemas';

/** The Space-wide submission pages for owners, administrators, editors and observers (GRD-93). */
export default class SubmissionReviewController {
  constructor(private readonly review: SubmissionReviewService) {}

  /** GET /api/v1/spaces/:slug/submissions */
  async rows(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    return reply.send(
      await this.review.rows(user, slug, spaceSubmissionsQuery.parse(request.query))
    );
  }

  /** GET /api/v1/spaces/:slug/submissions/by-member */
  async byMember(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    return reply.send(await this.review.byMember(user, slug, byMemberQuery.parse(request.query)));
  }

  /** GET /api/v1/spaces/:slug/submissions/by-member/:username/problems */
  async memberProblems(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, username } = memberParams.parse(request.params);
    return reply.send(
      await this.review.memberProblems(
        user,
        slug,
        username,
        memberProblemsQuery.parse(request.query)
      )
    );
  }

  /** GET /api/v1/spaces/:slug/submissions/by-track */
  async byTrack(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    return reply.send(await this.review.byTrack(user, slug, byTrackQuery.parse(request.query)));
  }

  /** GET /api/v1/spaces/:slug/submissions/by-track/:trackSlug/problems */
  async trackProblems(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    return reply.send(
      await this.review.trackProblems(
        user,
        slug,
        trackSlug,
        trackProblemsQuery.parse(request.query)
      )
    );
  }

  /** GET /api/v1/spaces/:slug/submissions/by-problem */
  async byProblem(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    return reply.send(await this.review.byProblem(user, slug, byProblemQuery.parse(request.query)));
  }

  /** GET /api/v1/spaces/:slug/submissions/versions */
  async versions(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    const { problem } = versionsQuery.parse(request.query);
    return reply.send({ items: await this.review.versions(user, slug, problem) });
  }

  /** GET /api/v1/submissions/:submissionId/tests/:position */
  async testDetail(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { submissionId, position } = submissionTestParams.parse(request.params);
    const query = testDetailQuery.parse(request.query);
    return reply.send(
      await this.review.testDetail(user, submissionId, position, {
        fromLine: query.from_line,
        maxLines: query.max_lines,
        part: query.part,
      })
    );
  }
}
