/**
 * The only place that decides who may do what (GRD-15). Every endpoint asks
 * `can(actor, action, resource)`; nothing else checks roles or visibility.
 *
 * Pure function: no database, no clock. Callers load the facts (membership,
 * Space flags) and pass them in, so the whole table is unit-testable.
 */
export type SpaceRoleName = 'owner' | 'administrator' | 'editor' | 'observer' | 'solver';

export const ACTIONS = [
  'space.view',
  'space.view_members',
  'space.update',
  'space.change_visibility',
  'space.archive',
  'space.transfer_ownership',
  'space.manage_members',
  'space.leave',
  'problem.view',
  'problem.view_private',
  'problem.create',
  'problem.update',
  'problem.publish',
  'submission.create',
  'submission.view',
  'submission.view_all',
] as const;
export type Action = (typeof ACTIONS)[number];

/** Who is asking. `null` is a visitor who is not logged in. */
export type Actor = { userId: string } | null;

export interface SpaceFacts {
  visibility: 'public' | 'private';
  archived: boolean;
  /** The actor's role in this Space, or null when not a member. */
  role: SpaceRoleName | null;
}

export interface Resource {
  space: SpaceFacts;
  /** For problem.view: drafts are visible to people who can edit only. */
  problemStatus?: 'draft' | 'published';
  /** For submission.view: whose submission is being read. */
  submissionAuthorId?: string;
}

/** Roles that author problems (create, edit, publish). */
const WRITERS: readonly SpaceRoleName[] = ['owner', 'administrator', 'editor'];
/** Roles that may read what solvers must not see (hidden tests, solutions, others' submissions). */
const READERS: readonly SpaceRoleName[] = ['owner', 'administrator', 'editor', 'observer'];
/** Roles that run the Space's membership. */
const MANAGERS: readonly SpaceRoleName[] = ['owner', 'administrator'];

export const isWriter = (role: SpaceRoleName | null) => role !== null && WRITERS.includes(role);
export const isReader = (role: SpaceRoleName | null) => role !== null && READERS.includes(role);

/**
 * Permission table.
 *
 * Roles, strongest first: owner > administrator > editor > observer > solver.
 * A visitor or a signed-in non-member is a "viewer": not a stored role.
 *
 * - owner: everything, including the dangerous settings (visibility, archive)
 *   and handing the Space to someone else. Exactly one per Space.
 * - administrator: everything the owner can do except those dangerous
 *   settings. Runs members (see `canAssignRole`).
 * - editor: authors problems.
 * - observer: read-only access to everything an editor can read (hidden
 *   tests, expected output, every submission, the member list). Changes nothing.
 * - solver: solves; sees and submits only to what the Space exposes.
 *
 * Visitors (not logged in) may only look: view a public Space and its
 * published problems. They must log in to submit code (decision 2026-10-11).
 * Logged-in users who are not members get the same access as visitors plus
 * submitting to public Spaces. Private Spaces are for members only.
 *
 * An archived Space is read-only: problems stay visible, but nothing can be
 * created, edited, published or submitted, and settings/members are frozen.
 * Members may still leave (the owner must hand the Space over first).
 *
 * problem.view_private: the parts of a problem solvers must never see (hidden
 * tests, reference solutions, the editor view). Owner, administrator, editor
 * and observer; only the first three can change anything.
 *
 * submission.view: your own submissions, wherever you may submit.
 * submission.view_all: everybody's submissions in the Space (GRD-93).
 */
export function can(actor: Actor, action: Action, resource: Resource): boolean {
  const { visibility, archived, role } = resource.space;
  const isMember = role !== null;
  const canSee = visibility === 'public' || isMember;
  const writes = isWriter(role);
  const reads = isReader(role);
  const manages = role !== null && MANAGERS.includes(role);

  switch (action) {
    case 'space.view':
      return canSee;
    case 'space.view_members':
      return isMember;
    case 'space.update':
    case 'space.manage_members':
      return !archived && manages;
    case 'space.change_visibility':
    case 'space.archive':
    case 'space.transfer_ownership':
      return !archived && role === 'owner';
    case 'space.leave':
      // The owner cannot walk away from a Space; they hand it over first.
      return isMember && role !== 'owner';
    case 'problem.view':
      if (!canSee) return false;
      return resource.problemStatus === 'draft' ? reads : true;
    case 'problem.view_private':
      // Hidden tests, reference solutions, drafts. Reading stays allowed in an
      // archived Space (it is read-only, not secret).
      return canSee && reads;
    case 'problem.create':
    case 'problem.update':
    case 'problem.publish':
      return !archived && writes;
    case 'submission.create':
      // Logged in, may see the Space, and the Space is not archived. Solving
      // a private Space needs membership; a public one needs only an account.
      return actor !== null && !archived && canSee;
    case 'submission.view': {
      if (actor === null || !canSee) return false;
      if (resource.submissionAuthorId === actor.userId) return true;
      return reads;
    }
    case 'submission.view_all':
      return actor !== null && canSee && reads;
  }
}

/** Roles that can be given to someone. `owner` is only ever handed over (transfer). */
export const ASSIGNABLE_ROLES = ['administrator', 'editor', 'observer', 'solver'] as const;

/**
 * Who may move a member from `from` (null: not a member yet, i.e. inviting)
 * to `to`. The owner can do anything to anyone else. An administrator can
 * manage editors, observers and solvers, but cannot create or change other
 * administrators or touch the owner.
 */
export function canAssignRole(
  actorRole: SpaceRoleName | null,
  from: SpaceRoleName | null,
  to: SpaceRoleName
): boolean {
  if (actorRole === 'owner') return from !== 'owner';
  if (actorRole === 'administrator') {
    const below = (role: SpaceRoleName | null) =>
      role === null || role === 'editor' || role === 'observer' || role === 'solver';
    return below(from) && below(to);
  }
  return false;
}

/** Who may remove a member (not themselves: leaving is `space.leave`). */
export function canRemoveMember(actorRole: SpaceRoleName | null, targetRole: SpaceRoleName) {
  if (actorRole === 'owner') return targetRole !== 'owner';
  if (actorRole === 'administrator') {
    return targetRole === 'editor' || targetRole === 'observer' || targetRole === 'solver';
  }
  return false;
}
