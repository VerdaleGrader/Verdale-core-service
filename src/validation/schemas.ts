import { z } from 'zod';
import {
  LANGUAGES,
  MEMORY_LIMIT_KB,
  SOURCE_MAX_BYTES,
  AI_TEST_LIMITS,
  STATEMENT_MAX_LENGTH,
  SUBMISSION_LIST_MAX_PAGE_SIZE,
  TIME_LIMIT_MS,
  TITLE_MAX_LENGTH,
  TRACK_INVITE_MAX_DAYS,
  TRACK_LIMITS,
} from '@/constants/limits';

export const pagination = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  page_size: z.coerce.number().int().min(1).max(50).default(20),
  q: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((value) => value || undefined),
};

const queryBoolean = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

export const listQuery = z.object({ ...pagination, archived: queryBoolean });
export const publicListQuery = z.object(pagination);

/** Names people see: no control characters, so no line breaks or NULs inside a name. */
const hasNoControlCharacters = (value: string) => !/[\p{Cc}\u2028\u2029]/u.test(value);
const CONTROL_MESSAGE = 'Remove line breaks and other control characters.';

const spaceName = z.string().trim().min(1).max(80);
const spaceDescription = z.string().trim().max(500);
const visibility = z.enum(['public', 'private']);

export const createSpaceBody = z.object({
  name: spaceName,
  slug: z.string().trim().min(1).max(64),
  description: spaceDescription.default(''),
  visibility: visibility.default('private'),
  /** The name of the Track every new Space starts with; "General" when left out. */
  track_name: z
    .string()
    .trim()
    .min(1, 'Enter a name.')
    .max(80, 'Use at most 80 characters.')
    .refine(hasNoControlCharacters, CONTROL_MESSAGE)
    .optional(),
});

export const updateSpaceBody = z
  .object({
    name: spaceName.optional(),
    description: spaceDescription.optional(),
    visibility: visibility.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Send at least one field to change.',
  });

const legalVersion = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the version date, YYYY-MM-DD.');

/** The versions of the documents the page showed when the user pressed accept (GRD-122). */
export const legalAcceptanceBody = z
  .object({ terms: legalVersion, privacy: legalVersion })
  .strict();

export const updateMeBody = z
  .object({
    display_name: z
      .string()
      .trim()
      .min(1, 'Enter a name.')
      .max(64, 'Use at most 64 characters.')
      .refine(hasNoControlCharacters, CONTROL_MESSAGE)
      .optional(),
    username: z.string().trim().min(1).max(64).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Send at least one field to change.',
  });

export const changeRoleBody = z.object({
  role: z.enum(['owner', 'administrator', 'editor', 'observer', 'solver']),
});

export const createInviteBody = z.object({
  role: z.enum(['administrator', 'editor', 'observer', 'solver']),
  username: z.string().trim().min(1).max(64).optional(),
  expires_in_days: z.number().int().min(1).max(30).default(7),
});

export const slugParams = z.object({ slug: z.string().min(1).max(64) });
export const memberParams = slugParams.extend({ username: z.string().min(1).max(64) });
export const inviteParams = slugParams.extend({ inviteId: z.uuid() });
export const inviteIdParams = z.object({ inviteId: z.uuid() });
export const tokenParams = z.object({ token: z.string().min(20).max(128) });
export const usernameParams = z.object({ username: z.string().min(1).max(64) });
export const providerParams = z.object({ provider: z.enum(['github', 'google']) });

// --- Problems, tests, solutions, submissions (M3) ---------------------------

/** Postgres text cannot hold a NUL character; refuse it where people can paste it. */
const withoutNul = (value: string) => !value.includes('\u0000');
const NUL_MESSAGE = 'Remove the NUL character (U+0000).';

const problemTitle = z
  .string()
  .trim()
  .min(1, 'Enter a title.')
  .max(TITLE_MAX_LENGTH, `Use at most ${TITLE_MAX_LENGTH} characters.`)
  .refine(withoutNul, NUL_MESSAGE);

const problemStatement = z
  .string()
  .max(STATEMENT_MAX_LENGTH, `Use at most ${STATEMENT_MAX_LENGTH} characters.`)
  .refine(withoutNul, NUL_MESSAGE);

