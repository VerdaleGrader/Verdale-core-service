import { Db } from '@/repositories/db';

export default class SessionRepository {
  create(db: Db, data: { user_id: string; token_hash: string; expires_at: Date }) {
    return db.session.create({ data });
  }

  /** The session and its user, only while it has not expired. */
  findActive(db: Db, tokenHash: string, now: Date) {
    return db.session.findFirst({
      where: { token_hash: tokenHash, expires_at: { gt: now } },
      include: { user: true },
    });
  }

  deleteByTokenHash(db: Db, tokenHash: string) {
    return db.session.deleteMany({ where: { token_hash: tokenHash } });
  }

  deleteExpiredForUser(db: Db, userId: string, now: Date) {
    return db.session.deleteMany({ where: { user_id: userId, expires_at: { lte: now } } });
  }
}
