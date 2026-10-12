import type { User } from '../../../generated/prisma/client';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '@/errors';
import { Action, can } from '@/permissions/can';
import type { ProblemWithVersion } from '@/repositories/problem.repository';
import { SpaceAccess, actorOf, resourceOf } from '@/services/space/space.access';

/** Actions that change a problem; they stop at an archived Space with a clearer message than 403. */
export type AuthorAction =
  | 'problem.view_private'
  | 'problem.create'
  | 'problem.update'
  | 'problem.publish';

/**
 * Checks that the caller may do an author action in this Space, before the
 * problem is even looked up, so a visitor cannot tell a draft from a missing
 * problem by the status code. A Space the caller cannot see is 404; an
 * archived Space is read-only; someone without the role for it is 403.
 */
export function assertAuthor(user: User | null, action: AuthorAction, access: SpaceAccess): User {
  const actor = actorOf(user);
  const resource = resourceOf(access);
  if (!can(actor, 'space.view', resource)) throw new NotFoundError('Space not found.');
  if (!user) throw new UnauthorizedError('Please log in.');
  if (action !== 'problem.view_private' && access.space.archived_at !== null) {
    throw new ForbiddenError('This Space is archived, so its problems are read-only.');
  }
  if (!can(actor, action as Action, resource)) {
    throw new ForbiddenError('You do not have permission to do this in this Space.');
  }
  return user;
}

export function isAuthor(user: User | null, access: SpaceAccess): boolean {
  return can(actorOf(user), 'problem.view_private', resourceOf(access));
}

export const VERSION_PUBLISHED_MESSAGE = 'This version is published and can no longer be changed.';

export function versionPublishedError(): ConflictError {
  return new ConflictError(VERSION_PUBLISHED_MESSAGE, 'VERSION_PUBLISHED');
}

/** The draft can be edited; a published version, or any version of an archived problem, cannot. */
export function assertDraftEditable(
  problem: Pick<ProblemWithVersion, 'status'>,
  version: { status: 'draft' | 'published' } | null
): void {
  if (problem.status === 'archived') {
    throw new ConflictError('This problem is archived and cannot be changed.', 'PROBLEM_ARCHIVED');
  }
  if (!version || version.status !== 'draft') throw versionPublishedError();
}
