/**
 * Product limits for problems, tests and submissions (M3). Every number the
 * web app shows comes from here through `constraints` in the API, so the two
 * cannot disagree. They sit inside the hard bounds of the Judge contract and
 * of the database CHECK constraints; docs/problems.md explains each choice.
 */
import type { Language } from '../../generated/prisma/enums';

export const LANGUAGES: readonly Language[] = ['c', 'cpp', 'python'];

export const TITLE_MAX_LENGTH = 200;
export const STATEMENT_MAX_LENGTH = 100_000;

/** Judge allows 100 ms to 20 s; authors get 100 ms to 10 s. */
export const TIME_LIMIT_MS = { min: 100, max: 10_000, default: 1_000 } as const;
/** Judge allows 16 MB to 2 GB; authors get 16 MB to 1 GB (default 256 MB). */
export const MEMORY_LIMIT_KB = { min: 16_384, max: 1_048_576, default: 262_144 } as const;

const MIB = 1024 * 1024;

export const TEST_LIMITS = {
  max_count: 100,
  max_file_bytes: 8 * MIB,
  max_total_bytes: 128 * MIB,
  /** Samples are shown in the statement, so their files must stay small. */
  max_sample_bytes: 64 * 1024,
  max_samples: 10,
} as const;

/** Judge's JobRequest.source limit; also applies to reference solutions. */
export const SOURCE_MAX_BYTES = 65_536;
export const SOLUTIONS_MAX_COUNT = 5;

/** Output a program may write per test, in KB. Judge's own default and maximum. */
export const OUTPUT_LIMIT_KB = 65_536;

export const IMAGE_MAX_BYTES = 2 * MIB;
export const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Submissions per user per minute (GRD-44; GRD-55 may tune the number). */
export const SUBMISSIONS_PER_MINUTE = 10;
/** Re-checks (ISE) share the budget above; this is only for the route config. */
export const SUBMISSION_LIST_MAX_PAGE_SIZE = 50;

/**
 * What Core asks Judge to send back of each test's output (GRD-93). Staff read
 * it to see why a submission failed; the whole job stays under `total_bytes`
 * and is below the size Core accepts in a callback.
 */
export const CAPTURE = {
  stdout_bytes: 64 * 1024,
  stderr_bytes: 8 * 1024,
  total_bytes: 2 * MIB,
} as const;

/** How long a queued submission waits for Judge to come back before it is an ISE. */
export const DISPATCH_GIVE_UP_MS = 30 * 60 * 1000;

/** Tracks, Collections and what one request may carry (GRD-77 to GRD-79). */
export const TRACK_LIMITS = {
  max_tracks_per_space: 50,
  max_collections_per_space: 200,
  max_problems_per_collection: 200,
  /** Problems, Collections or Tracks named in one add, remove or reorder request. */
  max_items_per_request: 200,
} as const;

export const TRACK_INVITE_MAX_DAYS = 30;

/** PDF statements (GRD-73): checked from the bytes, not the file name. */
export const PDF_MAX_BYTES = 10 * MIB;
export const PDF_MAX_PAGES = 10;

/** Profile changes per user per minute (GRD-68). */
export const PROFILE_UPDATES_PER_MINUTE = 10;

/** AI testcase generation (GRD-124): a model writes the inputs, Judge makes the outputs. */
export const AI_TEST_LIMITS = {
  max_count: 20,
  /** What one generated input may weigh; a model cannot write much more than this anyway. */
  max_input_bytes: 64 * 1024,
  /** What Core asks Judge to send back of each output; 20 of them stay under `total_bytes`. */
  stdout_bytes: 512 * 1024,
  total_bytes: 12 * MIB,
  /** The whole job (model call and Judge) gives up after this long. */
  timeout_ms: 5 * 60 * 1000,
  /** Finished jobs are kept this long, so closing the page does not lose the drafts. */
  retention_ms: 24 * 60 * 60 * 1000,
  /** Starting a job is limited per person: every start costs the author's own quota. */
  starts_per_minute: 5,
  /** The author's extra instructions to the model. */
  note_max_length: 1000,
  key_min_length: 8,
  key_max_length: 512,
} as const;
