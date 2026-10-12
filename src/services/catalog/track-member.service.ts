import type { PrismaClient, User } from '../../../generated/prisma/client';
import { ConflictError, NotFoundError } from '@/errors';
import { generateToken, hashToken } from '@/libs/tokens';
import TLogger, { Layer } from '@/logging/logger';
import CatalogRepository from '@/repositories/catalog.repository';
import InviteRepository from '@/repositories/invite.repository';
import SpaceRepository from '@/repositories/space.repository';
import UserRepository from '@/repositories/user.repository';
import { InviteDto } from '@/services/space/invite.service';
import { assertCan } from '@/services/space/space.access';
import SpaceService from '@/services/space/space.service';
import { PublicUser, toPublicUser } from '@/services/user/user.mapper';

export interface TrackMemberDto extends PublicUser {
  /** Their role in the Space; a person invited to a Track is a solver there. */
  space_role: string | null;
  joined_at: string;
  added_by: PublicUser;
}

export interface CreateTrackInviteInput {
  username?: string;
  expires_in_days: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Who is in a Track and how they got there (GRD-80). Owners, administrators and
 * editors manage it; observers can look. Everyone invited to a Track becomes a
 * solver of the Space, never more, so an invitation can never grant authoring.
 */
export default class TrackMemberService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly catalog: CatalogRepository,
    private readonly invites: InviteRepository,
    private readonly spaces: SpaceRepository,
    private readonly users: UserRepository,
    private readonly spaceService: SpaceService,
    private readonly toInviteDto: (row: Parameters<InviteMapper>[0]) => InviteDto,
    private readonly now: () => Date = () => new Date()
  ) {}

  async list(user: User, slug: string, trackSlug: string): Promise<TrackMemberDto[]> {
    const { access, track } = await this.loadTrack(user, slug, trackSlug, 'catalog.view_progress');
    const [members, spaceMembers] = await Promise.all([
      this.catalog.listTrackMembers(this.prisma, track.id),
      this.spaces.listMembers(this.prisma, access.space.id),
    ]);
    const roles = new Map(spaceMembers.map((member) => [member.user_id, member.role as string]));
    const adders = await this.prisma.user.findMany({
      where: { id: { in: members.map((member) => member.added_by_id) } },
      select: { id: true, username: true, display_name: true, avatar_url: true },
    });
    const byId = new Map(adders.map((adder) => [adder.id, adder]));
    return members.map((member) => ({
      ...toPublicUser(member.user),
      space_role: roles.get(member.user_id) ?? null,
      joined_at: member.joined_at.toISOString(),
      added_by: toPublicUser(byId.get(member.added_by_id) ?? member.user),
    }));
  }

  /** Takes a person out of the Track. They stay in the Space. */
  async remove(
    user: User,
    slug: string,
    trackSlug: string,
    username: string,
    requestId: string
  ): Promise<void> {
    const logger = this.logger.setContext('service.trackMember.remove', requestId);
    const { access, track } = await this.loadTrack(user, slug, trackSlug, 'catalog.manage');
    const target = await this.users.findByUsername(this.prisma, username.toLowerCase());
    const membership = target
      ? await this.catalog.findTrackMember(this.prisma, track.id, target.id)
      : null;
    if (!target || !membership) throw new NotFoundError('That user is not a member of this Track.');
    await this.prisma.$transaction(async (tx) => {
      await this.catalog.removeTrackMember(tx, track.id, target.id);
      await this.catalog.audit(tx, {
        space_id: access.space.id,
        track_id: track.id,
        actor_id: user.id,
        action: 'track.member_removed',
        target_user_id: target.id,
      });
    });
    logger.info({
      message: 'track member removed',
      data: { trackId: track.id, targetUserId: target.id },
    });
  }

  // --- invitations --------------------------------------------------------

  async listInvites(user: User, slug: string, trackSlug: string): Promise<InviteDto[]> {
    const { track } = await this.loadTrack(user, slug, trackSlug, 'catalog.view_progress');
    const rows = await this.invites.listForTrack(this.prisma, track.id, this.now());
    return rows.map((row) => this.toInviteDto(row));
  }

  async createInvite(
    user: User,
    slug: string,
    trackSlug: string,
    input: CreateTrackInviteInput,
    requestId: string
  ): Promise<InviteDto> {
    const logger = this.logger.setContext('service.trackMember.invite', requestId);
    const { access, track } = await this.loadTrack(user, slug, trackSlug, 'catalog.manage');
    if (track.archived_at) throw new ConflictError('This Track is archived.');

    let inviteeId: string | null = null;
    if (input.username) {
      const invitee = await this.users.findByUsername(this.prisma, input.username.toLowerCase());
      if (!invitee) throw new NotFoundError('No user with that username.');
      if (await this.catalog.findTrackMember(this.prisma, track.id, invitee.id)) {
        throw new ConflictError('That user is already a member of this Track.');
      }
      if (
        await this.invites.findPendingForUser(
          this.prisma,
          access.space.id,
          invitee.id,
          this.now(),
          track.id
        )
      ) {
        throw new ConflictError('That user already has a pending invitation. Revoke it first.');
      }
      inviteeId = invitee.id;
    }

    const token = generateToken();
    const created = await this.prisma.$transaction(async (tx) => {
      const invite = await this.invites.create(tx, {
        space_id: access.space.id,
        track_id: track.id,
        created_by_id: user.id,
        invitee_id: inviteeId,
        token_hash: hashToken(token),
        role: 'solver',
        expires_at: new Date(this.now().getTime() + input.expires_in_days * DAY_MS),
      });
      await this.catalog.audit(tx, {
        space_id: access.space.id,
        track_id: track.id,
        actor_id: user.id,
        action: 'track.invite_created',
        target_user_id: inviteeId,
        data: { invite_id: invite.id, expires_in_days: input.expires_in_days },
      });
      return invite;
    });
    logger.info({
      message: 'track invite created',
      data: { trackId: track.id, inviteId: created.id, targeted: Boolean(inviteeId) },
    });
    return {
      ...this.toInviteDto(created),
      token,
      ...(inviteeId ? {} : { link: `/invites/${token}` }),
    };
  }

  async revokeInvite(
    user: User,
    slug: string,
    trackSlug: string,
    inviteId: string,
    requestId: string
  ): Promise<void> {
    const logger = this.logger.setContext('service.trackMember.revokeInvite', requestId);
    const { access, track } = await this.loadTrack(user, slug, trackSlug, 'catalog.manage');
    const invite = await this.invites.findById(this.prisma, inviteId);
    if (!invite || invite.track?.id !== track.id) throw new NotFoundError('Invitation not found.');
    await this.prisma.$transaction(async (tx) => {
      if (!(await this.invites.settle(tx, invite.id, 'revoked', this.now()))) {
        throw new ConflictError('This invitation is no longer pending.');
      }
      await this.catalog.audit(tx, {
        space_id: access.space.id,
        track_id: track.id,
        actor_id: user.id,
        action: 'track.invite_revoked',
        target_user_id: invite.invitee_id,
        data: { invite_id: invite.id },
      });
    });
    logger.info({ message: 'track invite revoked', data: { inviteId } });
  }

  // --- internals ----------------------------------------------------------

  private async loadTrack(
    user: User,
    slug: string,
    trackSlug: string,
    action: 'catalog.manage' | 'catalog.view_progress'
  ) {
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, action, access);
    const track = await this.catalog.findTrack(
      this.prisma,
      access.space.id,
      trackSlug.toLowerCase()
    );
    if (!track) throw new NotFoundError('Track not found.');
    return { access, track };
  }
}

type InviteMapper = (
  row: NonNullable<Awaited<ReturnType<InviteRepository['findById']>>>
) => InviteDto;
