import { TrackPrivacy } from '../../generated/prisma/enums';
import { Db, Prisma } from '@/repositories/db';
import { PUBLIC_USER_SELECT } from '@/services/user/user.mapper';

/**
 * Tracks and Collections (GRD-77 to GRD-82). The two `*Where` helpers are the
 * only definition of "what a solver can reach": a Track is reachable when it is
 * not archived and is open to the Space or the person was added to it, a
 * Collection through such a Track, a problem through such a Collection.
 */
export function trackVisibleWhere(userId: string | null): Prisma.TrackWhereInput {
  return {
    archived_at: null,
    OR: [{ privacy: 'space' }, ...(userId ? [{ members: { some: { user_id: userId } } }] : [])],
  };
}

export function collectionVisibleWhere(userId: string | null): Prisma.CollectionWhereInput {
  return { archived_at: null, tracks: { some: { track: trackVisibleWhere(userId) } } };
}

export function problemVisibleWhere(userId: string | null): Prisma.ProblemWhereInput {
  return { collections: { some: { collection: collectionVisibleWhere(userId) } } };
}

export interface TrackInput {
  name: string;
  slug: string;
  description: string;
  privacy: TrackPrivacy;
}

export interface CollectionInput {
  name: string;
  slug: string;
  description: string;
}

const PROBLEM_REF = {
  select: {
    id: true,
    slug: true,
    status: true,
    current_version: { select: { title: true } },
  },
} as const;

export type ProblemRef = Prisma.ProblemGetPayload<typeof PROBLEM_REF>;

export default class CatalogRepository {
  // --- tracks -------------------------------------------------------------

  findTrack(db: Db, spaceId: string, slug: string) {
    return db.track.findUnique({ where: { space_id_slug: { space_id: spaceId, slug } } });
  }

  findTrackById(db: Db, id: string) {
    return db.track.findUnique({ where: { id } });
  }

