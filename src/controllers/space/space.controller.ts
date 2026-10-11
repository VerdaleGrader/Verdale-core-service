import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from '@/middleware/session';
import InviteService from '@/services/space/invite.service';
import MemberService from '@/services/space/member.service';
import SpaceService from '@/services/space/space.service';
import {
  changeRoleBody,
  createInviteBody,
  createSpaceBody,
  inviteParams,
  listQuery,
  memberParams,
  publicListQuery,
  slugParams,
  updateSpaceBody,
} from '@/validation/schemas';

export default class SpaceController {
  constructor(
    private readonly spaceService: SpaceService,
    private readonly memberService: MemberService,
    private readonly inviteService: InviteService
  ) {}

  /** GET /api/v1/spaces: public, active Spaces (search with ?q=). */
  async listPublic(request: FastifyRequest, reply: FastifyReply) {
    const query = publicListQuery.parse(request.query);
    return reply.send(
      await this.spaceService.listPublic(request.currentUser, { ...query, archived: false })
    );
  }

  /** GET /api/v1/me/spaces: Spaces I belong to; ?archived=true for the archived ones. */
  async listMine(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    return reply.send(await this.spaceService.listMine(user, listQuery.parse(request.query)));
  }

  /** POST /api/v1/spaces */
  async create(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const space = await this.spaceService.create(user, createSpaceBody.parse(request.body));
    return reply.status(201).send(space);
  }

  /** GET /api/v1/spaces/:slug */
  async get(request: FastifyRequest, reply: FastifyReply) {
    const { slug } = slugParams.parse(request.params);
    return reply.send(await this.spaceService.get(request.currentUser, slug));
  }

  /** PATCH /api/v1/spaces/:slug */
  async update(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    return reply.send(
      await this.spaceService.update(user, slug, updateSpaceBody.parse(request.body))
    );
  }

  /** POST /api/v1/spaces/:slug/archive */
  async archive(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    return reply.send(await this.spaceService.archive(user, slug));
  }

  // --- members ------------------------------------------------------------

  /** GET /api/v1/spaces/:slug/members */
  async listMembers(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    return reply.send({ items: await this.memberService.list(user, slug) });
  }

  /** PATCH /api/v1/spaces/:slug/members/:username */
  async changeRole(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, username } = memberParams.parse(request.params);
    const { role } = changeRoleBody.parse(request.body);
    return reply.send(await this.memberService.changeRole(user, slug, username, role, request.id));
  }

  /** DELETE /api/v1/spaces/:slug/members/:username */
  async removeMember(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, username } = memberParams.parse(request.params);
    await this.memberService.remove(user, slug, username, request.id);
    return reply.status(204).send();
  }

  /** POST /api/v1/spaces/:slug/leave */
  async leave(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    await this.memberService.leave(user, slug, request.id);
    return reply.status(204).send();
  }

  // --- invitations --------------------------------------------------------

  /** GET /api/v1/spaces/:slug/invites: pending, unexpired. */
  async listInvites(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    return reply.send({ items: await this.inviteService.listForSpace(user, slug) });
  }

  /** POST /api/v1/spaces/:slug/invites */
  async createInvite(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    const invite = await this.inviteService.create(
      user,
      slug,
      createInviteBody.parse(request.body),
      request.id
    );
    return reply.status(201).send(invite);
  }

  /** DELETE /api/v1/spaces/:slug/invites/:inviteId: revoke. */
  async revokeInvite(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, inviteId } = inviteParams.parse(request.params);
    await this.inviteService.revoke(user, slug, inviteId, request.id);
    return reply.status(204).send();
  }
}
