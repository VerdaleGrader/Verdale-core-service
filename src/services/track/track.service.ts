import type { PrismaClient, User } from '../../../generated/prisma/client';
import {
  PROBLEM_SLUG_PATTERN,
  RESERVED_GROUP_SLUGS,
  isValidGroupSlug,
} from '@/constants/identifiers';
import { TRACK_LIMITS } from '@/constants/limits';
import { ConflictError, NotFoundError, ValidationError } from '@/errors';
import { can } from '@/permissions/can';
import TLogger, { Layer } from '@/logging/logger';
import { Db, isUniqueViolation } from '@/repositories/db';
import SpaceRepository from '@/repositories/space.repository';
import SubmissionRepository from '@/repositories/submission.repository';
import TrackRepository, { TrackWithContent, Viewer } from '@/repositories/track.repository';
import { SpaceAccess, actorOf, assertCan, resourceOf } from '@/services/space/space.access';
import SpaceService from '@/services/space/space.service';
import { assertManage, isWriter } from '@/services/track/track.access';
import {
  TrackDetailDto,
  TrackDto,
  ViewerState,
  toTrackDetailDto,
  toTrackDto,
} from '@/services/track/track.mapper';

export interface CreateTrackInput {
  name: string;
  slug: string;
  description: string;
  visibility: 'space' | 'members';
}

export interface UpdateTrackInput {
  name?: string;
  slug?: string;
  description?: string;
  visibility?: 'space' | 'members';
}

export const GROUP_SLUG_MESSAGE = (slug: string) =>
  RESERVED_GROUP_SLUGS.has(slug)
    ? 'This slug is reserved. Pick another.'
    : `Use 2 to 64 lower-case letters, digits, "_" or "-", starting with a letter or digit (${PROBLEM_SLUG_PATTERN.source}).`;

