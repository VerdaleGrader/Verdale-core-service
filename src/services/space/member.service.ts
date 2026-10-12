import type { PrismaClient, User } from '../../../generated/prisma/client';
import { ConflictError, ForbiddenError, NotFoundError } from '@/errors';
import TLogger, { Layer } from '@/logging/logger';
import { canAssignRole, canRemoveMember } from '@/permissions/can';
import { Db, isCheckViolation } from '@/repositories/db';
import SpaceRepository from '@/repositories/space.repository';
import TrackRepository from '@/repositories/track.repository';
import UserRepository from '@/repositories/user.repository';
import { Role, SpaceAccess, assertCan } from '@/services/space/space.access';
import SpaceService from '@/services/space/space.service';
import { PublicUser, toPublicUser } from '@/services/user/user.mapper';

export interface MemberDto extends PublicUser {
  role: Role;
  joined_at: string;
}

const OWNER_MESSAGE =
  'A Space always has exactly one owner. Hand the Space over to another member first.';

interface Target {
  user_id: string;
  role: Role;
}

export default class MemberService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly spaces: SpaceRepository,
    private readonly users: UserRepository,
    private readonly spaceService: SpaceService,
    private readonly tracks: TrackRepository
  ) {}

  async list(user: User, slug: string): Promise<MemberDto[]> {
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, 'space.view_members', access);
    const members = await this.spaces.listMembers(this.prisma, access.space.id);
    return members.map((member) => ({
      ...toPublicUser(member.user),
      role: member.role as Role,
      joined_at: member.joined_at.toISOString(),
    }));
  }

  async changeRole(
    user: User,
    slug: string,
    username: string,
    role: Role,
    requestId: string
  ): Promise<MemberDto> {
    const logger = this.logger.setContext('service.member.changeRole', requestId);
    const changed = await this.mutate(slug, user, username, async (tx, access, target) => {
      if (target.role === role) {
        return this.spaces.setMemberRole(tx, access.space.id, target.user_id, role);
      }
      if (role === 'owner') {
        // Making someone the owner hands the Space over: the old owner becomes
        // an administrator. Demote first: the owner is unique in the database.
        assertCan(user, 'space.transfer_ownership', access);
        await this.spaces.setMemberRole(tx, access.space.id, user.id, 'administrator');
        return this.spaces.setMemberRole(tx, access.space.id, target.user_id, 'owner');
      }
      if (target.role === 'owner' && access.role === 'owner') {
        throw new ConflictError(OWNER_MESSAGE);
      }
      if (!canAssignRole(access.role, target.role, role)) {
        throw new ForbiddenError(
          target.role === 'owner'
            ? 'To change the owner, hand the Space over to another member instead.'
            : 'Only the owner can make or change an administrator.'
        );
      }
      return this.spaces.setMemberRole(tx, access.space.id, target.user_id, role);
    });
    logger.info({
      message: 'member role changed',
      data: { spaceId: changed.space_id, targetUserId: changed.user_id, role },
    });
    const target = await this.users.findById(this.prisma, changed.user_id);
    return {
      username: username.toLowerCase(),
      display_name: target?.display_name ?? '',
      avatar_url: target?.avatar_url ?? null,
      role: changed.role as Role,
      joined_at: changed.joined_at.toISOString(),
    };
  }

  async remove(user: User, slug: string, username: string, requestId: string): Promise<void> {
    const logger = this.logger.setContext('service.member.remove', requestId);
    const removed = await this.mutate(slug, user, username, async (tx, access, target) => {
      if (!canRemoveMember(access.role, target.role)) {
        if (target.role === 'owner' && access.role === 'owner') {
          throw new ConflictError(OWNER_MESSAGE);
        }
        throw new ForbiddenError(
          target.role === 'owner'
            ? 'The owner cannot be removed.'
            : 'Only the owner can remove an administrator.'
        );
      }
      await this.tracks.removeUserFromSpaceTracks(tx, access.space.id, target.user_id);
      return this.spaces.removeMember(tx, access.space.id, target.user_id);
    });
    logger.info({
      message: 'member removed',
      data: { spaceId: removed.space_id, targetUserId: removed.user_id },
    });
  }

  /** A member leaves on their own. The owner cannot: they hand the Space over first (GRD-18). */
  async leave(user: User, slug: string, requestId: string): Promise<void> {
    const logger = this.logger.setContext('service.member.leave', requestId);
    await this.runGuarded(() =>
      this.prisma.$transaction(async (tx) => {
        const access = await this.lockedAccess(tx, slug, user);
        if (access.role === 'owner') throw new ConflictError(OWNER_MESSAGE);
        assertCan(user, 'space.leave', access);
        await this.tracks.removeUserFromSpaceTracks(tx, access.space.id, user.id);
        await this.spaces.removeMember(tx, access.space.id, user.id);
      })
    );
    logger.info({ message: 'member left', data: { userId: user.id } });
  }

  // --- internals ----------------------------------------------------------

  /** Loads the Space under a row lock so two owner changes cannot interleave. */
  private async lockedAccess(tx: Db, slug: string, user: User): Promise<SpaceAccess> {
    const first = await this.spaceService.load(tx, slug, user);
    await this.spaces.lock(tx, first.space.id);
    return this.spaceService.load(tx, slug, user);
  }

  private mutate<T>(
    slug: string,
    user: User,
    username: string,
    work: (tx: Db, access: SpaceAccess, target: Target) => Promise<T>
  ): Promise<T> {
    return this.runGuarded(() =>
      this.prisma.$transaction(async (tx) => {
        const access = await this.lockedAccess(tx, slug, user);
        assertCan(user, 'space.manage_members', access);
        const targetUser = await this.users.findByUsername(tx, username.toLowerCase());
        const membership = targetUser
          ? await this.spaces.findMembership(tx, access.space.id, targetUser.id)
          : null;
        if (!targetUser || !membership) {
          throw new NotFoundError('That user is not a member of this Space.');
        }
        return work(tx, access, { user_id: targetUser.id, role: membership.role as Role });
      })
    );
  }

  /** The database trigger is the backstop for the last-owner rule. */
  private async runGuarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isCheckViolation(error)) throw new ConflictError(OWNER_MESSAGE);
      throw error;
    }
  }
}
