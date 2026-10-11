import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastify, { FastifyError, FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client';
import type { AuthConfigurations } from '@/config';
import {
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  VError,
  ValidationError,
} from '@/errors';
import TLogger, { Layer } from '@/logging/logger';
import AuthController from '@/controllers/auth/auth.controller';
import SystemController from '@/controllers/system/system.controller';
import InviteController from '@/controllers/space/invite.controller';
import SpaceController from '@/controllers/space/space.controller';
import UserController from '@/controllers/user/user.controller';
import { OAuthProviders } from '@/libs/oauth';
import { SESSION_COOKIE } from '@/middleware/session';
import InviteRepository from '@/repositories/invite.repository';
import SessionRepository from '@/repositories/session.repository';
import SpaceRepository from '@/repositories/space.repository';
import UserRepository from '@/repositories/user.repository';
import AuthService from '@/services/auth/auth.service';
import InviteService from '@/services/space/invite.service';
import MemberService from '@/services/space/member.service';
import SpaceService from '@/services/space/space.service';
import SystemService, { ReadinessCheck } from '@/services/system/system.service';
import UserService from '@/services/user/user.service';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** What the account and Space API needs. Left out, only /health and /ready exist. */
export interface ApiDependencies {
  prisma: PrismaClient;
  auth: AuthConfigurations;
  oauthProviders: OAuthProviders;
  now?: () => Date;
}

export interface AppDependencies {
  version: string;
  readinessChecks: ReadinessCheck[];
  api?: ApiDependencies;
}

/**
 * Builds the HTTP app. Dependencies are wired by hand here
 * (repository -> service -> controller), as in the other services.
 */
export function buildApp({ version, readinessChecks, api }: AppDependencies) {
  const logger = new TLogger(Layer.CONTROLLER);

  // The caller's X-Request-Id is reused when well-formed (Frontend or Judge
  // can then correlate), otherwise a UUID is generated. It is the
  // request_id on every log line and every error body.
  const app = fastify({
    logger: false,
    trustProxy: api?.auth.trustProxy ?? false,
    genReqId: (request) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
  });
  app.addHook('onResponse', async (request, reply) => {
    if (request.url === '/health') return;
    logger.setContext('http.request', request.id).info({
      message: 'request',
      data: {
        method: request.method,
        path: request.url,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
    });
  });

  // One error shape for the whole system (contracts: ErrorResponse).
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    let appError: VError;
    if (error instanceof VError) {
      appError = error;
    } else if (error instanceof z.ZodError) {
      appError = new ValidationError(
        error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }))
      );
    } else if (
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode < 500
    ) {
      appError = new VError({
        message: error.message,
        status: error.statusCode,
        error_code: error.code ?? 'BAD_REQUEST',
      });
    } else {
      logger.setContext('http.error', request.id).error({ message: 'Unhandled error', error });
      appError = new InternalServerError();
    }
    return reply.status(appError.status).send(appError.toJSON(request.id));
  });
  app.setNotFoundHandler((request, reply) => {
    const error = new NotFoundError('Route not found.');
    return reply.status(404).send(error.toJSON(request.id));
  });

  const systemController = new SystemController(new SystemService(version, readinessChecks));
  app.get('/health', systemController.health.bind(systemController));
  app.get('/ready', systemController.ready.bind(systemController));

  if (api) {
    registerApi(app, api);
  }

  return app;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Accounts, Spaces, members and invitations under /api/v1. The Frontend
 * proxies /api/* here, so browsers only ever see the web app's origin.
 */
