import { createHash, randomBytes } from 'node:crypto';

/** 256-bit random token, URL-safe. Shown to its owner once; only the hash is stored. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
