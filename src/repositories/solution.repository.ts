import { Language } from '../../generated/prisma/enums';
import { Db } from '@/repositories/db';

const WITH_AUTHOR = { created_by: { select: { username: true, display_name: true } } } as const;

export default class SolutionRepository {
  list(db: Db, versionId: string) {
    return db.referenceSolution.findMany({
      where: { problem_version_id: versionId },
      include: WITH_AUTHOR,
      orderBy: [{ is_primary: 'desc' }, { created_at: 'asc' }, { id: 'asc' }],
    });
  }

  find(db: Db, versionId: string, solutionId: string) {
    return db.referenceSolution.findFirst({
      where: { id: solutionId, problem_version_id: versionId },
      include: WITH_AUTHOR,
    });
  }

  async stats(db: Db, versionId: string) {
    const [count, primary] = await Promise.all([
      db.referenceSolution.count({ where: { problem_version_id: versionId } }),
      db.referenceSolution.count({ where: { problem_version_id: versionId, is_primary: true } }),
    ]);
    return { count, has_primary: primary > 0 };
  }

  create(
    db: Db,
    data: {
      problem_version_id: string;
      created_by_id: string;
      language: Language;
      source: string;
      source_bytes: number;
      is_primary: boolean;
    }
  ) {
    return db.referenceSolution.create({ data, include: WITH_AUTHOR });
  }

  update(
    db: Db,
    id: string,
    data: { language?: Language; source?: string; source_bytes?: number; is_primary?: boolean }
  ) {
    return db.referenceSolution.update({ where: { id }, data, include: WITH_AUTHOR });
  }

  /** Before marking another solution primary: only one primary per version. */
  clearPrimary(db: Db, versionId: string) {
    return db.referenceSolution.updateMany({
      where: { problem_version_id: versionId, is_primary: true },
      data: { is_primary: false },
    });
  }

  delete(db: Db, id: string) {
    return db.referenceSolution.delete({ where: { id } });
  }
}
