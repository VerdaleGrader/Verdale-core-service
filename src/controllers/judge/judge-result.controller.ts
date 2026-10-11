import type { FastifyReply, FastifyRequest } from 'fastify';
import { BadRequestError } from '@/errors';
import JudgeResultService from '@/services/judge/judge-result.service';

export default class JudgeResultController {
  constructor(private readonly resultService: JudgeResultService) {}

  /**
   * POST /internal/judge/result. The body arrives as raw bytes (see routes.ts)
   * because the signature covers them exactly as sent.
   */
  async result(request: FastifyRequest, reply: FastifyReply) {
    const rawBody = request.body;
    if (!Buffer.isBuffer(rawBody))
      throw new BadRequestError('Send the result as application/json.');
    await this.resultService.receive(
      {
        method: request.method,
        path: request.raw.url ?? request.url,
        headers: request.headers,
        rawBody,
      },
      request.id
    );
    return reply.status(204).send();
  }
}
