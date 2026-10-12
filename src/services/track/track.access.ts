import type { User } from '../../../generated/prisma/client';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '@/errors';
import { Action, can } from '@/permissions/can';
import { SpaceAccess, actorOf, resourceOf } from '@/services/space/space.access';

export type ManageAction = 'track.manage' | 'track.manage_members';

/**
 * Checks that the caller may manage Tracks, Collections or their members in
 * this Space. A Space the caller cannot see is 404 (its existence is not
 * leaked), an archived Space is read-only, anyone but an owner, administrator or
 * editor gets 403. Same order as `assertAuthor` for problems.
 */
export function assertManage(user: User | null, action: ManageAction, access: SpaceAccess): User {
  const actor = actorOf(user);
  const resource = resourceOf(access);
  if (!can(actor, 'space.view', resource)) throw new NotFoundError('Space not found.');
  if (!user) throw new UnauthorizedError('Please log in.');
  if (access.space.archived_at !== null) {
    throw new ForbiddenError(
      'This Space is archived, so its Tracks and Collections are read-only.'
    );
  }
  if (!can(actor, action as Action, resource)) {
    throw new ForbiddenError('You do not have permission to do this in this Space.');
  }
  return user;
}

/** The staff (observers too): they see every Track, Collection and problem of the Space. */
export function isWriter(user: User | null, access: SpaceAccess): boolean {
  return can(actorOf(user), 'problem.view_private', resourceOf(access));
}
