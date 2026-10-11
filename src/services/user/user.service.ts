import type { PrismaClient, User } from '../../../generated/prisma/client';
import {
  IDENTIFIER_PATTERN,
  RESERVED_IDENTIFIERS,
  isValidIdentifier,
} from '@/constants/identifiers';
import { ConflictError, NotFoundError, ValidationError } from '@/errors';
import { isUniqueViolation } from '@/repositories/db';
import SpaceRepository from '@/repositories/space.repository';
import UserRepository from '@/repositories/user.repository';
import { PublicUser, SessionUser, toPublicUser, toSessionUser } from '@/services/user/user.mapper';

export interface ProfileUpdate {
  display_name?: string;
  username?: string;
}

export default class UserService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly users: UserRepository,
    private readonly spaces: SpaceRepository
  ) {}

  getMe(user: User): SessionUser {
    return toSessionUser(user);
  }

  async getPublicProfile(username: string): Promise<PublicUser> {
    const user = await this.users.findByUsername(this.prisma, username.toLowerCase());
    if (!user) throw new NotFoundError('User not found.');
    return toPublicUser(user);
  }

  /**
   * Updates display name and/or username. Changing the username also moves
   * the personal Space's slug (and its name, if it was never renamed), in the
   * same transaction, so a username and a slug can never disagree.
   */
  async updateMe(user: User, update: ProfileUpdate): Promise<SessionUser> {
    const username = update.username?.toLowerCase();
    if (username !== undefined && username !== user.username) {
      if (!isValidIdentifier(username)) {
        throw new ValidationError([
          {
            field: 'username',
            message: RESERVED_IDENTIFIERS.has(username)
              ? 'This username is reserved.'
              : `Use 3 to 32 lower-case letters, digits, "_" or "-", starting with a letter or digit (${IDENTIFIER_PATTERN.source}).`,
          },
        ]);
      }
    }

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        if (username !== undefined && username !== user.username) {
          if (await this.spaces.isIdentifierTaken(tx, username, user.id)) {
            throw new ConflictError('This username is already taken.');
          }
          const personal = await this.spaces.findPersonalOf(tx, user.id);
          if (personal) {
            await this.spaces.update(tx, personal.id, {
              slug: username,
              ...(personal.name === user.username ? { name: username } : {}),
            });
          }
        }
        return this.users.update(tx, user.id, {
          ...(update.display_name !== undefined ? { display_name: update.display_name } : {}),
          ...(username !== undefined ? { username } : {}),
        });
      });
      return toSessionUser(updated);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('This username is already taken.');
      throw error;
    }
  }
}
