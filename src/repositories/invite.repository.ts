import { InviteStatus, SpaceRole } from '../../generated/prisma/enums';
import { Db } from '@/repositories/db';

const WITH_SPACE = {
  space: { select: { id: true, name: true, slug: true, visibility: true, archived_at: true } },
  created_by: { select: { username: true, display_name: true, avatar_url: true } },
  invitee: { select: { username: true, display_name: true, avatar_url: true } },
  track: { select: { id: true, name: true, slug: true, archived_at: true } },
} as const;

export default class InviteRepository {
  create(
    db: Db,
    data: {
      space_id: string;
      created_by_id: string;
      invitee_id: string | null;
      track_id?: string | null;
      token_hash: string;
      role: SpaceRole;
      expires_at: Date;
    }
  ) {
    return db.invite.create({ data, include: WITH_SPACE });
  }

  findByTokenHash(db: Db, tokenHash: string) {
    return db.invite.findUnique({ where: { token_hash: tokenHash }, include: WITH_SPACE });
  }

  findById(db: Db, id: string) {
    return db.invite.findUnique({ where: { id }, include: WITH_SPACE });
  }

  /** Invitations to the Space itself; Track invitations are listed with their Track. */
  listForSpace(db: Db, spaceId: string, now: Date) {
    return db.invite.findMany({
      where: { space_id: spaceId, track_id: null, status: 'pending', expires_at: { gt: now } },
      include: WITH_SPACE,
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
    });
  }

  listForTrack(db: Db, trackId: string, now: Date) {
    return db.invite.findMany({
      where: { track_id: trackId, status: 'pending', expires_at: { gt: now } },
      include: WITH_SPACE,
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
    });
  }

  listPendingForUser(db: Db, userId: string, now: Date) {
    return db.invite.findMany({
      where: {
        invitee_id: userId,
        status: 'pending',
        expires_at: { gt: now },
        space: { archived_at: null },
      },
      include: WITH_SPACE,
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
    });
  }

  /** A pending invitation to the Space (`trackId` null) or to one Track for this user. */
  findPendingForUser(
    db: Db,
    spaceId: string,
    userId: string,
    now: Date,
    trackId: string | null = null
  ) {
    return db.invite.findFirst({
      where: {
        space_id: spaceId,
        track_id: trackId,
        invitee_id: userId,
        status: 'pending',
        expires_at: { gt: now },
      },
    });
  }

  /**
   * Moves a pending invite to a final state. Returns false when someone else
   * got there first (so two people cannot both redeem one link).
   */
  async settle(db: Db, id: string, status: InviteStatus, now: Date): Promise<boolean> {
    const result = await db.invite.updateMany({
      where: { id, status: 'pending' },
      data: { status, responded_at: now },
    });
    return result.count === 1;
  }
}
