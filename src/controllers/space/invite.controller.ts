import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from '@/middleware/session';
import InviteService from '@/services/space/invite.service';
import { inviteIdParams, tokenParams } from '@/validation/schemas';

export default class InviteController {
  constructor(private readonly inviteService: InviteService) {}

  /** GET /api/v1/invites/:token: what a link holder sees before accepting. */
  async preview(request: FastifyRequest, reply: FastifyReply) {
    const { token } = tokenParams.parse(request.params);
    return reply.send(await this.inviteService.previewByToken(token));
  }

  /** POST /api/v1/invites/:token/accept */
  async acceptByToken(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { token } = tokenParams.parse(request.params);
    return reply.send(await this.inviteService.acceptByToken(user, token, request.id));
  }

  /** POST /api/v1/invites/:token/decline */
  async declineByToken(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { token } = tokenParams.parse(request.params);
    return reply.send(await this.inviteService.declineByToken(user, token, request.id));
  }

  /** GET /api/v1/me/invites: pending invitations addressed to me. */
  async listMine(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    return reply.send({ items: await this.inviteService.listMine(user) });
  }

  /** POST /api/v1/me/invites/:inviteId/accept */
  async acceptById(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { inviteId } = inviteIdParams.parse(request.params);
    return reply.send(await this.inviteService.acceptById(user, inviteId, request.id));
  }

  /** POST /api/v1/me/invites/:inviteId/decline */
  async declineById(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { inviteId } = inviteIdParams.parse(request.params);
    return reply.send(await this.inviteService.declineById(user, inviteId, request.id));
  }
}
