import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from '@/middleware/session';
import AiTestService from '@/services/problem/ai-test.service';
import { aiTestsParams, problemSlugParams, startAiTestsBody } from '@/validation/schemas';

export default class AiTestController {
  constructor(private readonly aiTests: AiTestService) {}

  /** POST .../ai-tests */
  async start(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    const job = await this.aiTests.start(
      user,
      slug,
      problemSlug,
      startAiTestsBody.parse(request.body),
      request.id
    );
    return reply.status(202).send(job);
  }

  /** GET .../ai-tests/:jobId */
  async status(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug, jobId } = aiTestsParams.parse(request.params);
    return reply.send(await this.aiTests.get(user, slug, problemSlug, jobId));
  }
}
