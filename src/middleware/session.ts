import '@fastify/cookie';
import type { FastifyRequest } from 'fastify';
import type { User } from '../../generated/prisma/client';
import { UnauthorizedError } from '@/errors';

export const SESSION_COOKIE = 'vd_session';
export const OAUTH_STATE_COOKIE = 'vd_oauth';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the session hook; null for visitors. */
    currentUser: User | null;
  }
}

export function requireUser(request: FastifyRequest): User {
  if (!request.currentUser) throw new UnauthorizedError('Please log in.');
  return request.currentUser;
}
