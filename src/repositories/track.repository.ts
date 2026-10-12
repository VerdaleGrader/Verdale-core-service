import { TrackVisibility } from '../../generated/prisma/enums';
import { STARTER_TRACK } from '@/constants/identifiers';
import { Db, Prisma } from '@/repositories/db';

/** Who is looking: the user (null for a visitor). Writers skip every filter. */
export interface Viewer {
  userId: string | null;
}

const PROBLEM_FOR_LIST = {
  select: {
    id: true,
    slug: true,
    status: true,
    current_version: { select: { title: true, version_number: true } },
  },
} as const;

const COLLECTION_WITH_PROBLEMS = {
  include: {
    problems: { orderBy: { position: 'asc' }, include: { problem: PROBLEM_FOR_LIST } },
  },
} as const;

const TRACK_WITH_CONTENT = {
  collections: {
    orderBy: { position: 'asc' },
    include: { collection: COLLECTION_WITH_PROBLEMS },
  },
} as const;

/** The Prisma condition for "a Track this viewer may see" (the same rule as `can('track.view')`). */
export function visibleTrackWhere(viewer: Viewer): Prisma.TrackWhereInput {
  return {
    archived_at: null,
    OR: [
      { visibility: 'space' },
      ...(viewer.userId ? [{ members: { some: { user_id: viewer.userId } } }] : []),
    ],
  };
}

export default class TrackRepository {
  // --- tracks -------------------------------------------------------------

  findTrackBySlug(db: Db, spaceId: string, slug: string) {
    return db.track.findUnique({ where: { space_id_slug: { space_id: spaceId, slug } } });
  }

  findTrackWithContent(db: Db, spaceId: string, slug: string) {
    return db.track.findUnique({
      where: { space_id_slug: { space_id: spaceId, slug } },
      include: TRACK_WITH_CONTENT,
    });
  }

  findTrackById(db: Db, id: string) {
    return db.track.findUnique({ where: { id } });
  }

  /** Every Track of a Space (with its content) that the viewer may see, in order. */
  listTracksWithContent(db: Db, spaceId: string, viewer: Viewer | 'writer') {
    return db.track.findMany({
      where: { space_id: spaceId, ...(viewer === 'writer' ? {} : visibleTrackWhere(viewer)) },
      include: TRACK_WITH_CONTENT,
      orderBy: [
        { archived_at: { sort: 'asc', nulls: 'first' } },
        { position: 'asc' },
        { id: 'asc' },
      ],
    });
  }

