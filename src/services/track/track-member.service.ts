import type { PrismaClient, User } from '../../../generated/prisma/client';
import { NotFoundError } from '@/errors';
import TLogger, { Layer } from '@/logging/logger';
import AuditRepository from '@/repositories/audit.repository';
import SpaceRepository from '@/repositories/space.repository';
import TrackRepository from '@/repositories/track.repository';
import UserRepository from '@/repositories/user.repository';
import { Role } from '@/services/space/space.access';
import TrackService from '@/services/track/track.service';
import { PublicUser, toPublicUser } from '@/services/user/user.mapper';

export interface TrackMemberDto extends PublicUser {
  /** The person's role in the Space; a Track member who is also an editor stays an editor. */
  space_role: Role | null;
  joined_at: string;
}

/** Who was added to a Track (GRD-80). Removing someone here never touches their Space membership. */
export default class TrackMemberService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly tracks: TrackRepository,
    private readonly spaces: SpaceRepository,
    private readonly users: UserRepository,
    private readonly audit: AuditRepository,
    private readonly trackService: TrackService
  ) {}

  async list(user: User, slug: string, trackSlug: string): Promise<{ items: TrackMemberDto[] }> {
    const { access, track } = await this.trackService.loadForManager(
      this.prisma,
      user,
      'track.manage_members',
      slug,
      trackSlug
    );
    const rows = await this.tracks.listTrackMembers(this.prisma, track.id);
    const memberships = new Map(
      (await this.spaces.listMembers(this.prisma, access.space.id)).map((member) => [
        member.user_id,
        member.role as Role,
      ])
    );
    return {
      items: rows.map((row) => ({
        ...toPublicUser(row.user),
        space_role: memberships.get(row.user_id) ?? null,
        joined_at: row.created_at.toISOString(),
      })),
    };
  }

  async remove(
    user: User,
    slug: string,
    trackSlug: string,
    username: string,
    requestId: string
  ): Promise<void> {
    const logger = this.logger.setContext('service.trackMember.remove', requestId);
    const { access, track } = await this.trackService.loadForManager(
      this.prisma,
      user,
      'track.manage_members',
      slug,
      trackSlug
    );
    const target = await this.users.findByUsername(this.prisma, username.toLowerCase());
    await this.prisma.$transaction(async (tx) => {
      if (!target || !(await this.tracks.removeTrackMember(tx, track.id, target.id))) {
        throw new NotFoundError('That user is not a member of this Track.');
      }
      await this.audit.record(tx, {
        space_id: access.space.id,
        actor_id: user.id,
        action: 'track.member_removed',
        target_id: track.id,
        data: { user: target.username },
      });
    });
    logger.info({
      message: 'track member removed',
      data: { trackId: track.id, targetUserId: target?.id },
    });
  }
}
