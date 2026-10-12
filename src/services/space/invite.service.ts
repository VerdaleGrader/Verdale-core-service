import type { PrismaClient, User } from '../../../generated/prisma/client';
import { ConflictError, GoneError, NotFoundError } from '@/errors';
import { generateToken, hashToken } from '@/libs/tokens';
import TLogger, { Layer } from '@/logging/logger';
import { Db } from '@/repositories/db';
import AuditRepository from '@/repositories/audit.repository';
import InviteRepository from '@/repositories/invite.repository';
import SpaceRepository from '@/repositories/space.repository';
import TrackRepository from '@/repositories/track.repository';
import UserRepository from '@/repositories/user.repository';
import { Role, assertCan } from '@/services/space/space.access';
import SpaceService from '@/services/space/space.service';
import TrackService from '@/services/track/track.service';
import { PublicUser, toPublicUser } from '@/services/user/user.mapper';

type InviteRow = NonNullable<Awaited<ReturnType<InviteRepository['findById']>>>;

export interface InviteDto {
  id: string;
  space: { name: string; slug: string };
  role: Role;
  /** `expired` is computed from expires_at and never stored. */
  status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
  expires_at: string;
  created_at: string;
  invited_by: PublicUser;
  /** Set for invitations addressed to one user, absent for link invitations. */
  invited_user: PublicUser | null;
  /** Set for a Track invitation: accepting joins this Track (and the Space as a solver, if needed). */
  track: { name: string; slug: string } | null;
  /** Shown once, when the invitation is created. Never returned again. */
  token?: string;
  /** Path of the page that accepts the invitation (link invitations only). */
  link?: string;
}

export interface CreateInviteInput {
  role: 'editor' | 'solver';
  username?: string;
  expires_in_days: number;
}

/** A Track invitation always gives a solver seat in the Space (GRD-80). */
export interface CreateTrackInviteInput {
  username?: string;
  expires_in_days: number;
}

const UNAVAILABLE = 'This invitation is no longer valid.';

