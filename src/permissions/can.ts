/**
 * The only place that decides who may do what (GRD-15). Every endpoint asks
 * `can(actor, action, resource)`; nothing else checks roles or visibility.
 *
 * Pure function: no database, no clock. Callers load the facts (membership,
 * Space flags) and pass them in, so the whole table is unit-testable.
 */
export type SpaceRoleName = 'owner' | 'editor' | 'solver';

export const ACTIONS = [
  'space.view',
  'space.view_members',
  'space.update',
  'space.archive',
  'space.manage_members',
  'space.leave',
  'problem.view',
  'problem.create',
  'problem.update',
  'problem.publish',
  'submission.create',
  'submission.view',
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
  /** For problem.view: drafts are visible to owners and editors only. */
  problemStatus?: 'draft' | 'published';
  /** For submission.view: whose submission is being read. */
  submissionAuthorId?: string;
}

const WRITERS: readonly SpaceRoleName[] = ['owner', 'editor'];
const ANY_MEMBER: readonly SpaceRoleName[] = ['owner', 'editor', 'solver'];

/**
 * Permission table.
 *
 * Visitors (not logged in) may only look: view a public Space and its
 * published problems. They must log in to submit code (decision 2026-10-11).
 * Logged-in users who are not members get the same access as visitors plus
 * submitting to public Spaces. Private Spaces are for members only.
 *
 * An archived Space is read-only: problems stay visible, but nothing can be
 * created, edited, published or submitted, and settings/members are frozen.
 * Members may still leave.
 *
 * submission.view: your own submissions, wherever you may submit; other
 * people's submissions only for owners and editors. Provisional until
 * GRD-46 decides who sees whose submissions.
 */
export function can(actor: Actor, action: Action, resource: Resource): boolean {
  const { visibility, archived, role } = resource.space;
  const isMember = role !== null;
  const canSee = visibility === 'public' || isMember;
  const isWriter = role !== null && WRITERS.includes(role);

  switch (action) {
    case 'space.view':
      return canSee;
    case 'space.view_members':
      return isMember;
    case 'space.update':
    case 'space.archive':
    case 'space.manage_members':
      return !archived && role === 'owner';
    case 'space.leave':
      return role !== null && ANY_MEMBER.includes(role);
    case 'problem.view':
      if (!canSee) return false;
      return resource.problemStatus === 'draft' ? isWriter : true;
    case 'problem.create':
    case 'problem.update':
    case 'problem.publish':
      return !archived && isWriter;
    case 'submission.create':
      // Logged in, may see the Space, and the Space is not archived. Solving
      // a private Space needs membership; a public one needs only an account.
      return actor !== null && !archived && canSee;
    case 'submission.view': {
      if (actor === null || !canSee) return false;
      if (resource.submissionAuthorId === actor.userId) return true;
      return isWriter;
    }
  }
}
