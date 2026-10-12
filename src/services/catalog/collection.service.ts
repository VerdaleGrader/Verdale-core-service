import type { PrismaClient, User } from '../../../generated/prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '@/errors';
import TLogger, { Layer } from '@/logging/logger';
import { isReader } from '@/permissions/can';
import CatalogRepository, {
  collectionVisibleWhere,
  trackVisibleWhere,
} from '@/repositories/catalog.repository';
import { Db, isUniqueViolation } from '@/repositories/db';
import SpaceRepository from '@/repositories/space.repository';
import {
  CollectionDto,
  ProblemRefDto,
  ProgressDto,
  toCollectionDto,
} from '@/services/catalog/catalog.mapper';
import { slugFor } from '@/services/catalog/track.service';
import { assertCan } from '@/services/space/space.access';
import SpaceService from '@/services/space/space.service';

export interface CollectionInputDto {
  name: string;
  slug?: string;
  description?: string;
}

export interface CollectionUpdateDto {
  name?: string;
  description?: string;
  archived?: boolean;
}

export interface CollectionSummaryDto extends CollectionDto {
  problem_count: number;
  tracks: { name: string; slug: string }[];
}

export interface CollectionDetailDto extends CollectionSummaryDto {
  space: { name: string; slug: string };
  problems: ProblemRefDto[];
  progress: ProgressDto | null;
}