export default class InviteService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly invites: InviteRepository,
    private readonly spaces: SpaceRepository,
    private readonly users: UserRepository,
    private readonly spaceService: SpaceService,
    private readonly trackService: TrackService,
    private readonly tracks: TrackRepository,
    private readonly audit: AuditRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  async create(
    user: User,
    slug: string,
    input: CreateInviteInput,
    requestId: string
  ): Promise<InviteDto> {
    const logger = this.logger.setContext('service.invite.create', requestId);
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, 'space.manage_members', access);

    let inviteeId: string | null = null;
    if (input.username) {
      const invitee = await this.users.findByUsername(this.prisma, input.username.toLowerCase());
      if (!invitee) throw new NotFoundError('No user with that username.');
      if (await this.spaces.findMembership(this.prisma, access.space.id, invitee.id)) {
        throw new ConflictError('That user is already a member of this Space.');
      }
      if (
        await this.invites.findPendingForUser(this.prisma, access.space.id, invitee.id, this.now())
      ) {
        throw new ConflictError('That user already has a pending invitation. Revoke it first.');
      }
      inviteeId = invitee.id;
    }

    const token = generateToken();
    const created = await this.invites.create(this.prisma, {
      space_id: access.space.id,
      created_by_id: user.id,
      invitee_id: inviteeId,
      token_hash: hashToken(token),
      role: input.role,
      expires_at: new Date(this.now().getTime() + input.expires_in_days * 24 * 60 * 60 * 1000),
    });
    logger.info({
      message: 'invite created',
      data: {
        spaceId: access.space.id,
        inviteId: created.id,
        role: input.role,
        targeted: Boolean(inviteeId),
      },
    });
    return {
      ...this.toDto(created),
      token,
      ...(inviteeId ? {} : { link: `/invites/${token}` }),
    };
  }

  async listForSpace(user: User, slug: string): Promise<InviteDto[]> {
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, 'space.manage_members', access);
    const rows = await this.invites.listForSpace(this.prisma, access.space.id, this.now());
    return rows.map((row) => this.toDto(row));
  }

  async revoke(user: User, slug: string, inviteId: string, requestId: string): Promise<void> {
    const logger = this.logger.setContext('service.invite.revoke', requestId);
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, 'space.manage_members', access);
    const invite = await this.invites.findById(this.prisma, inviteId);
    if (!invite || invite.space.id !== access.space.id || invite.track)
      throw new NotFoundError('Invitation not found.');
    if (!(await this.invites.settle(this.prisma, invite.id, 'revoked', this.now()))) {
      throw new ConflictError('This invitation is no longer pending.');
    }
    logger.info({ message: 'invite revoked', data: { inviteId } });
  }

  // --- Track invitations (GRD-80) ------------------------------------------

  async createForTrack(
    user: User,
    slug: string,
    trackSlug: string,
    input: CreateTrackInviteInput,
    requestId: string
  ): Promise<InviteDto> {
    const logger = this.logger.setContext('service.invite.createForTrack', requestId);
    const { access, track } = await this.trackService.loadForManager(
      this.prisma,
      user,
      'track.manage_members',
      slug,
      trackSlug
    );
    if (track.archived_at) {
      throw new ConflictError(
        'This Track is archived. Restore it before inviting people.',
        'TRACK_ARCHIVED'
      );
    }

    let inviteeId: string | null = null;
    let inviteeUsername: string | null = null;
    if (input.username) {
      const invitee = await this.users.findByUsername(this.prisma, input.username.toLowerCase());
      if (!invitee) throw new NotFoundError('No user with that username.');
      if (await this.tracks.findTrackMember(this.prisma, track.id, invitee.id)) {
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
      inviteeUsername = invitee.username;
    }

    const token = generateToken();
    const created = await this.prisma.$transaction(async (tx) => {
      const invite = await this.invites.create(tx, {
        space_id: access.space.id,
        created_by_id: user.id,
        invitee_id: inviteeId,
        track_id: track.id,
        token_hash: hashToken(token),
        role: 'solver',
        expires_at: new Date(this.now().getTime() + input.expires_in_days * 24 * 60 * 60 * 1000),
      });
      await this.audit.record(tx, {
        space_id: access.space.id,
        actor_id: user.id,
        action: 'track.invite_created',
        target_id: track.id,
        data: {
          invite_id: invite.id,
          invitee: inviteeUsername,
          kind: inviteeId ? 'person' : 'link',
          expires_at: invite.expires_at.toISOString(),
        },
      });
      return invite;
    });
    logger.info({
      message: 'track invite created',
      data: { trackId: track.id, inviteId: created.id, targeted: Boolean(inviteeId) },
    });
    return {
      ...this.toDto(created),
      token,
      ...(inviteeId ? {} : { link: `/invites/${token}` }),
    };
  }

  async listForTrack(user: User, slug: string, trackSlug: string): Promise<InviteDto[]> {
    const { track } = await this.trackService.loadForManager(
      this.prisma,
      user,
      'track.manage_members',
      slug,
      trackSlug
    );
    const rows = await this.invites.listForTrack(this.prisma, track.id, this.now());
    return rows.map((row) => this.toDto(row));
  }

  async revokeForTrack(
    user: User,
    slug: string,
    trackSlug: string,
    inviteId: string,
    requestId: string
  ): Promise<void> {
    const logger = this.logger.setContext('service.invite.revokeForTrack', requestId);
    const { access, track } = await this.trackService.loadForManager(
      this.prisma,
      user,
      'track.manage_members',
      slug,
      trackSlug
    );
    await this.prisma.$transaction(async (tx) => {
      const invite = await this.invites.findById(tx, inviteId);
      if (!invite || invite.space.id !== access.space.id || invite.track?.id !== track.id) {
        throw new NotFoundError('Invitation not found.');
      }
      if (!(await this.invites.settle(tx, invite.id, 'revoked', this.now()))) {
        throw new ConflictError('This invitation is no longer pending.');
      }
      await this.audit.record(tx, {
        space_id: access.space.id,
        actor_id: user.id,
        action: 'track.invite_revoked',
        target_id: track.id,
        data: { invite_id: invite.id, invitee: invite.invitee?.username ?? null },
      });
    });
    logger.info({ message: 'track invite revoked', data: { trackId: track.id, inviteId } });
  }

  /** What the holder of a link sees before accepting. No login needed. */
  async previewByToken(token: string): Promise<InviteDto> {
    const invite = await this.invites.findByTokenHash(this.prisma, hashToken(token));
    if (!invite) throw new NotFoundError('Invitation not found.');
    return this.toDto(invite);
  }

  async listMine(user: User): Promise<InviteDto[]> {
    const rows = await this.invites.listPendingForUser(this.prisma, user.id, this.now());
    return rows.map((row) => this.toDto(row));
  }

  acceptByToken(user: User, token: string, requestId: string) {
    return this.respond(user, 'accepted', requestId, (db) =>
      this.invites.findByTokenHash(db, hashToken(token))
    );
  }

  declineByToken(user: User, token: string, requestId: string) {
    return this.respond(user, 'declined', requestId, (db) =>
      this.invites.findByTokenHash(db, hashToken(token))
    );
  }

  acceptById(user: User, inviteId: string, requestId: string) {
    return this.respond(user, 'accepted', requestId, (db) => this.invites.findById(db, inviteId));
  }

  declineById(user: User, inviteId: string, requestId: string) {
    return this.respond(user, 'declined', requestId, (db) => this.invites.findById(db, inviteId));
  }

  // --- internals ----------------------------------------------------------

  private async respond(
    user: User,
    outcome: 'accepted' | 'declined',
    requestId: string,
    find: (db: Db) => Promise<InviteRow | null>
  ): Promise<{
    space: { name: string; slug: string };
    role: Role;
    status: 'accepted' | 'declined';
    track: { name: string; slug: string } | null;
  }> {
    const logger = this.logger.setContext(`service.invite.${outcome}`, requestId);
    let role: Role = 'solver';
    const result = await this.prisma.$transaction(async (tx) => {
      const found = await find(tx);
      // An invitation addressed to someone else does not exist for you.
      if (!found || (found.invitee_id !== null && found.invitee_id !== user.id)) {
        throw new NotFoundError('Invitation not found.');
      }
      await this.spaces.lock(tx, found.space.id);
      const invite = await this.invites.findById(tx, found.id);
      if (
        !invite ||
        invite.status !== 'pending' ||
        invite.expires_at <= this.now() ||
        invite.space.archived_at
      ) {
        throw new GoneError(UNAVAILABLE);
      }
      if (invite.track?.archived_at) throw new GoneError(UNAVAILABLE);
      const existing = await this.spaces.findMembership(tx, invite.space.id, user.id);
      if (outcome === 'accepted') {
        if (invite.track) {
          if (await this.tracks.findTrackMember(tx, invite.track.id, user.id)) {
            throw new ConflictError('You are already a member of this Track.');
          }
        } else if (existing) {
          throw new ConflictError('You are already a member of this Space.');
        }
      }
      // One winner when two people open the same link at once.
      if (!(await this.invites.settle(tx, invite.id, outcome, this.now()))) {
        throw new GoneError(UNAVAILABLE);
      }
      role = (existing?.role as Role | undefined) ?? invite.role;
      if (outcome === 'accepted') {
        // A Track invitation never raises anyone's role: a newcomer becomes a solver of the
        // Space, and someone already in the Space keeps the role they have.
        if (!existing) await this.spaces.addMember(tx, invite.space.id, user.id, invite.role);
        if (invite.track) {
          await this.tracks.addTrackMember(tx, invite.track.id, user.id);
          await this.audit.record(tx, {
            space_id: invite.space.id,
            actor_id: user.id,
            action: 'track.member_joined',
            target_id: invite.track.id,
            data: { invite_id: invite.id, via: invite.invitee_id ? 'person' : 'link' },
          });
        }
      }
      return invite;
    });
    logger.info({ message: `invite ${outcome}`, data: { inviteId: result.id, userId: user.id } });
    return {
      space: { name: result.space.name, slug: result.space.slug },
      role,
      status: outcome,
      track: result.track ? { name: result.track.name, slug: result.track.slug } : null,
    };
  }

  private toDto(row: InviteRow): InviteDto {
    const expired = row.status === 'pending' && row.expires_at <= this.now();
    return {
      id: row.id,
      space: { name: row.space.name, slug: row.space.slug },
      role: row.role as Role,
      status: expired ? 'expired' : row.status,
      expires_at: row.expires_at.toISOString(),
      created_at: row.created_at.toISOString(),
      invited_by: toPublicUser(row.created_by),
      invited_user: row.invitee ? toPublicUser(row.invitee) : null,
      track: row.track ? { name: row.track.name, slug: row.track.slug } : null,
    };
  }
}
