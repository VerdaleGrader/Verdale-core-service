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
  'problem.view_private',
  'problem.create',
  'problem.update',
  'problem.publish',
  'submission.create',
  'submission.view',
  'track.view',
  'track.manage',
  'track.manage_members',
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
  /**
   * For problem.view and submission.create (GRD-81): the problem sits in a
   * Collection of a Track this actor may see. Owners and editors do not need it.
   */
  problemInTrack?: boolean;
  /** For track.view. */
  track?: TrackFacts;
  /** For submission.view: whose submission is being read. */
  submissionAuthorId?: string;
}

export interface TrackFacts {
  visibility: 'space' | 'members';
  archived: boolean;
  /** The actor was added to this Track (invitation or removal by an owner/editor). */
  isMember: boolean;
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
 * problem.view_private: the parts of a problem solvers must never see (hidden
 * tests, reference solutions, the editor view). Owners and editors only.
 *
 * submission.view: your own submissions, wherever you may submit; other
 * people's submissions only for owners and editors (decided in GRD-46).
 *
 * Tracks (GRD-77 to GRD-81): solvers, outsiders and visitors reach problems
 * only through a Track they can see, so problem.view and submission.create
 * also need `problemInTrack`. A Track is visible to everyone who can see its
 * Space when its visibility is `space`, otherwise only to people added to it;
 * owners and editors see every Track, archived or not. An archived Track is
 * hidden from everyone else. Managing Tracks, Collections and their members
 * is for owners and editors, and stops with an archived Space.
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
      if (isWriter) return true;
      return resource.problemStatus !== 'draft' && resource.problemInTrack === true;
    case 'problem.view_private':
      // Hidden tests, reference solutions, drafts: authors only. Reading stays
      // allowed in an archived Space (it is read-only, not secret).
      return canSee && isWriter;
    case 'problem.create':
    case 'problem.update':
    case 'problem.publish':
      return !archived && isWriter;
    case 'submission.create':
      // Logged in, may see the Space, and the Space is not archived. Solving
      // a private Space needs membership; a public one needs only an account.
      return (
        actor !== null && !archived && canSee && (isWriter || resource.problemInTrack === true)
      );
    case 'track.view': {
      if (!canSee) return false;
      const track = resource.track;
      if (isWriter) return true;
      if (!track || track.archived) return false;
      return track.visibility === 'space' || track.isMember;
    }
    case 'track.manage':
    case 'track.manage_members':
      return !archived && isWriter;
    case 'submission.view': {
      if (actor === null || !canSee) return false;
      if (resource.submissionAuthorId === actor.userId) return true;
      return isWriter;
    }
  }
}