const timeLimit = z
  .number()
  .int('Use a whole number of milliseconds.')
  .min(TIME_LIMIT_MS.min, `Use at least ${TIME_LIMIT_MS.min} ms.`)
  .max(TIME_LIMIT_MS.max, `Use at most ${TIME_LIMIT_MS.max} ms.`);

const memoryLimit = z
  .number()
  .int('Use a whole number of kilobytes.')
  .min(MEMORY_LIMIT_KB.min, `Use at least ${MEMORY_LIMIT_KB.min / 1024} MB.`)
  .max(MEMORY_LIMIT_KB.max, `Use at most ${MEMORY_LIMIT_KB.max / 1024} MB.`);

const language = z.enum(LANGUAGES as [string, ...string[]]);

const allowedLanguages = z
  .array(language)
  .min(1, 'Allow at least one language.')
  .refine((list) => new Set(list).size === list.length, 'List each language once.');

export const problemSlugParams = slugParams.extend({ problemSlug: z.string().min(1).max(64) });
export const testParams = problemSlugParams.extend({ testId: z.uuid() });
export const solutionParams = problemSlugParams.extend({ solutionId: z.uuid() });
export const submissionParams = z.object({ submissionId: z.uuid() });

export const createProblemBody = z.object({
  slug: z.string().trim().min(1).max(64),
  title: problemTitle,
  statement: problemStatement.default(''),
  time_limit_ms: timeLimit.default(TIME_LIMIT_MS.default),
  memory_limit_kb: memoryLimit.default(MEMORY_LIMIT_KB.default),
  allowed_languages: allowedLanguages.default([...LANGUAGES]),
});

export const updateProblemBody = z
  .object({
    title: problemTitle.optional(),
    statement: problemStatement.optional(),
    statement_mode: z.enum(['markdown', 'pdf']).optional(),
    time_limit_ms: timeLimit.optional(),
    memory_limit_kb: memoryLimit.optional(),
    allowed_languages: allowedLanguages.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Send at least one field to change.',
  });

/** A Minor or Major update of a published problem (GRD-117, GRD-54); the slug is not editable. */
export const publishedUpdateBody = z
  .object({
    expected_version: z.object({
      major: z.number().int().min(1),
      minor: z.number().int().min(0),
    }),
    force_major: z.boolean().default(false),
    title: problemTitle.optional(),
    statement: problemStatement.optional(),
    statement_mode: z.enum(['markdown', 'pdf']).optional(),
    time_limit_ms: timeLimit.optional(),
    memory_limit_kb: memoryLimit.optional(),
    allowed_languages: allowedLanguages.optional(),
  })
  .refine(
    (body) =>
      body.force_major ||
      Object.keys(body).some((key) => key !== 'expected_version' && key !== 'force_major'),
    { message: 'Send at least one field to change, or force_major.' }
  );

export const historyQuery = z.object({
  page: pagination.page,
  page_size: pagination.page_size,
});

export const problemListQuery = z.object({
  ...pagination,
  status: z.enum(['published', 'draft', 'archived', 'all']).default('published'),
  mine: queryBoolean,
});

export const updateTestBody = z.object({ is_sample: z.boolean() });

export const reorderTestsBody = z.object({
  test_ids: z.array(z.uuid()).max(500),
});

const solutionSource = z
  .string()
  .min(1, 'Enter the source code.')
  .refine(withoutNul, NUL_MESSAGE)
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= SOURCE_MAX_BYTES,
    `Use at most ${SOURCE_MAX_BYTES / 1024} KiB.`
  );

export const createSolutionBody = z.object({
  language,
  source: solutionSource,
  is_primary: z.boolean().optional(),
});

export const updateSolutionBody = z
  .object({
    language: language.optional(),
    source: solutionSource.optional(),
    is_primary: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Send at least one field to change.',
  });

export const createSubmissionBody = z.object({
  language,
  source: solutionSource,
  track: z.string().trim().min(1).max(64).optional(),
});

export const submissionListQuery = z.object({
  page: pagination.page,
  page_size: z.coerce.number().int().min(1).max(SUBMISSION_LIST_MAX_PAGE_SIZE).default(20),
  scope: z.enum(['mine', 'all']).default('mine'),
});

