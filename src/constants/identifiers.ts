/**
 * usernames and Space slugs share one namespace (a personal Space's slug is
 * its owner's username). Lower-case, 3 to 32 characters, start with a letter
 * or digit, then letters, digits, "_" or "-".
 */
export const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]{2,31}$/;

/** Names that would collide with routes or look like official accounts. */
export const RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'api',
  'auth',
  'login',
  'logout',
  'signup',
  'settings',
  'spaces',
  'space',
  'users',
  'user',
  'me',
  'invites',
  'invite',
  'problems',
  'problem',
  'submissions',
  'static',
  'assets',
  'health',
  'ready',
  'verdale',
  'support',
  'help',
  'root',
  'system',
  'null',
  'undefined',
]);

export function isValidIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value) && !RESERVED_IDENTIFIERS.has(value);
}

/**
 * Problem slugs live inside a Space (/spaces/<space>/problems/<slug>), so they
 * only have to avoid the words that are routes below a problem.
 */
export const PROBLEM_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export const RESERVED_PROBLEM_SLUGS: ReadonlySet<string> = new Set([
  'new',
  'edit',
  'editor',
  'tests',
  'solutions',
  'submissions',
  'images',
  'publish',
  'archive',
  'settings',
]);

export function isValidProblemSlug(value: string): boolean {
  return PROBLEM_SLUG_PATTERN.test(value) && !RESERVED_PROBLEM_SLUGS.has(value);
}

/**
 * Track and Collection slugs live inside a Space (/spaces/<space>/tracks/<slug>).
 * Same shape as problem slugs; the reserved words are the routes below a Track.
 */
export const CATALOG_RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'new',
  'edit',
  'order',
  'members',
  'invites',
  'progress',
  'problems',
  'collections',
  'archive',
  'settings',
]);

export function isValidCatalogSlug(value: string): boolean {
  return PROBLEM_SLUG_PATTERN.test(value) && !CATALOG_RESERVED_SLUGS.has(value);
}

export const CATALOG_SLUG_MESSAGE =
  'Use 2 to 64 lower-case letters, digits, "-" or "_", starting with a letter or digit.';
