import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Request signing between Core and Judge, as specified in
 * contracts/HMAC.md. Core signs job requests and verifies result callbacks.
 */
export const HEADER_KEY_ID = 'x-verdale-key-id';
export const HEADER_TIMESTAMP = 'x-verdale-timestamp';
export const HEADER_SIGNATURE = 'x-verdale-signature';

const VERSION = 'v1';
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function stringToSign(
  timestamp: number,
  method: string,
  path: string,
  body: Buffer | string
): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return [VERSION, String(timestamp), method.toUpperCase(), path, bodyHash].join('\n');
}

export function sign(
  secret: string,
  timestamp: number,
  method: string,
  path: string,
  body: Buffer | string
): string {
  const digest = createHmac('sha256', secret)
    .update(stringToSign(timestamp, method, path, body))
    .digest('hex');
  return `${VERSION}=${digest}`;
}

export function signedHeaders(
  keyId: string,
  secret: string,
  method: string,
  path: string,
  body: Buffer | string,
  now = Date.now()
) {
  const timestamp = Math.floor(now / 1000);
  return {
    'X-Verdale-Key-Id': keyId,
    'X-Verdale-Timestamp': String(timestamp),
    'X-Verdale-Signature': sign(secret, timestamp, method, path, body),
  };
}

export type VerifyFailure =
  | 'MISSING_SIGNATURE'
  | 'UNKNOWN_KEY_ID'
  | 'STALE_TIMESTAMP'
  | 'INVALID_SIGNATURE';

export function verify(
  headers: Record<string, string | string[] | undefined>,
  keyring: Record<string, string>,
  method: string,
  path: string,
  body: Buffer | string,
  { toleranceSeconds = 300, now = Date.now() } = {}
): { ok: true; keyId: string } | { ok: false; reason: VerifyFailure } {
  const keyId = headers[HEADER_KEY_ID];
  const rawTimestamp = headers[HEADER_TIMESTAMP];
  const signature = headers[HEADER_SIGNATURE];
  if (
    typeof keyId !== 'string' ||
    !KEY_ID_PATTERN.test(keyId) ||
    typeof rawTimestamp !== 'string' ||
    !/^\d+$/.test(rawTimestamp) ||
    typeof signature !== 'string' ||
    !signature.startsWith(`${VERSION}=`)
  ) {
    return { ok: false, reason: 'MISSING_SIGNATURE' };
  }
  const secret = keyring[keyId];
  if (secret === undefined) return { ok: false, reason: 'UNKNOWN_KEY_ID' };
  const timestamp = Number(rawTimestamp);
  if (Math.abs(Math.floor(now / 1000) - timestamp) > toleranceSeconds)
    return { ok: false, reason: 'STALE_TIMESTAMP' };
  const expected = Buffer.from(sign(secret, timestamp, method, path, body));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'INVALID_SIGNATURE' };
  }
  return { ok: true, keyId };
}