export const assetParams = z.object({
  name: z.string().regex(/^[a-f0-9]{32}\.(png|jpg|webp)$/),
});

// --- Tracks, Collections, Track members (M3: GRD-78 to GRD-82) --------------

const groupName = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(80, 'Use at most 80 characters.')
  .refine(hasNoControlCharacters, CONTROL_MESSAGE);
const groupDescription = z
  .string()
  .trim()
  .max(500, 'Use at most 500 characters.')
  .refine(withoutNul, NUL_MESSAGE);
const groupSlug = z.string().trim().min(1).max(64);
const atLeastOneField = (body: object) => Object.keys(body).length > 0;
const AT_LEAST_ONE = { message: 'Send at least one field to change.' };
const requestList = <T extends z.ZodType>(item: T) =>
  z.array(item).min(1, 'Name at least one.').max(TRACK_LIMITS.max_items_per_request);

export const trackParams = slugParams.extend({ trackSlug: z.string().min(1).max(64) });
export const trackMemberParams = trackParams.extend({ username: z.string().min(1).max(64) });
export const trackInviteParams = trackParams.extend({ inviteId: z.uuid() });
export const collectionParams = slugParams.extend({ collectionSlug: z.string().min(1).max(64) });

const trackVisibility = z.enum(['space', 'members']);

export const createTrackBody = z.object({
  name: groupName,
  slug: groupSlug,
  description: groupDescription.default(''),
  visibility: trackVisibility.default('space'),
});

export const updateTrackBody = z
  .object({
    name: groupName.optional(),
    slug: groupSlug.optional(),
    description: groupDescription.optional(),
    visibility: trackVisibility.optional(),
  })
  .refine(atLeastOneField, AT_LEAST_ONE);

export const reorderTracksBody = z.object({
  track_ids: z.array(z.uuid()).max(TRACK_LIMITS.max_tracks_per_space),
});

export const createCollectionBody = z.object({
  name: groupName,
  slug: groupSlug,
  description: groupDescription.default(''),
  track_slugs: z.array(groupSlug).max(TRACK_LIMITS.max_tracks_per_space).default([]),
});

export const updateCollectionBody = z
  .object({
    name: groupName.optional(),
    slug: groupSlug.optional(),
    description: groupDescription.optional(),
  })
  .refine(atLeastOneField, AT_LEAST_ONE);

export const problemSlugsBody = z.object({
  problem_slugs: requestList(z.string().trim().min(1).max(64)),
});
export const collectionSlugsBody = z.object({
  collection_slugs: requestList(z.string().trim().min(1).max(64)),
});
export const reorderProblemsBody = z.object({
  problem_ids: z.array(z.uuid()).max(TRACK_LIMITS.max_problems_per_collection),
});
export const reorderCollectionsBody = z.object({
  collection_ids: z.array(z.uuid()).max(TRACK_LIMITS.max_collections_per_space),
});

export const createTrackInviteBody = z.object({
  username: z.string().trim().min(1).max(64).optional(),
  expires_in_days: z.number().int().min(1).max(TRACK_INVITE_MAX_DAYS).default(7),
});

export const progressQuery = z.object({ username: z.string().trim().min(1).max(64).optional() });

export const statementPdfQuery = z.object({
  draft: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

// --- Testcases page: staged files, one save, preview, generate (M3: GRD-108) ---

const sha256Ref = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/, 'Not a file hash.') });

/** Pasted text becomes a staged file; the body limit (1 MiB) keeps pasting for small testcases. */
export const stageTextBody = z.object({
  text: z
    .string()
    .max(1024 * 1024, 'Use Upload files for anything over 1 MiB.')
    .refine((value) => !value.includes('\u0000'), 'Remove the NUL character (U+0000).'),
});

export const batchTestsBody = z.object({
  revision: z.string().min(1).max(64).optional(),
  tests: z
    .array(
      z.object({
        id: z.uuid().optional(),
        is_sample: z.boolean(),
        input: sha256Ref.optional(),
        output: sha256Ref.optional(),
      })
    )
    .max(500),
});

export const testFileParams = testParams.extend({ side: z.enum(['input', 'output']) });

