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
  'track.view',
  'track.manage',
  'track.manage_members',
  'track.view_progress',
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
  /** For problem.view: drafts are visible to the staff only. */
  problemStatus?: 'draft' | 'published';
  /**
   * For problem.view and submission.create (GRD-81): the problem sits in a
   * Collection of a Track this actor may see. The staff do not need it.
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
  /** The actor was added to this Track (invitation, or added by someone who manages it). */
  isMember: boolean;
}

/** Roles that author problems and manage Tracks (create, edit, publish). */
const WRITERS: readonly SpaceRoleName[] = ['owner', 'administrator', 'editor'];
/** The staff: read everything an author can read (hidden tests, solutions, all submissions, progress). */
const READERS: readonly SpaceRoleName[] = ['owner', 'administrator', 'editor', 'observer'];
/** Roles that run the Space's members and settings. */
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
 *   settings. Runs members and settings (see `canAssignRole`).
 * - editor: authors problems and manages Tracks and Collections.
 * - observer: read-only staff. Reads everything an editor can read (hidden
 *   tests, solutions, drafts, every Track, every submission, the members,
 *   progress) and changes nothing.
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
 * tests, reference solutions, the editor view). The staff; only the first
 * three roles can change anything.
 *
 * submission.view: your own submissions, wherever you may submit; other
 * people's only for the staff. submission.view_all: the Space-wide review of
 * everybody's submissions (GRD-93), also staff.
 *
 * Tracks (GRD-77 to GRD-81): solvers, outsiders and visitors reach problems
 * only through a Track they can see, so problem.view and submission.create
 * also need `problemInTrack`. A Track is visible to everyone who can see its
 * Space when its visibility is `space`, otherwise only to people added to it;
 * the staff see every Track, archived or not. An archived Track is hidden from
 * everyone else. Managing Tracks, Collections and their members is for
 * owners, administrators and editors, and stops with an archived Space.
 * track.view_progress: reading other people's progression, for the staff.
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
      if (reads) return true;
      return resource.problemStatus !== 'draft' && resource.problemInTrack === true;
    case 'problem.view_private':
      // Hidden tests, reference solutions, drafts: the staff. Reading stays
      // allowed in an archived Space (it is read-only, not secret).
      return canSee && reads;
    case 'problem.create':
    case 'problem.update':
    case 'problem.publish':
      return !archived && writes;
    case 'submission.create':
      // Logged in, may see the Space, and the Space is not archived. Solving
      // a private Space needs membership; a public one needs only an account.
      return actor !== null && !archived && canSee && (reads || resource.problemInTrack === true);
    case 'track.view': {
      if (!canSee) return false;
      const track = resource.track;
      if (reads) return true;
      if (!track || track.archived) return false;
      return track.visibility === 'space' || track.isMember;
    }
    case 'track.manage':
    case 'track.manage_members':
      return !archived && writes;
    case 'track.view_progress':
      return canSee && reads;
    case 'submission.view': {
      if (actor === null || !canSee) return false;
      if (resource.submissionAuthorId === actor.userId) return true;
      return reads;
    }
    case 'submission.view_all':
      return actor !== null && canSee && reads;
  }
}

/** Roles that can be given to someone. `owner` is only ever handed over. */
export const ASSIGNABLE_ROLES = ['administrator', 'editor', 'observer', 'solver'] as const;

/**
 * Who may move a member from `from` (null: not a member yet, i.e. inviting)
 * to `to`. The owner can do anything to anyone else, and hands the Space over
 * by making someone owner. An administrator manages editors, observers and
 * solvers, but cannot create or change other administrators or touch the owner.
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
