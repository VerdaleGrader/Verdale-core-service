import type { Space } from '../../../generated/prisma/client';
import { ForbiddenError, NotFoundError, SuspendedError } from '@/errors';
import { Action, Actor, Resource, SpaceRoleName, can } from '@/permissions/can';

export type Role = SpaceRoleName;

export interface SpaceAccess {
  space: Space;
  role: Role | null;
}

export function actorOf(user: { id: string } | null): Actor {
  return user ? { userId: user.id } : null;
}

export function resourceOf({ space, role }: SpaceAccess, extra: Partial<Resource> = {}): Resource {
  return {
    space: {
      visibility: space.visibility,
      archived: space.archived_at !== null,
      role,
      suspended: space.suspended_at !== null,
    },
    ...extra,
  };
}

/**
 * The one way services check access. A Space the caller may not even see
 * answers "not found" (its existence is not leaked); a visible Space where
 * the action is not allowed answers "forbidden".
 */
export function assertCan(
  user: { id: string } | null,
  action: Action,
  access: SpaceAccess,
  extra: Partial<Resource> = {}
): void {
  assertNotSuspended(access);
  const actor = actorOf(user);
  const resource = resourceOf(access, extra);
  if (!can(actor, 'space.view', resource)) throw new NotFoundError('Space not found.');
  if (!can(actor, action, resource)) {
    throw new ForbiddenError('You do not have permission to do this in this Space.');
  }
}

/**
 * A Space the platform administrators suspended (GRD-58): its members are told so (403
 * SPACE_SUSPENDED), everybody else gets "not found" as for any Space they cannot see.
 */
export function assertNotSuspended({ space, role }: SpaceAccess): void {
  if (space.suspended_at === null) return;
  if (role === null) throw new NotFoundError('Space not found.');
  throw new SuspendedError(
    'This Space has been suspended by the platform administrators. Contact support.',
    'SPACE_SUSPENDED'
  );
}
