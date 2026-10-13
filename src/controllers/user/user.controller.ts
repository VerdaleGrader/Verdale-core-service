import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from '@/middleware/session';
import LegalService from '@/services/legal/legal.service';
import UserService from '@/services/user/user.service';
import { updateMeBody, usernameParams } from '@/validation/schemas';

export default class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly legalService: LegalService
  ) {}

  /** GET /api/v1/me */
  async me(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    return reply.send({
      ...this.userService.getMe(user),
      legal: await this.legalService.status(user.id),
    });
  }

  /** PATCH /api/v1/me */
  async updateMe(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const updated = await this.userService.updateMe(user, updateMeBody.parse(request.body));
    return reply.send({ ...updated, legal: await this.legalService.status(user.id) });
  }

  /** GET /api/v1/users/:username: username and display name only. */
  async publicProfile(request: FastifyRequest, reply: FastifyReply) {
    const { username } = usernameParams.parse(request.params);
    return reply.send(await this.userService.getPublicProfile(username));
  }
}