  listTracks(db: Db, spaceId: string, where: Prisma.TrackWhereInput = {}) {
    return db.track.findMany({
      where: { space_id: spaceId, ...where },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
  }

  async nextTrackPosition(db: Db, spaceId: string): Promise<number> {
    const last = await db.track.aggregate({
      where: { space_id: spaceId },
      _max: { position: true },
    });
    return (last._max.position ?? 0) + 1;
  }

  createTrack(db: Db, spaceId: string, createdById: string, input: TrackInput, position: number) {
    return db.track.create({
      data: { space_id: spaceId, created_by_id: createdById, ...input, position },
    });
  }

  updateTrack(
    db: Db,
    id: string,
    data: Partial<TrackInput> & { archived_at?: Date | null; position?: number }
  ) {
    return db.track.update({ where: { id }, data });
  }

  /** Sets the order of the given Tracks to 1..n, in the order given. */
  async setTrackOrder(db: Db, trackIds: string[]): Promise<void> {
    for (const [index, id] of trackIds.entries()) {
      await db.track.update({ where: { id }, data: { position: index + 1 } });
    }
  }

  // --- collections --------------------------------------------------------

  findCollection(db: Db, spaceId: string, slug: string) {
    return db.collection.findUnique({ where: { space_id_slug: { space_id: spaceId, slug } } });
  }

  findCollectionById(db: Db, id: string) {
    return db.collection.findUnique({ where: { id } });
  }

  listCollections(db: Db, spaceId: string, where: Prisma.CollectionWhereInput = {}) {
    return db.collection.findMany({
      where: { space_id: spaceId, ...where },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  createCollection(db: Db, spaceId: string, createdById: string, input: CollectionInput) {
    return db.collection.create({
      data: { space_id: spaceId, created_by_id: createdById, ...input },
    });
  }

  updateCollection(
    db: Db,
    id: string,
    data: Partial<CollectionInput> & { archived_at?: Date | null }
  ) {
    return db.collection.update({ where: { id }, data });
  }

  // --- Track <-> Collection ----------------------------------------------

  /** The Collections of a Track in order, with how many Tracks each one is in. */
  listTrackCollections(db: Db, trackId: string, collectionWhere: Prisma.CollectionWhereInput = {}) {
    return db.trackCollection.findMany({
      where: { track_id: trackId, collection: collectionWhere },
      include: { collection: true },
      orderBy: [{ position: 'asc' }, { collection_id: 'asc' }],
    });
  }

  /** Replaces the Collections of a Track with exactly these, in this order. */
  async setTrackCollections(db: Db, trackId: string, collectionIds: string[]): Promise<void> {
    await db.trackCollection.deleteMany({
      where: { track_id: trackId, collection_id: { notIn: collectionIds } },
    });
    for (const [index, collectionId] of collectionIds.entries()) {
      await db.trackCollection.upsert({
        where: { track_id_collection_id: { track_id: trackId, collection_id: collectionId } },
        create: { track_id: trackId, collection_id: collectionId, position: index + 1 },
        update: { position: index + 1 },
      });
    }
  }

  /** Tracks (name and slug) a Collection is in, for the management page. */
  listTracksOfCollection(db: Db, collectionId: string) {
    return db.trackCollection.findMany({
      where: { collection_id: collectionId },
      include: { track: { select: { id: true, name: true, slug: true, archived_at: true } } },
      orderBy: [{ track: { position: 'asc' } }],
    });
  }

  // --- Collection <-> Problem --------------------------------------------

  listCollectionProblems(
    db: Db,
    collectionId: string,
    problemWhere: Prisma.ProblemWhereInput = {}
  ) {
    return db.collectionProblem.findMany({
      where: { collection_id: collectionId, problem: problemWhere },
      include: { problem: PROBLEM_REF },
      orderBy: [{ position: 'asc' }, { problem_id: 'asc' }],
    });
  }

  async countCollectionProblems(db: Db, collectionId: string): Promise<number> {
    return db.collectionProblem.count({ where: { collection_id: collectionId } });
  }

  /** Replaces the problems of a Collection with exactly these, in this order. */
  async setCollectionProblems(db: Db, collectionId: string, problemIds: string[]): Promise<void> {
    await db.collectionProblem.deleteMany({
      where: { collection_id: collectionId, problem_id: { notIn: problemIds } },
    });
    for (const [index, problemId] of problemIds.entries()) {
      await db.collectionProblem.upsert({
        where: { collection_id_problem_id: { collection_id: collectionId, problem_id: problemId } },
        create: { collection_id: collectionId, problem_id: problemId, position: index + 1 },
        update: { position: index + 1 },
      });
    }
  }

  findProblemsBySlugs(db: Db, spaceId: string, slugs: string[]) {
    return db.problem.findMany({
      where: { space_id: spaceId, slug: { in: slugs } },
      select: { id: true, slug: true },
    });
  }

  /** Is this problem reachable by this person through a Track (GRD-81)? */
  async isProblemVisible(db: Db, problemId: string, userId: string | null): Promise<boolean> {
    const found = await db.problem.findFirst({
      where: { id: problemId, ...problemVisibleWhere(userId) },
      select: { id: true },
    });
    return found !== null;
  }

  // --- the problems of a Track (for progression) --------------------------

  /** Distinct published problems in the non-archived Collections of a Track. */
  async trackProblemIds(db: Db, trackId: string): Promise<string[]> {
    const rows = await db.collectionProblem.findMany({
      where: {
        problem: { status: 'published' },
        collection: { archived_at: null, tracks: { some: { track_id: trackId } } },
      },
      select: { problem_id: true },
      distinct: ['problem_id'],
    });
    return rows.map((row) => row.problem_id);
  }

  async collectionProblemIds(db: Db, collectionId: string): Promise<string[]> {
    const rows = await db.collectionProblem.findMany({
      where: { collection_id: collectionId, problem: { status: 'published' } },
      select: { problem_id: true },
    });
    return rows.map((row) => row.problem_id);
  }

  // --- members ------------------------------------------------------------

  findTrackMember(db: Db, trackId: string, userId: string) {
    return db.trackMember.findUnique({
      where: { track_id_user_id: { track_id: trackId, user_id: userId } },
    });
  }

  listTrackMembers(db: Db, trackId: string) {
    return db.trackMember.findMany({
      where: { track_id: trackId },
      include: { user: { select: PUBLIC_USER_SELECT } },
      orderBy: [{ joined_at: 'asc' }, { user_id: 'asc' }],
    });
  }

  addTrackMember(db: Db, trackId: string, userId: string, addedById: string) {
    return db.trackMember.create({
      data: { track_id: trackId, user_id: userId, added_by_id: addedById },
    });
  }

  removeTrackMember(db: Db, trackId: string, userId: string) {
    return db.trackMember.delete({
      where: { track_id_user_id: { track_id: trackId, user_id: userId } },
    });
  }

  // --- audit --------------------------------------------------------------

  audit(
    db: Db,
    event: {
      space_id: string;
      track_id?: string | null;
      actor_id: string;
      action: string;
      target_user_id?: string | null;
      data?: Prisma.InputJsonValue;
    }
  ) {
    return db.auditEvent.create({ data: event });
  }

  // --- what a person has solved ------------------------------------------

  /** Of these problems, the ones the user has an accepted submission for (any version). */
  async solvedProblemIds(db: Db, userId: string, problemIds: string[]): Promise<Set<string>> {
    if (problemIds.length === 0) return new Set();
    const rows = await db.submission.findMany({
      where: {
        user_id: userId,
        problem_id: { in: problemIds },
        status: 'completed',
        verdict: 'AC',
      },
      select: { problem_id: true },
      distinct: ['problem_id'],
    });
    return new Set(rows.map((row) => row.problem_id));
  }

  /** The verdict of the user's latest finished submission of each problem. */
  async latestVerdicts(db: Db, userId: string, problemIds: string[]) {
    if (problemIds.length === 0) return new Map<string, string>();
    const rows = await db.submission.findMany({
      where: { user_id: userId, problem_id: { in: problemIds }, status: 'completed' },
      select: { problem_id: true, verdict: true },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      distinct: ['problem_id'],
    });
    return new Map(rows.flatMap((row) => (row.verdict ? [[row.problem_id, row.verdict]] : [])));
  }

  /** Solved counts of many users over the same set of problems. */
  async solvedCounts(db: Db, userIds: string[], problemIds: string[]) {
    const counts = new Map<string, number>();
    if (userIds.length === 0 || problemIds.length === 0) return counts;
    const rows = await db.submission.findMany({
      where: {
        user_id: { in: userIds },
        problem_id: { in: problemIds },
        status: 'completed',
        verdict: 'AC',
      },
      select: { user_id: true, problem_id: true },
      distinct: ['user_id', 'problem_id'],
    });
    for (const row of rows) counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
    return counts;
  }
}