export default class TrackService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly tracks: TrackRepository,
    private readonly spaces: SpaceRepository,
    private readonly submissions: SubmissionRepository,
    private readonly spaceService: SpaceService
  ) {}

  // --- shared lookups -----------------------------------------------------

  /** The Space (404 when the caller may not see it) and the Track (404 when missing or hidden from them). */
  async loadForReader(db: Db, user: User | null, slug: string, trackSlug: string) {
    const access = await this.spaceService.load(db, slug, user);
    assertCan(user, 'space.view', access);
    const track = await this.tracks.findTrackWithContent(
      db,
      access.space.id,
      trackSlug.toLowerCase()
    );
    if (!track || !(await this.mayViewTrack(db, user, access, track))) {
      throw new NotFoundError('Track not found.');
    }
    return { access, track };
  }

  /** For owners and editors: the permission is checked first, then the Track is looked up. */
  async loadForManager(
    db: Db,
    user: User | null,
    action: 'track.manage' | 'track.manage_members',
    slug: string,
    trackSlug: string
  ) {
    const access = await this.spaceService.load(db, slug, user);
    const manager = assertManage(user, action, access);
    const track = await this.tracks.findTrackBySlug(db, access.space.id, trackSlug.toLowerCase());
    if (!track) throw new NotFoundError('Track not found.');
    return { access, track, user: manager };
  }

  private async mayViewTrack(
    db: Db,
    user: User | null,
    access: SpaceAccess,
    track: { id: string; visibility: 'space' | 'members'; archived_at: Date | null }
  ): Promise<boolean> {
    const isMember = user
      ? (await this.tracks.findTrackMember(db, track.id, user.id)) !== null
      : false;
    return can(
      actorOf(user),
      'track.view',
      resourceOf(access, {
        track: {
          visibility: track.visibility,
          archived: track.archived_at !== null,
          isMember,
        },
      })
    );
  }

  /** What the viewer has solved among the given problems, and their latest verdicts. */
  async viewerState(
    db: Db,
    user: User | null,
    access: SpaceAccess,
    tracks: TrackWithContent[],
    withVerdicts: boolean
  ): Promise<ViewerState> {
    const problemIds = new Set<string>();
    for (const track of tracks) {
      for (const link of track.collections) {
        for (const entry of link.collection.problems) problemIds.add(entry.problem.id);
      }
    }
    const writer = isWriter(user, access);
    if (!user) return { isWriter: writer, solved: null, verdicts: new Map() };
    const ids = [...problemIds];
    const [solvedBy, verdicts] = await Promise.all([
      this.submissions.solvedBy(db, [user.id], ids),
      withVerdicts ? this.submissions.latestVerdicts(db, user.id, ids) : Promise.resolve(new Map()),
    ]);
    return { isWriter: writer, solved: solvedBy.get(user.id) ?? new Set(), verdicts };
  }

  // --- reading ------------------------------------------------------------

  /** The Tracks this caller can see, in order. Solvers never see a Collection or problem outside them. */
  async list(user: User | null, slug: string): Promise<{ items: TrackDto[] }> {
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, 'space.view', access);
    const writer = isWriter(user, access);
    const viewer: Viewer = { userId: user?.id ?? null };
    const tracks = await this.tracks.listTracksWithContent(
      this.prisma,
      access.space.id,
      writer ? 'writer' : viewer
    );
    const state = await this.viewerState(this.prisma, user, access, tracks, false);
    return { items: tracks.map((track) => toTrackDto(track, state)) };
  }

  async get(user: User | null, slug: string, trackSlug: string): Promise<TrackDetailDto> {
    const { access, track } = await this.loadForReader(this.prisma, user, slug, trackSlug);
    const state = await this.viewerState(this.prisma, user, access, [track], true);
    return toTrackDetailDto(track, state);
  }

  // --- changing -----------------------------------------------------------

  async create(user: User, slug: string, input: CreateTrackInput, requestId: string) {
    const logger = this.logger.setContext('service.track.create', requestId);
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertManage(user, 'track.manage', access);
    const trackSlug = input.slug.toLowerCase();
    if (!isValidGroupSlug(trackSlug)) {
      throw new ValidationError([{ field: 'slug', message: GROUP_SLUG_MESSAGE(trackSlug) }]);
    }
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await this.spaces.lock(tx, access.space.id);
        if (
          (await this.tracks.countTracks(tx, access.space.id)) >= TRACK_LIMITS.max_tracks_per_space
        ) {
          throw new ConflictError(
            `A Space can have at most ${TRACK_LIMITS.max_tracks_per_space} Tracks.`,
            'TRACK_LIMIT'
          );
        }
        if (await this.tracks.isTrackSlugTaken(tx, access.space.id, trackSlug)) {
          throw new ConflictError('A Track with this slug already exists in this Space.');
        }
        return this.tracks.createTrack(tx, {
          space_id: access.space.id,
          name: input.name,
          slug: trackSlug,
          description: input.description,
          position: await this.tracks.nextTrackPosition(tx, access.space.id),
          visibility: input.visibility,
        });
      });
      logger.info({
        message: 'track created',
        data: { trackId: created.id, spaceId: access.space.id },
      });
      return this.get(user, slug, created.slug);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('A Track with this slug already exists in this Space.');
      }
      throw error;
    }
  }

  async update(
    user: User,
    slug: string,
    trackSlug: string,
    input: UpdateTrackInput,
    requestId: string
  ) {
    const logger = this.logger.setContext('service.track.update', requestId);
    const { access, track } = await this.loadForManager(
      this.prisma,
      user,
      'track.manage',
      slug,
      trackSlug
    );
    const newSlug = input.slug?.toLowerCase();
    if (newSlug !== undefined && newSlug !== track.slug && !isValidGroupSlug(newSlug)) {
      throw new ValidationError([{ field: 'slug', message: GROUP_SLUG_MESSAGE(newSlug) }]);
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        if (newSlug !== undefined && newSlug !== track.slug) {
          if (await this.tracks.isTrackSlugTaken(tx, access.space.id, newSlug)) {
            throw new ConflictError('A Track with this slug already exists in this Space.');
          }
        }
        await this.tracks.updateTrack(tx, track.id, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(newSlug !== undefined ? { slug: newSlug } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('A Track with this slug already exists in this Space.');
      }
      throw error;
    }
    logger.info({
      message: 'track updated',
      data: { trackId: track.id, fields: Object.keys(input) },
    });
    return this.get(user, slug, newSlug ?? track.slug);
  }

  /** Archiving hides the Track from solvers; its Collections and problems stay where they are. */
  async archive(user: User, slug: string, trackSlug: string, requestId: string) {
    const logger = this.logger.setContext('service.track.archive', requestId);
    const { track } = await this.loadForManager(this.prisma, user, 'track.manage', slug, trackSlug);
    if (track.archived_at === null) {
      await this.tracks.updateTrack(this.prisma, track.id, { archived_at: new Date() });
      logger.info({ message: 'track archived', data: { trackId: track.id } });
    }
    return this.get(user, slug, track.slug);
  }

  async restore(user: User, slug: string, trackSlug: string, requestId: string) {
    const logger = this.logger.setContext('service.track.restore', requestId);
    const { access, track } = await this.loadForManager(
      this.prisma,
      user,
      'track.manage',
      slug,
      trackSlug
    );
    if (track.archived_at !== null) {
      await this.prisma.$transaction(async (tx) => {
        await this.spaces.lock(tx, access.space.id);
        await this.tracks.updateTrack(tx, track.id, {
          archived_at: null,
          position: await this.tracks.nextTrackPosition(tx, access.space.id),
        });
        const active = await this.tracks.listActiveTracks(tx, access.space.id);
        await this.tracks.setTrackPositions(
          tx,
          active.map((entry) => entry.id)
        );
      });
      logger.info({ message: 'track restored', data: { trackId: track.id } });
    }
    return this.get(user, slug, track.slug);
  }

  /** The whole new order of the Space's active Tracks in one request (GRD-86). */
  async reorder(user: User, slug: string, trackIds: string[], requestId: string) {
    const logger = this.logger.setContext('service.track.reorder', requestId);
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertManage(user, 'track.manage', access);
    await this.prisma.$transaction(async (tx) => {
      await this.spaces.lock(tx, access.space.id);
      const active = await this.tracks.listActiveTracks(tx, access.space.id);
      assertSameSet(
        active.map((track) => track.id),
        trackIds,
        'Send every active Track exactly once.'
      );
      await this.tracks.setTrackPositions(tx, trackIds);
    });
    logger.info({ message: 'tracks reordered', data: { spaceId: access.space.id } });
    return this.list(user, slug);
  }
}

/** A reorder must name exactly the items that exist: no gaps, no repeats, no strangers. */
export function assertSameSet(expected: string[], given: string[], message: string): void {
  const sameSize = expected.length === given.length;
  const unique = new Set(given);
  if (!sameSize || unique.size !== given.length || !expected.every((id) => unique.has(id))) {
    throw new ConflictError(message, 'ORDER_MISMATCH');
  }
}
