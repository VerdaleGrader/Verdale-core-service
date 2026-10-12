import { Db } from '@/repositories/db';

export interface TestCaseFiles {
  input_sha256: string;
  /** Null while the expected output is still to be created. */
  output_sha256: string | null;
  input_size_bytes: number;
  output_size_bytes: number | null;
}

export default class TestCaseRepository {
  listByVersion(db: Db, versionId: string) {
    return db.testCase.findMany({
      where: { problem_version_id: versionId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
  }

  listSamples(db: Db, versionId: string) {
    return db.testCase.findMany({
      where: { problem_version_id: versionId, is_sample: true },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
  }

  find(db: Db, versionId: string, testId: string) {
    return db.testCase.findFirst({ where: { id: testId, problem_version_id: versionId } });
  }

  /** Count, samples and total bytes (input plus output) of a version's tests. */
  async stats(db: Db, versionId: string) {
    const [count, samples, missing, sums] = await Promise.all([
      db.testCase.count({ where: { problem_version_id: versionId } }),
      db.testCase.count({ where: { problem_version_id: versionId, is_sample: true } }),
      db.testCase.count({ where: { problem_version_id: versionId, output_sha256: null } }),
      db.testCase.aggregate({
        where: { problem_version_id: versionId },
        _sum: { input_size_bytes: true, output_size_bytes: true },
      }),
    ]);
    return {
      count,
      sample_count: samples,
      missing_output_count: missing,
      total_bytes: (sums._sum.input_size_bytes ?? 0) + (sums._sum.output_size_bytes ?? 0),
    };
  }

  async nextPosition(db: Db, versionId: string): Promise<number> {
    const last = await db.testCase.aggregate({
      where: { problem_version_id: versionId },
      _max: { position: true },
    });
    return (last._max.position ?? 0) + 1;
  }

  create(
    db: Db,
    data: TestCaseFiles & { problem_version_id: string; position: number; is_sample: boolean }
  ) {
    return db.testCase.create({ data });
  }

  update(
    db: Db,
    id: string,
    data: Partial<TestCaseFiles> & { is_sample?: boolean; position?: number }
  ) {
    return db.testCase.update({ where: { id }, data });
  }

  delete(db: Db, id: string) {
    return db.testCase.delete({ where: { id } });
  }

  /** After a delete: the tests behind the removed one move up by one. */
  closeGap(db: Db, versionId: string, removedPosition: number) {
    return db.testCase.updateMany({
      where: { problem_version_id: versionId, position: { gt: removedPosition } },
      data: { position: { decrement: 1 } },
    });
  }

  setPosition(db: Db, id: string, position: number) {
    return db.testCase.update({ where: { id }, data: { position } });
  }
}
