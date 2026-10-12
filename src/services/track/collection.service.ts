import type { PrismaClient, User } from '../../../generated/prisma/client';
import { isValidGroupSlug } from '@/constants/identifiers';
import { TRACK_LIMITS } from '@/constants/limits';
import { ConflictError, NotFoundError, ValidationError } from '@/errors';
import TLogger, { Layer } from '@/logging/logger';
import { Db, isUniqueViolation } from '@/repositories/db';
import ProblemRepository from '@/repositories/problem.repository';
import SpaceRepository from '@/repositories/space.repository';
import SubmissionRepository from '@/repositories/submission.repository';
import TrackRepository, { CollectionWithProblems } from '@/repositories/track.repository';
import { assertCan } from '@/services/space/space.access';
import SpaceService from '@/services/space/space.service';
import { assertManage, isWriter } from '@/services/track/track.access';
import {
  CollectionDto,
  ProgressDto,
  TrackProblemDto,
  ViewerState,
  progressOf,
  toCollectionDto,
  toTrackProblemDto,
  visibleLinks,
} from '@/services/track/track.mapper';
import TrackService, { GROUP_SLUG_MESSAGE, assertSameSet } from '@/services/track/track.service';

export interface CreateCollectionInput {
  name: string;
  slug: string;
  description: string;
  /** Tracks to put the new Collection in (appended at their end). */
  track_slugs: string[];
}

export interface UpdateCollectionInput {
  name?: string;
  slug?: string;
  description?: string;
}

export interface CollectionDetailDto extends CollectionDto {
  problems: TrackProblemDto[];
  /** The Tracks this Collection sits in; only owners and editors see this. */
  tracks: Array<{ id: string; slug: string; name: string; position: number }> | null;
  progress: ProgressDto | null;
}