export const fileSliceQuery = z.object({
  from_line: z.coerce.number().int().min(1).max(100_000_000).default(1),
  max_lines: z.coerce.number().int().min(1).max(1000).default(10),
  inline: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const generateBody = z.object({
  solution_id: z.uuid(),
  test_ids: z.array(z.uuid()).min(1).max(500).optional(),
});

export const generateParams = problemSlugParams.extend({ jobId: z.uuid() });

// --- AI testcase generation (GRD-124) -----------------------------------------

const aiProvider = z.enum(['gemini', 'claude']);

export const aiProviderParams = z.object({ provider: aiProvider });

export const saveAiKeyBody = z.object({
  api_key: z
    .string()
    .min(1)
    .max(AI_TEST_LIMITS.key_max_length + 64),
});

export const startAiTestsBody = z.object({
  provider: aiProvider,
  count: z.number().int().min(1).max(AI_TEST_LIMITS.max_count),
  categories: z
    .array(z.enum(['edge', 'max', 'random']))
    .max(3)
    .optional(),
  solution_id: z.uuid(),
  include_solution: z.boolean().optional(),
});

export const aiTestsParams = generateParams;

// --- The Space's submissions for staff (M3: GRD-93) ---------------------------

const VERDICT_CODES = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'OLE', 'ISE'] as const;

const optionalText = z
  .string()
  .trim()
  .max(80)
  .optional()
  .transform((value) => value || undefined);

/** `verdict=AC,WA` */
const verdictList = z
  .string()
  .optional()
  .transform((value) =>
    value ? value.split(',').map((item) => item.trim().toUpperCase()) : undefined
  )
  .pipe(z.array(z.enum(VERDICT_CODES)).min(1).max(8).optional());

const listPage = { page: pagination.page, page_size: pagination.page_size };

export const spaceSubmissionsQuery = z.object({
  member: optionalText,
  q: optionalText,
  problem: optionalText,
  track: optionalText,
  verdict: verdictList,
  language: z.enum(['c', 'cpp', 'python']).optional(),
  version: z.coerce.number().int().min(1).max(100_000).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(['newest', 'oldest', 'member', 'tests_passed', 'time']).default('newest'),
  page: pagination.page,
  page_size: z.coerce.number().int().min(1).max(SUBMISSION_LIST_MAX_PAGE_SIZE).default(20),
});

const windowName = z.enum(['any', '7d', '30d']).default('any');
const problemStatusFilter = z.enum(['all', 'published', 'draft', 'archived']).default('all');

export const byMemberQuery = z.object({
  q: optionalText,
  role: z.enum(['owner', 'administrator', 'editor', 'observer', 'solver', 'none']).optional(),
  track: optionalText,
  window: windowName,
  sort: z.enum(['last_submission', 'solved', 'name']).default('last_submission'),
  hide_empty: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  ...listPage,
});

export const memberProblemsQuery = z.object({
  q: optionalText,
  track: optionalText,
  status: z.enum(['all', 'solved', 'unsolved']).default('all'),
  sort: z.enum(['last_submission', 'attempts', 'name']).default('last_submission'),
  ...listPage,
});

export const byTrackQuery = z.object({
  q: optionalText,
  visibility: z.enum(['space', 'members']).optional(),
  window: windowName,
  sort: z.enum(['track_order', 'last_submission', 'submissions']).default('track_order'),
});

export const trackProblemsQuery = z.object({
  q: optionalText,
  collection: optionalText,
  status: problemStatusFilter,
  sort: z.enum(['track_order', 'solved_fewest', 'last_submission']).default('track_order'),
});

export const byProblemQuery = z.object({
  q: optionalText,
  track: optionalText,
  status: problemStatusFilter,
  sort: z
    .enum(['last_submission', 'submissions', 'solved_fewest', 'name'])
    .default('last_submission'),
  ...listPage,
});

export const versionsQuery = z.object({ problem: optionalText });

export const submissionTestParams = submissionParams.extend({
  position: z.coerce.number().int().min(1).max(100_000),
});

export const testDetailQuery = z.object({
  part: z.enum(['input', 'expected', 'output', 'stderr']).optional(),
  from_line: z.coerce.number().int().min(1).max(100_000_000).default(1),
  max_lines: z.coerce.number().int().min(1).max(1000).default(10),
});