export default class CollectionService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly catalog: CatalogRepository,
    private readonly spaces: SpaceRepository,
    private readonly spaceService: SpaceService
  ) {}

  // --- reading ------------------------------------------------------------

  /** Collections the caller can reach. Staff see all of them, with those in no Track. */
  async list(
    user: User | null,
    slug: string,
    options: { includeArchived: boolean }
  ): Promise<CollectionSummaryDto[]> {
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, 'space.view', access);
    const staff = isReader(access.role);
    const collections = await this.catalog.listCollections(
      this.prisma,
      access.space.id,
      staff
        ? options.includeArchived
          ? {}
          : { archived_at: null }
        : collectionVisibleWhere(user?.id ?? null)
    );
    return Promise.all(collections.map((collection) => this.summary(collection, user, staff)));
  }

  async get(user: User | null, slug: string, collectionSlug: string): Promise<CollectionDetailDto> {
    const { access, collection } = await this.loadVisible(this.prisma, user, slug, collectionSlug);
    const staff = isReader(access.role);
    const links = await this.catalog.listCollectionProblems(
      this.prisma,
      collection.id,
      staff ? {} : { status: 'published' }
    );
    const ids = links.map((link) => link.problem_id);
    const [solved, verdicts] = user
      ? await Promise.all([
          this.catalog.solvedProblemIds(this.prisma, user.id, ids),
          this.catalog.latestVerdicts(this.prisma, user.id, ids),
        ])
      : [new Set<string>(), new Map<string, string>()];
    const countable = links.filter((link) => link.problem.status === 'published');
    return {
      ...(await this.summary(collection, user, staff)),
      space: { name: access.space.name, slug: access.space.slug },
      problems: links.map(
        (link): ProblemRefDto => ({
          slug: link.problem.slug,
          title: link.problem.current_version?.title ?? link.problem.slug,
          status: link.problem.status,
          my_result: user
            ? {
                solved: solved.has(link.problem_id),
                last_verdict: verdicts.get(link.problem_id) ?? null,
              }
            : null,
        })
      ),
      progress: user
        ? {
            solved: countable.filter((link) => solved.has(link.problem_id)).length,
            total: countable.length,
          }
        : null,
    };
  }

  // --- changing -----------------------------------------------------------

  async create(
    user: User,
    slug: string,
    input: CollectionInputDto,
    requestId: string
  ): Promise<CollectionDto> {
    const logger = this.logger.setContext('service.collection.create', requestId);
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, 'catalog.manage', access);
    const collectionSlug = slugFor(input.name, input.slug);
    try {
      const collection = await this.prisma.$transaction(async (tx) => {
        await this.spaces.lock(tx, access.space.id);
        if (await this.catalog.findCollection(tx, access.space.id, collectionSlug)) {
          throw new ConflictError('This slug is already used by another Collection in this Space.');
        }
        return this.catalog.createCollection(tx, access.space.id, user.id, {
          name: input.name,
          slug: collectionSlug,
          description: input.description ?? '',
        });
      });
      logger.info({ message: 'collection created', data: { collectionId: collection.id } });
      return toCollectionDto(collection);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('This slug is already used by another Collection in this Space.');
      }
      throw error;
    }
  }

  async update(
    user: User,
    slug: string,
    collectionSlug: string,
    input: CollectionUpdateDto,
    requestId: string
  ): Promise<CollectionDto> {
    const logger = this.logger.setContext('service.collection.update', requestId);
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, 'catalog.manage', access);
    const collection = await this.catalog.findCollection(
      this.prisma,
      access.space.id,
      collectionSlug.toLowerCase()
    );
    if (!collection) throw new NotFoundError('Collection not found.');
    const updated = await this.catalog.updateCollection(this.prisma, collection.id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.archived === true && collection.archived_at === null
        ? { archived_at: new Date() }
        : {}),
      ...(input.archived === false && collection.archived_at !== null ? { archived_at: null } : {}),
    });
    logger.info({
      message: 'collection updated',
      data: { collectionId: collection.id, fields: Object.keys(input) },
    });
    return toCollectionDto(updated);
  }

  async archive(user: User, slug: string, collectionSlug: string, requestId: string) {
    await this.update(user, slug, collectionSlug, { archived: true }, requestId);
  }

  /** Replaces the problems of a Collection with exactly these, in this order (drafts allowed). */
  async setProblems(
    user: User,
    slug: string,
    collectionSlug: string,
    problemSlugs: string[],
    requestId: string
  ): Promise<void> {
    await this.changeProblems(user, slug, collectionSlug, requestId, () => problemSlugs);
  }

  /** Adds some problems at the end and removes others, in one request. */
  async patchProblems(
    user: User,
    slug: string,
    collectionSlug: string,
    change: { add: string[]; remove: string[] },
    requestId: string
  ): Promise<void> {
    await this.changeProblems(user, slug, collectionSlug, requestId, (current) => {
      const removed = new Set(change.remove.map((item) => item.toLowerCase()));
      const kept = current.filter((item) => !removed.has(item));
      const added = change.add
        .map((item) => item.toLowerCase())
        .filter((item) => !kept.includes(item) && !removed.has(item));
      return [...kept, ...new Set(added)];
    });
  }

  // --- internals ----------------------------------------------------------

  private async changeProblems(
    user: User,
    slug: string,
    collectionSlug: string,
    requestId: string,
    next: (current: string[]) => string[]
  ): Promise<void> {
    const logger = this.logger.setContext('service.collection.setProblems', requestId);
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, 'catalog.manage', access);
    await this.prisma.$transaction(async (tx) => {
      await this.spaces.lock(tx, access.space.id);
      const collection = await this.catalog.findCollection(
        tx,
        access.space.id,
        collectionSlug.toLowerCase()
      );
      if (!collection) throw new NotFoundError('Collection not found.');
      const current = (await this.catalog.listCollectionProblems(tx, collection.id)).map(
        (link) => link.problem.slug
      );
      const wanted = next(current).map((item) => item.toLowerCase());
      if (new Set(wanted).size !== wanted.length) {
        throw new ValidationError([{ field: 'problem_slugs', message: 'List each problem once.' }]);
      }
      const found = await this.catalog.findProblemsBySlugs(tx, access.space.id, wanted);
      const bySlug = new Map(found.map((problem) => [problem.slug, problem.id]));
      const missing = wanted.filter((item) => !bySlug.has(item));
      if (missing.length > 0) {
        throw new ValidationError([
          {
            field: 'problem_slugs',
            message: `No such problem in this Space: ${missing.join(', ')}.`,
          },
        ]);
      }
      await this.catalog.setCollectionProblems(
        tx,
        collection.id,
        wanted.map((item) => bySlug.get(item)!)
      );
    });
    logger.info({ message: 'collection problems set' });
  }

  /** Staff see every Collection; everybody else only one that is in a Track they can reach. */
  async loadVisible(db: Db, user: User | null, slug: string, collectionSlug: string) {
    const access = await this.spaceService.load(db, slug, user);
    assertCan(user, 'space.view', access);
    const collection = await this.catalog.findCollection(
      db,
      access.space.id,
      collectionSlug.toLowerCase()
    );
    if (!collection) throw new NotFoundError('Collection not found.');
    if (!isReader(access.role)) {
      const visible = await db.collection.findFirst({
        where: { id: collection.id, ...collectionVisibleWhere(user?.id ?? null) },
        select: { id: true },
      });
      if (!visible) throw new NotFoundError('Collection not found.');
    }
    return { access, collection };
  }

  private async summary(
    collection: Awaited<ReturnType<CatalogRepository['findCollectionById']>> & object,
    user: User | null,
    staff: boolean
  ): Promise<CollectionSummaryDto> {
    const [problemCount, tracks] = await Promise.all([
      this.prisma.collectionProblem.count({
        where: {
          collection_id: collection.id,
          ...(staff ? {} : { problem: { status: 'published' } }),
        },
      }),
      this.prisma.trackCollection.findMany({
        where: {
          collection_id: collection.id,
          track: staff ? { archived_at: null } : trackVisibleWhere(user?.id ?? null),
        },
        include: { track: { select: { name: true, slug: true } } },
        orderBy: [{ track: { position: 'asc' } }],
      }),
    ]);
    return {
      ...toCollectionDto(collection),
      problem_count: problemCount,
      tracks: tracks.map((link) => ({ name: link.track.name, slug: link.track.slug })),
    };
  }
}
