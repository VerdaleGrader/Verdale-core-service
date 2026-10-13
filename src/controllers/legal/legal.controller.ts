import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from '@/middleware/session';
import LegalService from '@/services/legal/legal.service';
import UserService from '@/services/user/user.service';
import { legalAcceptanceBody } from '@/validation/schemas';

export default class LegalController {
  constructor(
    private readonly userService: UserService,
    private readonly legalService: LegalService
  ) {}

  /** POST /api/v1/me/legal-acceptance: the user accepts the versions the page showed (GRD-122). */
  async accept(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const legal = await this.legalService.accept(user.id, legalAcceptanceBody.parse(request.body));
    return reply.send({ ...this.userService.getMe(user), legal });
  }
}
