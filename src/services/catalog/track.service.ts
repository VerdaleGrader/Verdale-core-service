import type { PrismaClient, Track, User } from '../../../generated/prisma/client';
import {
  CATALOG_SLUG_MESSAGE,
  RESERVED_IDENTIFIERS,
  isValidCatalogSlug,
} from '@/constants/identifiers';
import { ConflictError, NotFoundError, ValidationError } from '@/errors';
import TLogger, { Layer } from '@/logging/logger';
import { can, isReader } from '@/permissions/can';
import CatalogRepository, { trackVisibleWhere } from '@/repositories/catalog.repository';
import { Db, isUniqueViolation } from '@/repositories/db';
import SpaceRepository from '@/repositories/space.repository';
import {
  CollectionDto,
  ProblemRefDto,
  ProgressDto,
  TrackDto,
  slugify,
  toCollectionDto,
  toTrackDto,
} from '@/services/catalog/catalog.mapper';
import { SpaceAccess, actorOf, assertCan, resourceOf } from '@/services/space/space.access';
import SpaceService from '@/services/space/space.service';
import { PublicUser, toPublicUser } from '@/services/user/user.mapper';

export interface TrackInputDto {
  name: string;
  slug?: string;
  description?: string;
  privacy?: 'space' | 'members';
}

export interface TrackUpdateDto {
  name?: string;
  description?: string;
  privacy?: 'space' | 'members';
  archived?: boolean;
}

export interface TrackSummaryDto extends TrackDto {
  collection_count: number;
  problem_count: number;
  /** The signed-in person's progression; null for a visitor. */
  progress: ProgressDto | null;
  /** Added to this Track by an invitation. */
  is_member: boolean;
}

export interface CollectionInTrackDto extends CollectionDto {
  problems: ProblemRefDto[];
  progress: ProgressDto | null;
}

export interface TrackDetailDto extends TrackDto {
  space: { name: string; slug: string };
  collections: CollectionInTrackDto[];
  progress: ProgressDto | null;
  /** Only the people who manage the Track see how many members it has. */
  member_count: number | null;
}

export interface MemberProgressDto {
  user: PublicUser;
  role: string | null;
  is_track_member: boolean;
  solved: number;
}

const DEFAULT_TRACK_NAME = 'General';

export const MAX_TRACK_NAME = 80;

/** The slug for a name, or a validation error asking for one when the name has no usable letters. */
export function slugFor(name: string, given: string | undefined, field = 'slug'): string {
  const slug = (given ?? slugify(name)).trim().toLowerCase();
  if (!isValidCatalogSlug(slug)) {
    throw new ValidationError([
      {
        field,
        message:
          given === undefined
            ? `Add a slug: ${CATALOG_SLUG_MESSAGE}`
            : RESERVED_IDENTIFIERS.has(slug) || !slug
              ? 'This slug is not available.'
              : CATALOG_SLUG_MESSAGE,
      },
    ]);
  }
  return slug;
}

/** The Track every Space starts with (GRD-78). */
export async function createInitialTrack(
  catalog: CatalogRepository,
  db: Db,
  spaceId: string,
  userId: string,
  name: string | undefined
): Promise<Track> {
  const trimmed = name?.trim() || DEFAULT_TRACK_NAME;
  const slug = slugify(trimmed);
  return catalog.createTrack(
    db,
    spaceId,
    userId,
    {
      name: trimmed,
      slug: isValidCatalogSlug(slug) ? slug : 'general',
      description: '',
      privacy: 'space',
    },
    1
  );
}

