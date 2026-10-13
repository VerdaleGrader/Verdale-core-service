import type { LegalDocument } from '../../generated/prisma/enums';
import { Db } from '@/repositories/db';

export default class LegalRepository {
  /** How many of the given (document, version) pairs the user has accepted. */
  countAccepted(db: Db, userId: string, versions: ReadonlyArray<[LegalDocument, string]>) {
    return db.legalAcceptance.count({
      where: {
        user_id: userId,
        OR: versions.map(([document, version]) => ({ document, version })),
      },
    });
  }

  /** Records acceptances; one that already exists is left as it was (first time wins). */
  async record(
    db: Db,
    userId: string,
    versions: ReadonlyArray<[LegalDocument, string]>,
    acceptedAt: Date
  ) {
    await db.legalAcceptance.createMany({
      data: versions.map(([document, version]) => ({
        user_id: userId,
        document,
        version,
        accepted_at: acceptedAt,
      })),
      skipDuplicates: true,
    });
  }
}
