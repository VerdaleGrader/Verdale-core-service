import { Db, Prisma } from '@/repositories/db';

export type AuditAction =
  | 'track.invite_created'
  | 'track.invite_revoked'
  | 'track.member_joined'
  | 'track.member_removed';

export default class AuditRepository {
  record(
    db: Db,
    entry: {
      space_id: string;
      actor_id: string | null;
      action: AuditAction;
      target_id: string | null;
      data?: Prisma.InputJsonObject;
    }
  ) {
    return db.auditLog.create({ data: { ...entry, data: entry.data ?? {} } });
  }

  listForTarget(db: Db, targetId: string, take = 100) {
    return db.auditLog.findMany({
      where: { target_id: targetId },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take,
    });
  }
}
