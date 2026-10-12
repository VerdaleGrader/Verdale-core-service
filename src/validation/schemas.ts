import { z } from 'zod';
import {
  LANGUAGES,
  MEMORY_LIMIT_KB,
  SOURCE_MAX_BYTES,
  STATEMENT_MAX_LENGTH,
  SUBMISSION_LIST_MAX_PAGE_SIZE,
  TIME_LIMIT_MS,
  TITLE_MAX_LENGTH,
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

const spaceName = z.string().trim().min(1).max(80);
const spaceDescription = z.string().trim().max(500);
const visibility = z.enum(['public', 'private']);

export const createSpaceBody = z.object({
  name: spaceName,
  slug: z.string().trim().min(1).max(64),
  description: spaceDescription.default(''),
  visibility: visibility.default('private'),
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

export const updateMeBody = z
  .object({
    display_name: z.string().trim().min(1).max(64).optional(),
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
    time_limit_ms: timeLimit.optional(),
    memory_limit_kb: memoryLimit.optional(),
    allowed_languages: allowedLanguages.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Send at least one field to change.',
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
});

export const submissionListQuery = z.object({
  page: pagination.page,
  page_size: z.coerce.number().int().min(1).max(SUBMISSION_LIST_MAX_PAGE_SIZE).default(20),
  scope: z.enum(['mine', 'all']).default('mine'),
});

export const assetParams = z.object({
  name: z.string().regex(/^[a-f0-9]{32}\.(png|jpg|webp)$/),
});