function registerApi(app: FastifyInstance, { prisma, auth, oauthProviders, now }: ApiDependencies) {
  const userRepository = new UserRepository();
  const sessionRepository = new SessionRepository();
  const spaceRepository = new SpaceRepository();
  const inviteRepository = new InviteRepository();

  const authService = new AuthService(
    prisma,
    userRepository,
    sessionRepository,
    spaceRepository,
    oauthProviders,
    auth,
    now
  );
  const userService = new UserService(prisma, userRepository, spaceRepository);
  const spaceService = new SpaceService(prisma, spaceRepository);
  const memberService = new MemberService(prisma, spaceRepository, userRepository, spaceService);
  const inviteService = new InviteService(
    prisma,
    inviteRepository,
    spaceRepository,
    userRepository,
    spaceService,
    now
  );

  const authController = new AuthController(authService, auth, oauthProviders);
  const userController = new UserController(userService);
  const spaceController = new SpaceController(spaceService, memberService, inviteService);
  const inviteController = new InviteController(inviteService);

  // One plugin scope so cookie parsing is loaded before the session hook runs,
  // and the rate limits apply to the API only (not /health or /ready).
  app.register(async (scope) => {
    await scope.register(cookie, { secret: auth.sessionSecret });
    // Generous global limit; the sign-in endpoints get a tight one below.
    await scope.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: '1 minute',
      errorResponseBuilder: (request, context) =>
        new VError({
          message: `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
          status: 429,
          error_code: 'RATE_LIMITED',
        }),
    });

    scope.decorateRequest('currentUser', null);

    scope.addHook('onRequest', async (request) => {
      // CSRF: cookies ride along on cross-site requests, so a state-changing
      // request that carries a session must come from our own web app.
      // SameSite=Lax on the cookie is the first line; this is the second.
      const token = request.cookies?.[SESSION_COOKIE];
      if (
        token &&
        !SAFE_METHODS.has(request.method) &&
        request.headers.origin !== auth.frontendOrigin
      ) {
        throw new ForbiddenError('Cross-site request rejected.');
      }
      request.currentUser = await authService.authenticate(token);
    });

    const signInLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

    await scope.register(
      async (v1) => {
        v1.get('/auth/providers', authController.providersList.bind(authController));
        v1.get(
          '/auth/oauth/:provider/start',
          signInLimit,
          authController.start.bind(authController)
        );
        v1.get(
          '/auth/oauth/:provider/callback',
          signInLimit,
          authController.callback.bind(authController)
        );
        v1.post('/auth/logout', authController.logout.bind(authController));

        v1.get('/me', userController.me.bind(userController));
        v1.patch('/me', userController.updateMe.bind(userController));
        v1.get('/me/spaces', spaceController.listMine.bind(spaceController));
        v1.get('/me/invites', inviteController.listMine.bind(inviteController));
        v1.post('/me/invites/:inviteId/accept', inviteController.acceptById.bind(inviteController));
        v1.post(
          '/me/invites/:inviteId/decline',
          inviteController.declineById.bind(inviteController)
        );
        v1.get('/users/:username', userController.publicProfile.bind(userController));

        v1.get('/spaces', spaceController.listPublic.bind(spaceController));
        v1.post('/spaces', spaceController.create.bind(spaceController));
        v1.get('/spaces/:slug', spaceController.get.bind(spaceController));
        v1.patch('/spaces/:slug', spaceController.update.bind(spaceController));
        v1.post('/spaces/:slug/archive', spaceController.archive.bind(spaceController));
        v1.get('/spaces/:slug/members', spaceController.listMembers.bind(spaceController));
        v1.patch(
          '/spaces/:slug/members/:username',
          spaceController.changeRole.bind(spaceController)
        );
        v1.delete(
          '/spaces/:slug/members/:username',
          spaceController.removeMember.bind(spaceController)
        );
        v1.post('/spaces/:slug/leave', spaceController.leave.bind(spaceController));
        v1.get('/spaces/:slug/invites', spaceController.listInvites.bind(spaceController));
        v1.post('/spaces/:slug/invites', spaceController.createInvite.bind(spaceController));
        v1.delete(
          '/spaces/:slug/invites/:inviteId',
          spaceController.revokeInvite.bind(spaceController)
        );

        v1.get('/invites/:token', inviteController.preview.bind(inviteController));
        v1.post('/invites/:token/accept', inviteController.acceptByToken.bind(inviteController));
        v1.post('/invites/:token/decline', inviteController.declineByToken.bind(inviteController));
      },
      { prefix: '/api/v1' }
    );
  });
}
