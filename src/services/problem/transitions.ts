import { ConflictError } from '@/errors';
import type { Action } from '@/permissions/can';

/**
 * The state machine of a problem version (GRD-50), in one table. `archived` is
 * the state of the problem after its open version is archived.
 *
 *   draft -> verifying -> verified -> published -> archived
 *               |            |
 *               +--> draft <-+   (a failed run; or tests/solutions/limits/languages changed)
 *
 * `action` is who may cause the move; null means Core does it (the Judge result,
 * a deadline, or the edit that invalidates the verification).
 */
export type VersionState = 'draft' | 'verifying' | 'verified' | 'published' | 'archived';

export type TransitionTrigger =
  | 'verify_requested'
  | 'verify_passed'
  | 'verify_failed'
  | 'content_changed'
  | 'publish'
  | 'archive';

export interface Transition {
  from: VersionState;
  to: VersionState;
  trigger: TransitionTrigger;
  /** The permission needed; null when Core moves the version by itself. */
  action: Action | null;
}

export const TRANSITIONS: readonly Transition[] = [
  { from: 'draft', to: 'verifying', trigger: 'verify_requested', action: 'problem.update' },
  { from: 'verifying', to: 'verified', trigger: 'verify_passed', action: null },
  // Failed run, Judge error or a missed deadline: back to draft with the reason stored on the run.
  { from: 'verifying', to: 'draft', trigger: 'verify_failed', action: null },
  // Editing tests, solutions, limits or languages makes the verification stale.
  { from: 'verified', to: 'draft', trigger: 'content_changed', action: 'problem.update' },
  // Only owners, administrators and editors (observers read only).
  { from: 'verified', to: 'published', trigger: 'publish', action: 'problem.publish' },
  { from: 'published', to: 'archived', trigger: 'archive', action: 'problem.update' },
];

export function findTransition(from: VersionState, to: VersionState): Transition | undefined {
  return TRANSITIONS.find((transition) => transition.from === from && transition.to === to);
}

export function canTransition(from: VersionState, to: VersionState): boolean {
  return findTransition(from, to) !== undefined;
}

/** The permission a move needs (null for a move Core makes itself); throws for a move that does not exist. */
export function assertTransition(from: VersionState, to: VersionState): Transition {
  const found = findTransition(from, to);
  if (!found) {
    throw new ConflictError(`A version cannot go from ${from} to ${to}.`, 'INVALID_TRANSITION');
  }
  return found;
}