export default class CollectionService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly tracks: TrackRepository,
    private readonly problems: ProblemRepository,
    private readonly spaces: SpaceRepository,
    private readonly submissions: SubmissionRepository,
    private readonly spaceService: SpaceService,
    private readonly trackService: TrackService
  ) {}

  // --- reading ------------------------------------------------------------

  /** Owners and editors: every Collection of the Space, with or without a Track. */
  async list(user: User | null, slug: string): Promise<{ items: CollectionDetailDto[] }> {
    const access = await this.spaceService.load(this.prisma, slug, user);
    const manager = assertManage(user, 'track.manage', access);
    const rows = await this.tracks.listCollections(this.prisma, access.space.id);
    const state = await this.writerState(manager, rows);
    return {
      items: rows.map((row) =>
        this.detail(
          row,
          state,
          [...row.tracks].map((link) => ({ ...link.track, position: link.position }))
        )
      ),
    };
  }

  /**
   * One Collection. Owners and editors always; everyone else only when it is
   * not archived and sits in a Track they can see (GRD-81), otherwise 404.
   */
  async get(user: User | null, slug: string, collectionSlug: string): Promise<CollectionDetailDto> {
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, 'space.view', access);
    const collection = await this.tracks.findCollectionWithProblems(
      this.prisma,
      access.space.id,
      collectionSlug.toLowerCase()
    );
    if (!collection) throw new NotFoundError('Collection not found.');
    const writer = isWriter(user, access);
    if (!writer) {
      const visible =
        collection.archived_at === null &&
        (await this.isInVisibleTrack(this.prisma, collection.id, access.space.id, user));
      if (!visible) throw new NotFoundError('Collection not found.');
    }
    const state = await this.readerState(user, collection, writer);
    const trackLinks = writer
      ? (await this.tracks.tracksOfCollection(this.prisma, collection.id)).map((link) => ({
          ...link.track,
          position: link.position,
        }))
      : null;
    return this.detail(collection, state, trackLinks);
  }

  // --- changing -----------------------------------------------------------

  async create(user: User, slug: string, input: CreateCollectionInput, requestId: string) {
    const logger = this.logger.setContext('service.collection.create', requestId);
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertManage(user, 'track.manage', access);
    const collectionSlug = input.slug.toLowerCase();
    if (!isValidGroupSlug(collectionSlug)) {
      throw new ValidationError([{ field: 'slug', message: GROUP_SLUG_MESSAGE(collectionSlug) }]);
    }
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await this.spaces.lock(tx, access.space.id);
        if (
          (await this.tracks.countCollections(tx, access.space.id)) >=
          TRACK_LIMITS.max_collections_per_space
        ) {
          throw new ConflictError(
            `A Space can have at most ${TRACK_LIMITS.max_collections_per_space} Collections.`,
            'COLLECTION_LIMIT'
          );
        }
        if (await this.tracks.isCollectionSlugTaken(tx, access.space.id, collectionSlug)) {
          throw new ConflictError('A Collection with this slug already exists in this Space.');
        }
        const targetTracks = [];
        for (const trackSlug of new Set(input.track_slugs.map((entry) => entry.toLowerCase()))) {
          const track = await this.tracks.findTrackBySlug(tx, access.space.id, trackSlug);
          if (!track) {
            throw new ValidationError([
              { field: 'track_slugs', message: `There is no Track “${trackSlug}” in this Space.` },
            ]);
          }
          targetTracks.push(track);
        }
        const collection = await this.tracks.createCollection(tx, {
          space_id: access.space.id,
          name: input.name,
          slug: collectionSlug,
          description: input.description,
        });
        for (const track of targetTracks) {
          const links = await this.tracks.listTrackCollectionLinks(tx, track.id);
          await this.tracks.addCollectionsToTrack(tx, track.id, [collection.id], links.length + 1);
        }
        return collection;
      });
      logger.info({
        message: 'collection created',
        data: { collectionId: created.id, spaceId: access.space.id },
      });
      return this.get(user, slug, created.slug);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('A Collection with this slug already exists in this Space.');
      }
      throw error;
    }
  }

  async update(
    user: User,
    slug: string,
    collectionSlug: string,
    input: UpdateCollectionInput,
    requestId: string
  ) {
    const logger = this.logger.setContext('service.collection.update', requestId);
    const { access, collection } = await this.loadForManager(user, slug, collectionSlug);
    const newSlug = input.slug?.toLowerCase();
    if (newSlug !== undefined && newSlug !== collection.slug && !isValidGroupSlug(newSlug)) {
      throw new ValidationError([{ field: 'slug', message: GROUP_SLUG_MESSAGE(newSlug) }]);
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        if (newSlug !== undefined && newSlug !== collection.slug) {
          if (await this.tracks.isCollectionSlugTaken(tx, access.space.id, newSlug)) {
            throw new ConflictError('A Collection with this slug already exists in this Space.');
          }
        }
        await this.tracks.updateCollection(tx, collection.id, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(newSlug !== undefined ? { slug: newSlug } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('A Collection with this slug already exists in this Space.');
      }
      throw error;
    }
    logger.info({
      message: 'collection updated',
      data: { collectionId: collection.id, fields: Object.keys(input) },
    });
    return this.get(user, slug, newSlug ?? collection.slug);
  }

  async archive(user: User, slug: string, collectionSlug: string, requestId: string) {
    const { collection } = await this.loadForManager(user, slug, collectionSlug);
    if (collection.archived_at === null) {
      await this.tracks.updateCollection(this.prisma, collection.id, { archived_at: new Date() });
      this.logger
        .setContext('service.collection.archive', requestId)
        .info({ message: 'collection archived', data: { collectionId: collection.id } });
    }
    return this.get(user, slug, collection.slug);
  }

  async restore(user: User, slug: string, collectionSlug: string, requestId: string) {
    const { collection } = await this.loadForManager(user, slug, collectionSlug);
    if (collection.archived_at !== null) {
      await this.tracks.updateCollection(this.prisma, collection.id, { archived_at: null });
      this.logger
        .setContext('service.collection.restore', requestId)
        .info({ message: 'collection restored', data: { collectionId: collection.id } });
    }
    return this.get(user, slug, collection.slug);
  }

  // --- problems in a Collection ------------------------------------------

  /** Adds problems (drafts included: solvers will not see those yet) to the end, in the order given. */
  async addProblems(
    user: User,
    slug: string,
    collectionSlug: string,
    problemSlugs: string[],
    requestId: string
  ) {
    const logger = this.logger.setContext('service.collection.addProblems', requestId);
    const { access, collection } = await this.loadForManager(user, slug, collectionSlug);
    await this.prisma.$transaction(async (tx) => {
      await this.spaces.lock(tx, access.space.id);
      const found = await this.resolveProblems(tx, access.space.id, problemSlugs);
      const links = await this.tracks.listCollectionProblemLinks(tx, collection.id);
      const present = new Set(links.map((link) => link.problem_id));
      const fresh = found.filter((problem) => !present.has(problem.id));
      if (links.length + fresh.length > TRACK_LIMITS.max_problems_per_collection) {
        throw new ConflictError(
          `A Collection can hold at most ${TRACK_LIMITS.max_problems_per_collection} problems.`,
          'COLLECTION_FULL'
        );
      }
      await this.tracks.addProblemsToCollection(
        tx,
        collection.id,
        fresh.map((problem) => problem.id),
        links.length + 1
      );
    });
    logger.info({
      message: 'problems added to collection',
      data: { collectionId: collection.id, count: problemSlugs.length },
    });
    return this.get(user, slug, collection.slug);
  }

  /** Takes problems out of the Collection. The problems themselves are untouched; absent ones are ignored. */
  async removeProblems(
    user: User,
    slug: string,
    collectionSlug: string,
    problemSlugs: string[],
    requestId: string
  ) {
    const logger = this.logger.setContext('service.collection.removeProblems', requestId);
    const { access, collection } = await this.loadForManager(user, slug, collectionSlug);
    await this.prisma.$transaction(async (tx) => {
      await this.spaces.lock(tx, access.space.id);
      const found = await this.resolveProblems(tx, access.space.id, problemSlugs);
      await this.tracks.removeProblemsFromCollection(
        tx,
        collection.id,
        found.map((problem) => problem.id)
      );
    });
    logger.info({
      message: 'problems removed from collection',
      data: { collectionId: collection.id, count: problemSlugs.length },
    });
    return this.get(user, slug, collection.slug);
  }

  async reorderProblems(
    user: User,
    slug: string,
    collectionSlug: string,
    problemIds: string[],
    requestId: string
  ) {
    const logger = this.logger.setContext('service.collection.reorderProblems', requestId);
    const { access, collection } = await this.loadForManager(user, slug, collectionSlug);
    await this.prisma.$transaction(async (tx) => {
      await this.spaces.lock(tx, access.space.id);
      const links = await this.tracks.listCollectionProblemLinks(tx, collection.id);
      assertSameSet(
        links.map((link) => link.problem_id),
        problemIds,
        'Send every problem of the Collection exactly once.'
      );
      await this.tracks.setCollectionProblemPositions(tx, collection.id, problemIds);
    });
    logger.info({
      message: 'collection problems reordered',
      data: { collectionId: collection.id },
    });
    return this.get(user, slug, collection.slug);
  }

  // --- Collections in a Track --------------------------------------------

  async addToTrack(
    user: User,
    slug: string,
    trackSlug: string,
    collectionSlugs: string[],
    requestId: string
  ) {
    const logger = this.logger.setContext('service.collection.addToTrack', requestId);
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertManage(user, 'track.manage', access);
    await this.prisma.$transaction(async (tx) => {
      await this.spaces.lock(tx, access.space.id);
      const track = await this.tracks.findTrackBySlug(tx, access.space.id, trackSlug.toLowerCase());
      if (!track) throw new NotFoundError('Track not found.');
      const found = await this.resolveCollections(tx, access.space.id, collectionSlugs);
      const links = await this.tracks.listTrackCollectionLinks(tx, track.id);
      const present = new Set(links.map((link) => link.collection_id));
      await this.tracks.addCollectionsToTrack(
        tx,
        track.id,
        found
          .filter((collection) => !present.has(collection.id))
          .map((collection) => collection.id),
        links.length + 1
      );
    });
    logger.info({ message: 'collections added to track', data: { trackSlug } });
    return this.trackView(user, slug, trackSlug);
  }

  async removeFromTrack(
    user: User,
    slug: string,
    trackSlug: string,
    collectionSlugs: string[],
    requestId: string
  ) {
    const logger = this.logger.setContext('service.collection.removeFromTrack', requestId);
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertManage(user, 'track.manage', access);
    await this.prisma.$transaction(async (tx) => {
      await this.spaces.lock(tx, access.space.id);
      const track = await this.tracks.findTrackBySlug(tx, access.space.id, trackSlug.toLowerCase());
      if (!track) throw new NotFoundError('Track not found.');
      const found = await this.resolveCollections(tx, access.space.id, collectionSlugs);
      await this.tracks.removeCollectionsFromTrack(
        tx,
        track.id,
        found.map((collection) => collection.id)
      );
    });
    logger.info({ message: 'collections removed from track', data: { trackSlug } });
    return this.trackView(user, slug, trackSlug);
  }

  async reorderInTrack(
    user: User,
    slug: string,
    trackSlug: string,
    collectionIds: string[],
    requestId: string
  ) {
    const logger = this.logger.setContext('service.collection.reorderInTrack', requestId);
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertManage(user, 'track.manage', access);
    await this.prisma.$transaction(async (tx) => {
      await this.spaces.lock(tx, access.space.id);
      const track = await this.tracks.findTrackBySlug(tx, access.space.id, trackSlug.toLowerCase());
      if (!track) throw new NotFoundError('Track not found.');
      const links = await this.tracks.listTrackCollectionLinks(tx, track.id);
      assertSameSet(
        links.map((link) => link.collection_id),
        collectionIds,
        'Send every Collection of the Track exactly once.'
      );
      await this.tracks.setTrackCollectionPositions(tx, track.id, collectionIds);
    });
    logger.info({ message: 'collections reordered in track', data: { trackSlug } });
    return this.trackView(user, slug, trackSlug);
  }

  // --- internals ----------------------------------------------------------

  private trackView(user: User, slug: string, trackSlug: string) {
    return this.trackService.get(user, slug, trackSlug);
  }

  private async loadForManager(user: User, slug: string, collectionSlug: string) {
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertManage(user, 'track.manage', access);
    const collection = await this.tracks.findCollectionBySlug(
      this.prisma,
      access.space.id,
      collectionSlug.toLowerCase()
    );
    if (!collection) throw new NotFoundError('Collection not found.');
    return { access, collection };
  }

  private async resolveProblems(db: Db, spaceId: string, problemSlugs: string[]) {
    const unique = [...new Set(problemSlugs.map((entry) => entry.toLowerCase()))];
    const found = [];
    const missing: string[] = [];
    for (const problemSlug of unique) {
      const problem = await this.problems.findBySlug(db, spaceId, problemSlug);
      if (problem) found.push(problem);
      else missing.push(problemSlug);
    }
    if (missing.length > 0) {
      throw new ValidationError(
        missing.map((entry) => ({
          field: 'problem_slugs',
          message: `There is no problem “${entry}” in this Space.`,
        }))
      );
    }
    return found;
  }

  private async resolveCollections(db: Db, spaceId: string, collectionSlugs: string[]) {
    const unique = [...new Set(collectionSlugs.map((entry) => entry.toLowerCase()))];
    const found = [];
    const missing: string[] = [];
    for (const collectionSlug of unique) {
      const collection = await this.tracks.findCollectionBySlug(db, spaceId, collectionSlug);
      if (collection) found.push(collection);
      else missing.push(collectionSlug);
    }
    if (missing.length > 0) {
      throw new ValidationError(
        missing.map((entry) => ({
          field: 'collection_slugs',
          message: `There is no Collection “${entry}” in this Space.`,
        }))
      );
    }
    return found;
  }

  private isInVisibleTrack(db: Db, collectionId: string, spaceId: string, user: User | null) {
    return db.trackCollection
      .findFirst({
        where: {
          collection_id: collectionId,
          track: {
            space_id: spaceId,
            archived_at: null,
            OR: [
              { visibility: 'space' },
              ...(user ? [{ members: { some: { user_id: user.id } } }] : []),
            ],
          },
        },
        select: { track_id: true },
      })
      .then((found) => found !== null);
  }

  private async writerState(user: User, rows: CollectionWithProblems[]): Promise<ViewerState> {
    const ids = [...new Set(rows.flatMap((row) => row.problems.map((link) => link.problem.id)))];
    const [solved, verdicts] = await Promise.all([
      this.submissions.solvedBy(this.prisma, [user.id], ids),
      this.submissions.latestVerdicts(this.prisma, user.id, ids),
    ]);
    return { isWriter: true, solved: solved.get(user.id) ?? new Set(), verdicts };
  }

  private async readerState(
    user: User | null,
    collection: CollectionWithProblems,
    writer: boolean
  ): Promise<ViewerState> {
    if (!user) return { isWriter: writer, solved: null, verdicts: new Map() };
    const ids = collection.problems.map((link) => link.problem.id);
    const [solved, verdicts] = await Promise.all([
      this.submissions.solvedBy(this.prisma, [user.id], ids),
      this.submissions.latestVerdicts(this.prisma, user.id, ids),
    ]);
    return { isWriter: writer, solved: solved.get(user.id) ?? new Set(), verdicts };
  }

  private detail(
    collection: CollectionWithProblems,
    state: ViewerState,
    tracks: CollectionDetailDto['tracks']
  ): CollectionDetailDto {
    return {
      ...toCollectionDto(collection),
      problems: visibleLinks(collection.problems, state.isWriter).map((link) =>
        toTrackProblemDto(link, state)
      ),
      tracks,
      progress: progressOf(collection.problems, state.solved),
    };
  }
}
