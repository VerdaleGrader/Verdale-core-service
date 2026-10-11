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
