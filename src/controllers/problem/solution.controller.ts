import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from '@/middleware/session';
import SolutionService from '@/services/problem/solution.service';
import {
  createSolutionBody,
  problemSlugParams,
  solutionParams,
  updateSolutionBody,
} from '@/validation/schemas';

export default class SolutionController {
  constructor(private readonly solutionService: SolutionService) {}

  /** GET .../solutions */
  async list(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    return reply.send({ items: await this.solutionService.list(user, slug, problemSlug) });
  }

  /** POST .../solutions */
  async create(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    const created = await this.solutionService.create(
      user,
      slug,
      problemSlug,
      createSolutionBody.parse(request.body),
      request.id
    );
    return reply.status(201).send(created);
  }

  /** PATCH .../solutions/:solutionId */
  async update(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug, solutionId } = solutionParams.parse(request.params);
    return reply.send(
      await this.solutionService.update(
        user,
        slug,
        problemSlug,
        solutionId,
        updateSolutionBody.parse(request.body),
        request.id
      )
    );
  }

  /** DELETE .../solutions/:solutionId */
  async remove(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug, solutionId } = solutionParams.parse(request.params);
    await this.solutionService.remove(user, slug, problemSlug, solutionId, request.id);
    return reply.status(204).send();
  }
}
