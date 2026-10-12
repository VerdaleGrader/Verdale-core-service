import { InviteStatus, SpaceRole } from '../../generated/prisma/enums';
import { Db } from '@/repositories/db';
import { PUBLIC_USER_SELECT } from '@/services/user/user.mapper';

const WITH_SPACE = {
  space: { select: { id: true, name: true, slug: true, visibility: true, archived_at: true } },
  created_by: { select: PUBLIC_USER_SELECT },
  invitee: { select: PUBLIC_USER_SELECT },
} as const;

export default class InviteRepository {
  create(
    db: Db,
    data: {
      space_id: string;
      created_by_id: string;
      invitee_id: string | null;
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

  listForSpace(db: Db, spaceId: string, now: Date) {
    return db.invite.findMany({
      where: { space_id: spaceId, status: 'pending', expires_at: { gt: now } },
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

  findPendingForUser(db: Db, spaceId: string, userId: string, now: Date) {
    return db.invite.findFirst({
      where: { space_id: spaceId, invitee_id: userId, status: 'pending', expires_at: { gt: now } },
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
