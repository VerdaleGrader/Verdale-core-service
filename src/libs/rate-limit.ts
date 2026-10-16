import type { FastifyRequest } from 'fastify';
import type { RateLimitConfigurations } from '@/config';
import { DEFAULT_RATE_LIMITS, RATE_LIMIT_WINDOW_MS } from '@/constants/limits';
import { RateLimitedError } from '@/errors';

export function defaultRateLimits(): RateLimitConfigurations {
  return {
    windowMs: RATE_LIMIT_WINDOW_MS,
    apiPerIp: DEFAULT_RATE_LIMITS.api_per_ip,
    apiPerUser: DEFAULT_RATE_LIMITS.api_per_user,
    signInPerIp: DEFAULT_RATE_LIMITS.sign_in_per_ip,
    submitPerUser: DEFAULT_RATE_LIMITS.submit_per_user,
    submitPerIp: DEFAULT_RATE_LIMITS.submit_per_ip,
    maxPendingSubmissionsPerUser: DEFAULT_RATE_LIMITS.max_pending_submissions_per_user,
  };
}

const ADDRESS_PATTERN = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * The address to count a request against. Fastify's own (`request.ip`, which
 * follows TRUST_PROXY) unless a header that the proxy sets itself is named in
 * CLIENT_IP_HEADER and carries something that looks like an address.
 */
export function clientAddress(request: FastifyRequest, header?: string): string {
  if (header) {
    const value = request.headers[header];
    const candidate = (Array.isArray(value) ? value[0] : value)?.trim();
    if (candidate && ADDRESS_PATTERN.test(candidate)) return candidate;
  }
  return request.ip;
}

/** What `createRateLimit` returns for a request. */
export type LimitResult =
  | { isAllowed: true }
  | { isAllowed: false; isExceeded: boolean; ttlInSeconds: number };

/** 429 with the time to wait, when the request used up its budget. */
export function throwIfExceeded(limit: LimitResult, subject = 'requests') {
  if (!limit.isAllowed && limit.isExceeded) {
    const seconds = Math.max(1, Math.ceil(limit.ttlInSeconds));
    throw new RateLimitedError(seconds, `Too many ${subject}. Try again in ${seconds} seconds.`);
  }
}
