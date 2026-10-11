import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sign, signedHeaders, stringToSign, verify } from '@/libs/hmac';

interface Vector {
  key_id: string;
  secret: string;
  timestamp: number;
  method: string;
  path: string;
  body: string;
  string_to_sign: string;
  signature: string;
}

// Shared with Judge's Go implementation, so the two cannot drift apart.
const { vectors } = JSON.parse(
  readFileSync(path.join(__dirname, '../../contracts/hmac-test-vectors.json'), 'utf8')
) as { vectors: Vector[] };

describe('HMAC signing', () => {
  it.each(vectors)('matches the shared vector for $method $path', (vector) => {
    expect(stringToSign(vector.timestamp, vector.method, vector.path, vector.body)).toBe(
      vector.string_to_sign
    );
    expect(sign(vector.secret, vector.timestamp, vector.method, vector.path, vector.body)).toBe(
      vector.signature
    );
    const headers = {
      'x-verdale-key-id': vector.key_id,
      'x-verdale-timestamp': String(vector.timestamp),
      'x-verdale-signature': vector.signature,
    };
    const result = verify(
      headers,
      { [vector.key_id]: vector.secret },
      vector.method,
      vector.path,
      vector.body,
      {
        now: (vector.timestamp + 10) * 1000,
      }
    );
    expect(result).toEqual({ ok: true, keyId: vector.key_id });
  });

  it('rejects bad requests with the reason', () => {
    const secret = '0123456789abcdef0123456789abcdef';
    const now = 1_800_000_000_000;
    const lower = (headers: Record<string, string>) =>
      Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    const headers = lower(signedHeaders('core', secret, 'POST', '/internal/jobs', '{}', now));

    expect(verify(headers, { core: secret }, 'POST', '/internal/jobs', '{}', { now }).ok).toBe(
      true
    );
    expect(verify({}, { core: secret }, 'POST', '/internal/jobs', '{}', { now })).toEqual({
      ok: false,
      reason: 'MISSING_SIGNATURE',
    });
    expect(verify(headers, { other: secret }, 'POST', '/internal/jobs', '{}', { now })).toEqual({
      ok: false,
      reason: 'UNKNOWN_KEY_ID',
    });
    expect(
      verify(headers, { core: secret }, 'POST', '/internal/jobs', '{}', { now: now + 301_000 })
    ).toEqual({
      ok: false,
      reason: 'STALE_TIMESTAMP',
    });
    expect(verify(headers, { core: secret }, 'POST', '/internal/jobs', '{"x":1}', { now })).toEqual(
      {
        ok: false,
        reason: 'INVALID_SIGNATURE',
      }
    );
  });
});