export default class TrackService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly catalog: CatalogRepository,
    private readonly spaces: SpaceRepository,
    private readonly spaceService: SpaceService
  ) {}

  // --- reading ------------------------------------------------------------

  /** Tracks the caller can reach, in order. The Space's staff also see archived ones on request. */
  async list(
    user: User | null,
    slug: string,
    options: { includeArchived: boolean }
  ): Promise<TrackSummaryDto[]> {
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, 'space.view', access);
    const staff = isReader(access.role);
    const tracks = await this.catalog.listTracks(
      this.prisma,
      access.space.id,
      staff
        ? options.includeArchived
          ? {}
          : { archived_at: null }
        : trackVisibleWhere(user?.id ?? null)
    );
    const memberOf = new Set(
      user
        ? (
            await this.prisma.trackMember.findMany({
              where: { user_id: user.id, track_id: { in: tracks.map((track) => track.id) } },
              select: { track_id: true },
            })
          ).map((row) => row.track_id)
        : []
    );
    return Promise.all(
      tracks.map(async (track) => {
        const [collections, problemIds] = await Promise.all([
          this.catalog.listTrackCollections(this.prisma, track.id, { archived_at: null }),
          this.catalog.trackProblemIds(this.prisma, track.id),
        ]);
        return {
          ...toTrackDto(track),
          collection_count: collections.length,
          problem_count: problemIds.length,
          progress: user ? await this.progressOf(user.id, problemIds) : null,
          is_member: memberOf.has(track.id),
        };
      })
    );
  }

  async get(user: User | null, slug: string, trackSlug: string): Promise<TrackDetailDto> {
    const { access, track } = await this.loadVisible(this.prisma, user, slug, trackSlug);
    const staff = isReader(access.role);
    const links = await this.catalog.listTrackCollections(
      this.prisma,
      track.id,
      staff ? {} : { archived_at: null }
    );

    const rows = await Promise.all(
      links.map(async (link) => ({
        link,
        problems: await this.catalog.listCollectionProblems(
          this.prisma,
          link.collection_id,
          staff ? {} : { status: 'published' }
        ),
      }))
    );
    const allIds = [...new Set(rows.flatMap((row) => row.problems.map((p) => p.problem_id)))];
    const [solved, verdicts] = user
      ? await Promise.all([
          this.catalog.solvedProblemIds(this.prisma, user.id, allIds),
          this.catalog.latestVerdicts(this.prisma, user.id, allIds),
        ])
      : [new Set<string>(), new Map<string, string>()];

    const countable = (row: (typeof rows)[number]) =>
      row.link.collection.archived_at === null
        ? row.problems.filter((p) => p.problem.status === 'published').map((p) => p.problem_id)
        : [];
    const trackIds = [...new Set(rows.flatMap(countable))];

    const collections = rows.map((row) => ({
      ...toCollectionDto(row.link.collection),
      problems: row.problems.map(
        (p): ProblemRefDto => ({
          slug: p.problem.slug,
          title: p.problem.current_version?.title ?? p.problem.slug,
          status: p.problem.status,
          my_result: user
            ? { solved: solved.has(p.problem_id), last_verdict: verdicts.get(p.problem_id) ?? null }
            : null,
        })
      ),
      progress: user
        ? {
            solved: countable(row).filter((id) => solved.has(id)).length,
            total: countable(row).length,
          }
        : null,
    }));

    const canManage = can(actorOf(user), 'catalog.manage', resourceOf(access));
    return {
      ...toTrackDto(track),
      space: { name: access.space.name, slug: access.space.slug },
      collections,
      progress: user
        ? { solved: trackIds.filter((id) => solved.has(id)).length, total: trackIds.length }
        : null,
      member_count: canManage
        ? await this.prisma.trackMember.count({ where: { track_id: track.id } })
        : null,
    };
  }

  /** How far every person who can reach the Track has got. Staff only. */
  async memberProgress(
    user: User,
    slug: string,
    trackSlug: string
  ): Promise<{ total: number; items: MemberProgressDto[] }> {
    const { access, track } = await this.loadVisible(this.prisma, user, slug, trackSlug);
    assertCan(user, 'catalog.view_progress', access);

    const [problemIds, trackMembers, spaceMembers] = await Promise.all([
      this.catalog.trackProblemIds(this.prisma, track.id),
      this.catalog.listTrackMembers(this.prisma, track.id),
      this.spaces.listMembers(this.prisma, access.space.id),
    ]);
    const people = new Map<string, MemberProgressDto & { id: string }>();
    // Everyone who can reach the Track: its members and, if it is open to the
    // Space, the Space's solvers. Staff are not "following" a Track.
    for (const member of spaceMembers) {
      if (member.role !== 'solver' || track.privacy === 'members') continue;
      people.set(member.user_id, {
        id: member.user_id,
        user: toPublicUser(member.user),
        role: member.role,
        is_track_member: false,
        solved: 0,
      });
    }
    const roles = new Map(spaceMembers.map((member) => [member.user_id, member.role as string]));
    for (const member of trackMembers) {
      people.set(member.user_id, {
        id: member.user_id,
        user: toPublicUser(member.user),
        role: roles.get(member.user_id) ?? null,
        is_track_member: true,
        solved: 0,
      });
    }
    const counts = await this.catalog.solvedCounts(this.prisma, [...people.keys()], problemIds);
    const items = [...people.values()]
      .map(({ id, ...rest }) => ({ ...rest, solved: counts.get(id) ?? 0 }))
      .sort((a, b) => b.solved - a.solved || a.user.username.localeCompare(b.user.username));
    return { total: problemIds.length, items };
  }

  // --- changing -----------------------------------------------------------

  async create(
    user: User,
    slug: string,
    input: TrackInputDto,
    requestId: string
  ): Promise<TrackDto> {
    const logger = this.logger.setContext('service.track.create', requestId);
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, 'catalog.manage', access);
    const trackSlug = slugFor(input.name, input.slug);
    try {
      const track = await this.prisma.$transaction(async (tx) => {
        await this.spaces.lock(tx, access.space.id);
        if (await this.catalog.findTrack(tx, access.space.id, trackSlug)) {
          throw new ConflictError('This slug is already used by another Track in this Space.');
        }
        return this.catalog.createTrack(
          tx,
          access.space.id,
          user.id,
          {
            name: input.name,
            slug: trackSlug,
            description: input.description ?? '',
            privacy: input.privacy ?? 'space',
          },
          await this.catalog.nextTrackPosition(tx, access.space.id)
        );
      });
      logger.info({ message: 'track created', data: { trackId: track.id } });
      return toTrackDto(track);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('This slug is already used by another Track in this Space.');
      }
      throw error;
    }
  }

  async update(
    user: User,
    slug: string,
    trackSlug: string,
    input: TrackUpdateDto,
    requestId: string
  ): Promise<TrackDto> {
    const logger = this.logger.setContext('service.track.update', requestId);
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, 'catalog.manage', access);
    const track = await this.catalog.findTrack(
      this.prisma,
      access.space.id,
      trackSlug.toLowerCase()
    );
    if (!track) throw new NotFoundError('Track not found.');
    const updated = await this.catalog.updateTrack(this.prisma, track.id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.privacy !== undefined ? { privacy: input.privacy } : {}),
      ...(input.archived === true && track.archived_at === null ? { archived_at: new Date() } : {}),
      ...(input.archived === false && track.archived_at !== null ? { archived_at: null } : {}),
    });
    logger.info({
      message: 'track updated',
      data: { trackId: track.id, fields: Object.keys(input) },
    });
    return toTrackDto(updated);
  }

  /** Archiving never deletes problems or Collections: they just stop being reachable through this Track. */
  async archive(user: User, slug: string, trackSlug: string, requestId: string): Promise<void> {
    await this.update(user, slug, trackSlug, { archived: true }, requestId);
  }

  /** Sets the order of all active Tracks: the list must name each of them exactly once. */
  async reorder(user: User, slug: string, order: string[], requestId: string): Promise<TrackDto[]> {
    const logger = this.logger.setContext('service.track.reorder', requestId);
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, 'catalog.manage', access);
    const wanted = order.map((item) => item.toLowerCase());
    const result = await this.prisma.$transaction(async (tx) => {
      await this.spaces.lock(tx, access.space.id);
      const active = await this.catalog.listTracks(tx, access.space.id, { archived_at: null });
      const bySlug = new Map(active.map((track) => [track.slug, track]));
      if (
        wanted.length !== active.length ||
        new Set(wanted).size !== wanted.length ||
        wanted.some((item) => !bySlug.has(item))
      ) {
        throw new ConflictError(
          'Send every active Track exactly once. The list may have changed: reload and try again.',
          'ORDER_OUT_OF_DATE'
        );
      }
      await this.catalog.setTrackOrder(
        tx,
        wanted.map((item) => bySlug.get(item)!.id)
      );
      return this.catalog.listTracks(tx, access.space.id, { archived_at: null });
    });
    logger.info({ message: 'tracks reordered', data: { spaceId: access.space.id } });
    return result.map(toTrackDto);
  }

  /**
   * Replaces the Collections of a Track with exactly these, in this order. A
   * Collection can be in several Tracks, so this only changes this Track's links.
   */
  async setCollections(
    user: User,
    slug: string,
    trackSlug: string,
    collectionSlugs: string[],
    requestId: string
  ): Promise<void> {
    const logger = this.logger.setContext('service.track.setCollections', requestId);
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, 'catalog.manage', access);
    const wanted = collectionSlugs.map((item) => item.toLowerCase());
    if (new Set(wanted).size !== wanted.length) {
      throw new ValidationError([
        { field: 'collection_slugs', message: 'List each Collection once.' },
      ]);
    }
    await this.prisma.$transaction(async (tx) => {
      await this.spaces.lock(tx, access.space.id);
      const track = await this.catalog.findTrack(tx, access.space.id, trackSlug.toLowerCase());
      if (!track) throw new NotFoundError('Track not found.');
      const found = await this.catalog.listCollections(tx, access.space.id, {
        slug: { in: wanted },
        archived_at: null,
      });
      const bySlug = new Map(found.map((collection) => [collection.slug, collection.id]));
      const missing = wanted.filter((item) => !bySlug.has(item));
      if (missing.length > 0) {
        throw new ValidationError([
          {
            field: 'collection_slugs',
            message: `Unknown or archived Collection: ${missing.join(', ')}.`,
          },
        ]);
      }
      await this.catalog.setTrackCollections(
        tx,
        track.id,
        wanted.map((item) => bySlug.get(item)!)
      );
    });
    logger.info({ message: 'track collections set', data: { count: wanted.length } });
  }

  // --- shared -------------------------------------------------------------

  /**
   * The Track as the caller may see it: the Space's staff see all of them,
   * everyone else only the active ones open to the Space or that they joined.
   * Anything else is "not found", so a members-only Track does not leak.
   */
  async loadVisible(db: Db, user: User | null, slug: string, trackSlug: string) {
    const access: SpaceAccess = await this.spaceService.load(db, slug, user);
    assertCan(user, 'space.view', access);
    const track = await this.catalog.findTrack(db, access.space.id, trackSlug.toLowerCase());
    if (!track) throw new NotFoundError('Track not found.');
    if (!isReader(access.role)) {
      const visible = await db.track.findFirst({
        where: { id: track.id, ...trackVisibleWhere(user?.id ?? null) },
        select: { id: true },
      });
      if (!visible) throw new NotFoundError('Track not found.');
    }
    return { access, track };
  }

  private async progressOf(userId: string, problemIds: string[]): Promise<ProgressDto> {
    const solved = await this.catalog.solvedProblemIds(this.prisma, userId, problemIds);
    return { solved: solved.size, total: problemIds.length };
  }
}