  /** Tracks of a Space that are not archived, in order (the set a reorder must name). */
  listActiveTracks(db: Db, spaceId: string) {
    return db.track.findMany({
      where: { space_id: spaceId, archived_at: null },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
  }

  countTracks(db: Db, spaceId: string) {
    return db.track.count({ where: { space_id: spaceId } });
  }

  async nextTrackPosition(db: Db, spaceId: string): Promise<number> {
    const last = await db.track.aggregate({
      where: { space_id: spaceId },
      _max: { position: true },
    });
    return (last._max.position ?? 0) + 1;
  }

  async isTrackSlugTaken(db: Db, spaceId: string, slug: string): Promise<boolean> {
    return (await this.findTrackBySlug(db, spaceId, slug)) !== null;
  }

  createTrack(
    db: Db,
    data: {
      space_id: string;
      name: string;
      slug: string;
      description: string;
      position: number;
      visibility: TrackVisibility;
    }
  ) {
    return db.track.create({ data });
  }

  /** The Track a new Space starts with (GRD-78); runs inside the caller's transaction. */
  createStarterTrack(db: Db, spaceId: string, name: string = STARTER_TRACK.name) {
    return this.createTrack(db, {
      space_id: spaceId,
      name,
      slug: STARTER_TRACK.slug,
      description: '',
      position: 1,
      visibility: 'space',
    });
  }

  updateTrack(
    db: Db,
    id: string,
    data: {
      name?: string;
      slug?: string;
      description?: string;
      visibility?: TrackVisibility;
      archived_at?: Date | null;
      position?: number;
    }
  ) {
    return db.track.update({ where: { id }, data });
  }

  async setTrackPositions(db: Db, orderedIds: string[]) {
    for (const [index, id] of orderedIds.entries()) {
      await db.track.update({ where: { id }, data: { position: index + 1 } });
    }
  }

  // --- collections --------------------------------------------------------

  findCollectionBySlug(db: Db, spaceId: string, slug: string) {
    return db.collection.findUnique({ where: { space_id_slug: { space_id: spaceId, slug } } });
  }

  findCollectionWithProblems(db: Db, spaceId: string, slug: string) {
    return db.collection.findUnique({
      where: { space_id_slug: { space_id: spaceId, slug } },
      ...COLLECTION_WITH_PROBLEMS,
    });
  }

  /** Collections of a Space, each with its problems and the Tracks it sits in (owners and editors). */
  listCollections(db: Db, spaceId: string) {
    return db.collection.findMany({
      where: { space_id: spaceId },
      include: {
        ...COLLECTION_WITH_PROBLEMS.include,
        tracks: { include: { track: { select: { id: true, slug: true, name: true } } } },
      },
      orderBy: [{ archived_at: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }, { id: 'asc' }],
    });
  }

  countCollections(db: Db, spaceId: string) {
    return db.collection.count({ where: { space_id: spaceId } });
  }

  async isCollectionSlugTaken(db: Db, spaceId: string, slug: string): Promise<boolean> {
    return (await this.findCollectionBySlug(db, spaceId, slug)) !== null;
  }

  createCollection(
    db: Db,
    data: { space_id: string; name: string; slug: string; description: string }
  ) {
    return db.collection.create({ data });
  }

  updateCollection(
    db: Db,
    id: string,
    data: { name?: string; slug?: string; description?: string; archived_at?: Date | null }
  ) {
    return db.collection.update({ where: { id }, data });
  }

  /** The Tracks a Collection sits in. */
  tracksOfCollection(db: Db, collectionId: string) {
    return db.trackCollection.findMany({
      where: { collection_id: collectionId },
      include: { track: { select: { id: true, slug: true, name: true } } },
      orderBy: [{ track: { position: 'asc' } }],
    });
  }

  // --- track <-> collection ----------------------------------------------

  listTrackCollectionLinks(db: Db, trackId: string) {
    return db.trackCollection.findMany({
      where: { track_id: trackId },
      orderBy: [{ position: 'asc' }, { collection_id: 'asc' }],
    });
  }

  async addCollectionsToTrack(db: Db, trackId: string, collectionIds: string[], startAt: number) {
    if (collectionIds.length === 0) return;
    await db.trackCollection.createMany({
      data: collectionIds.map((collection_id, index) => ({
        track_id: trackId,
        collection_id,
        position: startAt + index,
      })),
      skipDuplicates: true,
    });
  }

  async removeCollectionsFromTrack(db: Db, trackId: string, collectionIds: string[]) {
    await db.trackCollection.deleteMany({
      where: { track_id: trackId, collection_id: { in: collectionIds } },
    });
    await this.compactTrackCollections(db, trackId);
  }

  async setTrackCollectionPositions(db: Db, trackId: string, orderedCollectionIds: string[]) {
    for (const [index, collectionId] of orderedCollectionIds.entries()) {
      await db.trackCollection.update({
        where: { track_id_collection_id: { track_id: trackId, collection_id: collectionId } },
        data: { position: index + 1 },
      });
    }
  }

  private async compactTrackCollections(db: Db, trackId: string) {
    const links = await this.listTrackCollectionLinks(db, trackId);
    await this.setTrackCollectionPositions(
      db,
      trackId,
      links.map((link) => link.collection_id)
    );
  }

  // --- collection <-> problem --------------------------------------------

  listCollectionProblemLinks(db: Db, collectionId: string) {
    return db.collectionProblem.findMany({
      where: { collection_id: collectionId },
      orderBy: [{ position: 'asc' }, { problem_id: 'asc' }],
    });
  }

  async addProblemsToCollection(
    db: Db,
    collectionId: string,
    problemIds: string[],
    startAt: number
  ) {
    if (problemIds.length === 0) return;
    await db.collectionProblem.createMany({
      data: problemIds.map((problem_id, index) => ({
        collection_id: collectionId,
        problem_id,
        position: startAt + index,
      })),
      skipDuplicates: true,
    });
  }

  async removeProblemsFromCollection(db: Db, collectionId: string, problemIds: string[]) {
    await db.collectionProblem.deleteMany({
      where: { collection_id: collectionId, problem_id: { in: problemIds } },
    });
    const links = await this.listCollectionProblemLinks(db, collectionId);
    await this.setCollectionProblemPositions(
      db,
      collectionId,
      links.map((link) => link.problem_id)
    );
  }

  async setCollectionProblemPositions(db: Db, collectionId: string, orderedProblemIds: string[]) {
    for (const [index, problemId] of orderedProblemIds.entries()) {
      await db.collectionProblem.update({
        where: { collection_id_problem_id: { collection_id: collectionId, problem_id: problemId } },
        data: { position: index + 1 },
      });
    }
  }

  // --- reader rule (GRD-81) ----------------------------------------------

  /**
   * Is the problem in a Collection of a Track this viewer may see? The
   * Collection must not be archived either. One query; the rule for solvers,
   * outsiders and visitors.
   */
  async isProblemInVisibleTrack(
    db: Db,
    spaceId: string,
    problemId: string,
    viewer: Viewer
  ): Promise<boolean> {
    const found = await db.collectionProblem.findFirst({
      where: {
        problem_id: problemId,
        collection: {
          archived_at: null,
          tracks: { some: { track: { space_id: spaceId, ...visibleTrackWhere(viewer) } } },
        },
      },
      select: { problem_id: true },
    });
    return found !== null;
  }

  /** The same condition as a filter on problems, for listings. */
  problemInVisibleTrackWhere(viewer: Viewer): Prisma.ProblemWhereInput {
    return {
      collection_entries: {
        some: {
          collection: {
            archived_at: null,
            tracks: { some: { track: visibleTrackWhere(viewer) } },
          },
        },
      },
    };
  }

  // --- track members ------------------------------------------------------

  findTrackMember(db: Db, trackId: string, userId: string) {
    return db.trackMember.findUnique({
      where: { track_id_user_id: { track_id: trackId, user_id: userId } },
    });
  }

  addTrackMember(db: Db, trackId: string, userId: string) {
    return db.trackMember.create({ data: { track_id: trackId, user_id: userId } });
  }

  async removeTrackMember(db: Db, trackId: string, userId: string): Promise<boolean> {
    const result = await db.trackMember.deleteMany({
      where: { track_id: trackId, user_id: userId },
    });
    return result.count === 1;
  }

  listTrackMembers(db: Db, trackId: string) {
    return db.trackMember.findMany({
      where: { track_id: trackId },
      include: {
        user: { select: { id: true, username: true, display_name: true, avatar_url: true } },
      },
      orderBy: [{ created_at: 'asc' }, { user_id: 'asc' }],
    });
  }

  /** When someone leaves or is removed from a Space they leave its Tracks too. */
  removeUserFromSpaceTracks(db: Db, spaceId: string, userId: string) {
    return db.trackMember.deleteMany({ where: { user_id: userId, track: { space_id: spaceId } } });
  }

  /** The Tracks of a Space this user was added to (to decide what a solver sees). */
  trackIdsOfMember(db: Db, spaceId: string, userId: string) {
    return db.trackMember
      .findMany({
        where: { user_id: userId, track: { space_id: spaceId } },
        select: { track_id: true },
      })
      .then((rows) => new Set(rows.map((row) => row.track_id)));
  }
}

export type TrackWithContent = NonNullable<
  Awaited<ReturnType<TrackRepository['findTrackWithContent']>>
>;
export type CollectionWithProblems = NonNullable<
  Awaited<ReturnType<TrackRepository['findCollectionWithProblems']>>
>;
