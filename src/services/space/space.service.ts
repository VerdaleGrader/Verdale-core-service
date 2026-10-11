import type { PrismaClient, User } from '../../../generated/prisma/client';
import {
  IDENTIFIER_PATTERN,
  RESERVED_IDENTIFIERS,
  isValidIdentifier,
} from '@/constants/identifiers';
import { ConflictError, NotFoundError, ValidationError } from '@/errors';
import { Db, isUniqueViolation } from '@/repositories/db';
import SpaceRepository from '@/repositories/space.repository';
import { Role, SpaceAccess, assertCan } from '@/services/space/space.access';
import { Page, SpaceDto, toSpaceDto } from '@/services/space/space.mapper';

export interface CreateSpaceInput {
  name: string;
  slug: string;
  description: string;
  visibility: 'public' | 'private';
}

export interface UpdateSpaceInput {
  name?: string;
  description?: string;
  visibility?: 'public' | 'private';
}

export interface ListInput {
  q?: string;
  archived: boolean;
  page: number;
  page_size: number;
}

export default class SpaceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly spaces: SpaceRepository
  ) {}

  /** Loads a Space by slug together with the caller's role in it. */
  async load(db: Db, slug: string, user: User | null): Promise<SpaceAccess> {
    const space = await this.spaces.findBySlug(db, slug.toLowerCase());
    if (!space) throw new NotFoundError('Space not found.');
    const membership = user ? await this.spaces.findMembership(db, space.id, user.id) : null;
    return { space, role: (membership?.role as Role | undefined) ?? null };
  }

  async create(user: User, input: CreateSpaceInput): Promise<SpaceDto> {
    const slug = input.slug.toLowerCase();
    if (!isValidIdentifier(slug)) {
      throw new ValidationError([
        {
          field: 'slug',
          message: RESERVED_IDENTIFIERS.has(slug)
            ? 'This slug is reserved.'
            : `Use 3 to 32 lower-case letters, digits, "_" or "-", starting with a letter or digit (${IDENTIFIER_PATTERN.source}).`,
        },
      ]);
    }
    try {
      const space = await this.prisma.$transaction(async (tx) => {
        if (await this.spaces.isIdentifierTaken(tx, slug)) {
          throw new ConflictError('This slug is already taken.');
        }
        const created = await this.spaces.create(tx, {
          created_by_id: user.id,
          name: input.name,
          slug,
          description: input.description,
          visibility: input.visibility,
          is_personal: false,
        });
        await this.spaces.addMember(tx, created.id, user.id, 'owner');
        return created;
      });
      return toSpaceDto(space, 'owner', 1);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('This slug is already taken.');
      throw error;
    }
  }

  async get(user: User | null, slug: string): Promise<SpaceDto> {
    const access = await this.load(this.prisma, slug, user);
    assertCan(user, 'space.view', access);
    const memberCount = access.role
      ? await this.spaces.countMembers(this.prisma, access.space.id)
      : undefined;
    return toSpaceDto(access.space, access.role, memberCount);
  }

  async update(user: User, slug: string, input: UpdateSpaceInput): Promise<SpaceDto> {
    const access = await this.load(this.prisma, slug, user);
    assertCan(user, 'space.update', access);
    const updated = await this.spaces.update(this.prisma, access.space.id, input);
    return toSpaceDto(updated, access.role);
  }

  async archive(user: User, slug: string): Promise<SpaceDto> {
    const access = await this.load(this.prisma, slug, user);
    assertCan(user, 'space.archive', access);
    if (access.space.is_personal) throw new ConflictError('A personal Space cannot be archived.');
    const updated = await this.spaces.update(this.prisma, access.space.id, {
      archived_at: new Date(),
    });
    return toSpaceDto(updated, access.role);
  }

  /** Spaces I belong to, with my role. Archived ones are a separate list. */
  async listMine(user: User, input: ListInput): Promise<Page<SpaceDto>> {
    const { rows, total } = await this.spaces.listForMember(this.prisma, user.id, {
      q: input.q,
      archived: input.archived,
      skip: (input.page - 1) * input.page_size,
      take: input.page_size,
    });
    return {
      items: rows.map((row) => toSpaceDto(row.space, row.role as Role)),
      page: input.page,
      page_size: input.page_size,
      total,
    };
  }

  /** Public, active Spaces only. A private Space never appears, whatever the query. */
  async listPublic(user: User | null, input: ListInput): Promise<Page<SpaceDto>> {
    const { rows, total } = await this.spaces.listPublic(this.prisma, {
      q: input.q,
      archived: false,
      skip: (input.page - 1) * input.page_size,
      take: input.page_size,
    });
    const roles = new Map<string, Role>();
    if (user) {
      await Promise.all(
        rows.map(async (space) => {
          const membership = await this.spaces.findMembership(this.prisma, space.id, user.id);
          if (membership) roles.set(space.id, membership.role as Role);
        })
      );
    }
    return {
      items: rows.map((space) => toSpaceDto(space, roles.get(space.id) ?? null)),
      page: input.page,
      page_size: input.page_size,
      total,
    };
  }
}
