import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from '@/middleware/session';
import UserService from '@/services/user/user.service';
import { updateMeBody, usernameParams } from '@/validation/schemas';

export default class UserController {
  constructor(private readonly userService: UserService) {}

  /** GET /api/v1/me */
  async me(request: FastifyRequest, reply: FastifyReply) {
    return reply.send(this.userService.getMe(requireUser(request)));
  }

  /** PATCH /api/v1/me */
  async updateMe(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    return reply.send(await this.userService.updateMe(user, updateMeBody.parse(request.body)));
  }

  /** GET /api/v1/users/:username: username and display name only. */
  async publicProfile(request: FastifyRequest, reply: FastifyReply) {
    const { username } = usernameParams.parse(request.params);
    return reply.send(await this.userService.getPublicProfile(username));
  }
}
