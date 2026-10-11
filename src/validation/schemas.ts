import { z } from 'zod';

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

export const changeRoleBody = z.object({ role: z.enum(['owner', 'editor', 'solver']) });

export const createInviteBody = z.object({
  role: z.enum(['editor', 'solver']),
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
