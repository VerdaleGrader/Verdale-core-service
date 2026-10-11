import { SpaceRole, SpaceVisibility } from '../../generated/prisma/enums';
import { Db, Prisma } from '@/repositories/db';

export interface SpaceListFilter {
  q?: string;
  archived: boolean;
  skip: number;
  take: number;
}

export default class SpaceRepository {
  findBySlug(db: Db, slug: string) {
    return db.space.findUnique({ where: { slug } });
  }

  /** Is this name taken as a Space slug or a username? One shared namespace. */
  async isIdentifierTaken(db: Db, identifier: string, exceptUserId?: string): Promise<boolean> {
    const [space, user] = await Promise.all([
      db.space.findUnique({
        where: { slug: identifier },
        select: { id: true, is_personal: true, created_by_id: true },
      }),
      db.user.findUnique({ where: { username: identifier }, select: { id: true } }),
    ]);
    const spaceIsMine = Boolean(
      exceptUserId && space?.is_personal && space.created_by_id === exceptUserId
    );
    const userIsMe = Boolean(exceptUserId && user?.id === exceptUserId);
    return Boolean((space && !spaceIsMine) || (user && !userIsMe));
  }

  create(
    db: Db,
    data: {
      created_by_id: string;
      name: string;
      slug: string;
      description: string;
      visibility: SpaceVisibility;
      is_personal: boolean;
    }
  ) {
    return db.space.create({ data });
  }

  update(
    db: Db,
    id: string,
    data: {
      name?: string;
      description?: string;
      visibility?: SpaceVisibility;
      slug?: string;
      archived_at?: Date | null;
    }
  ) {
    return db.space.update({ where: { id }, data });
  }

  /** Serialises membership changes to one Space until the transaction ends. */
  async lock(db: Db, spaceId: string): Promise<void> {
    await db.$queryRaw`SELECT id FROM spaces WHERE id = ${spaceId}::uuid FOR UPDATE`;
  }

  findPersonalOf(db: Db, userId: string) {
    return db.space.findFirst({ where: { created_by_id: userId, is_personal: true } });
  }

  // --- memberships --------------------------------------------------------

  addMember(db: Db, spaceId: string, userId: string, role: SpaceRole) {
    return db.membership.create({ data: { space_id: spaceId, user_id: userId, role } });
  }

  findMembership(db: Db, spaceId: string, userId: string) {
    return db.membership.findUnique({
      where: { space_id_user_id: { space_id: spaceId, user_id: userId } },
    });
  }

  listMembers(db: Db, spaceId: string) {
    return db.membership.findMany({
      where: { space_id: spaceId },
      include: { user: { select: { username: true, display_name: true } } },
      orderBy: [{ joined_at: 'asc' }, { id: 'asc' }],
    });
  }

  countMembers(db: Db, spaceId: string) {
    return db.membership.count({ where: { space_id: spaceId } });
  }

  countOwners(db: Db, spaceId: string) {
    return db.membership.count({ where: { space_id: spaceId, role: 'owner' } });
  }

  setMemberRole(db: Db, spaceId: string, userId: string, role: SpaceRole) {
    return db.membership.update({
      where: { space_id_user_id: { space_id: spaceId, user_id: userId } },
      data: { role },
    });
  }

  removeMember(db: Db, spaceId: string, userId: string) {
    return db.membership.delete({
      where: { space_id_user_id: { space_id: spaceId, user_id: userId } },
    });
  }

  // --- listings -----------------------------------------------------------

  async listForMember(db: Db, userId: string, filter: SpaceListFilter) {
    const where: Prisma.MembershipWhereInput = {
      user_id: userId,
      space: {
        archived_at: filter.archived ? { not: null } : null,
        ...(filter.q ? { name: { contains: filter.q, mode: 'insensitive' } } : {}),
      },
    };
    const [rows, total] = await Promise.all([
      db.membership.findMany({
        where,
        include: { space: true },
        orderBy: [{ space: { is_personal: 'desc' } }, { space: { name: 'asc' } }, { id: 'asc' }],
        skip: filter.skip,
        take: filter.take,
      }),
      db.membership.count({ where }),
    ]);
    return { rows, total };
  }

  async listPublic(db: Db, filter: SpaceListFilter) {
    const where: Prisma.SpaceWhereInput = {
      visibility: 'public',
      archived_at: filter.archived ? { not: null } : null,
      ...(filter.q
        ? {
            OR: [
              { name: { contains: filter.q, mode: 'insensitive' } },
              { slug: { contains: filter.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.space.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: filter.skip,
        take: filter.take,
      }),
      db.space.count({ where }),
    ]);
    return { rows, total };
  }
}
