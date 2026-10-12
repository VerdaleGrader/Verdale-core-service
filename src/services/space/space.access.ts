import type { Space } from '../../../generated/prisma/client';
import { ForbiddenError, NotFoundError } from '@/errors';
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
    space: { visibility: space.visibility, archived: space.archived_at !== null, role },
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
  const actor = actorOf(user);
  const resource = resourceOf(access, extra);
  if (!can(actor, 'space.view', resource)) throw new NotFoundError('Space not found.');
  if (!can(actor, action, resource)) {
    throw new ForbiddenError('You do not have permission to do this in this Space.');
  }
}
