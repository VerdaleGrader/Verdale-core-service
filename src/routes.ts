import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastify, { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client';
import type { AuthConfigurations, JudgeConfigurations } from '@/config';
import {
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  VError,
  ValidationError,
} from '@/errors';
import TLogger, { Layer } from '@/logging/logger';
import { JudgeClient } from '@/libs/judge';
import { Storages } from '@/libs/storage';
import AssetController from '@/controllers/problem/asset.controller';
import ProblemController from '@/controllers/problem/problem.controller';
import VersionController from '@/controllers/problem/version.controller';
import SolutionController from '@/controllers/problem/solution.controller';
import TestCaseController from '@/controllers/problem/test-case.controller';
import JudgeResultController from '@/controllers/judge/judge-result.controller';
import SubmissionController from '@/controllers/submission/submission.controller';
import TrackController, { CollectionController } from '@/controllers/track/track.controller';
import AuthController from '@/controllers/auth/auth.controller';
import SystemController from '@/controllers/system/system.controller';
import InviteController from '@/controllers/space/invite.controller';
import SpaceController from '@/controllers/space/space.controller';
import LegalController from '@/controllers/legal/legal.controller';
import UserController from '@/controllers/user/user.controller';
import { OAuthProviders } from '@/libs/oauth';
import { SESSION_COOKIE } from '@/middleware/session';
import AuditRepository from '@/repositories/audit.repository';
import InviteRepository from '@/repositories/invite.repository';
import ProblemRepository from '@/repositories/problem.repository';
import HistoryRepository from '@/repositories/history.repository';
import VerificationRepository from '@/repositories/verification.repository';
import LegalRepository from '@/repositories/legal.repository';
import SessionRepository from '@/repositories/session.repository';
import SolutionRepository from '@/repositories/solution.repository';
import SpaceRepository from '@/repositories/space.repository';
import SubmissionRepository from '@/repositories/submission.repository';
import GenerateRepository from '@/repositories/generate.repository';
import AiCredentialRepository from '@/repositories/ai-credential.repository';
import AiTestRepository from '@/repositories/ai-test.repository';
import AiCredentialController from '@/controllers/user/ai-credential.controller';
import AiTestController from '@/controllers/problem/ai-test.controller';
import AiTestService from '@/services/problem/ai-test.service';
import AiCredentialService from '@/services/user/ai-credential.service';
import type { AiClient } from '@/libs/ai-provider';
import type SecretBox from '@/libs/crypto';
import TestCaseRepository from '@/repositories/test-case.repository';
import TrackRepository from '@/repositories/track.repository';
import UserRepository from '@/repositories/user.repository';
import AuthService from '@/services/auth/auth.service';
import LegalService, { LegalAcceptanceRequiredError } from '@/services/legal/legal.service';
import ImageService from '@/services/problem/image.service';
import ProblemService from '@/services/problem/problem.service';
import SolutionService from '@/services/problem/solution.service';
import StatementService from '@/services/problem/statement.service';
import GenerateService from '@/services/problem/generate.service';
import VerificationService from '@/services/problem/verification.service';
import VersionService from '@/services/problem/version.service';
import TestCaseService from '@/services/problem/test-case.service';
import JudgeResultService from '@/services/judge/judge-result.service';
import JudgeDispatcher from '@/services/submission/dispatcher';
import SubmissionService from '@/services/submission/submission.service';
import SubmissionReviewService from '@/services/submission/submission-review.service';
import SubmissionReviewController from '@/controllers/submission/submission-review.controller';
import SubmissionReportRepository from '@/repositories/submission-report.repository';
import {
  AI_TEST_LIMITS,
  PROFILE_UPDATES_PER_MINUTE,
  SUBMISSIONS_PER_MINUTE,
  TEST_LIMITS,
} from '@/constants/limits';
import InviteService from '@/services/space/invite.service';
import MemberService from '@/services/space/member.service';
import SpaceService from '@/services/space/space.service';
import SystemService, { ReadinessCheck } from '@/services/system/system.service';
import CollectionService from '@/services/track/collection.service';
import ProgressService from '@/services/track/progress.service';
import TrackMemberService from '@/services/track/track-member.service';
import TrackService from '@/services/track/track.service';
import UserService from '@/services/user/user.service';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** What the account and Space API needs. Left out, only /health and /ready exist. */
export interface ApiDependencies {
  prisma: PrismaClient;
  auth: AuthConfigurations;
  oauthProviders: OAuthProviders;
  /** Private bucket for tests, public bucket for statement pictures. */
  storage: Storages;
  judge: {
    client: JudgeClient;
    config: Pick<JudgeConfigurations, 'callbackKeys' | 'callbackUrl'>;
  };
  /** Base URL of statement pictures, e.g. "/api/v1/assets" or the public bucket's domain. */
  publicAssetBaseUrl: string;
  /** Test knobs; production leaves them out. */
  tuning?: {
    streamIntervalMs?: number;
    dispatchGiveUpMs?: number;
    generateTimeoutMs?: number;
    aiTestTimeoutMs?: number;
    verifyTimeoutMs?: number;
  };
  /** AI testcase generation (GRD-124). `secretBox` absent: the feature is off. */
  ai: { client: AiClient; secretBox?: SecretBox };
  /** Publish rules from the environment (`PUBLISH_MIN_HIDDEN_TESTS`); the default is 1. */
  publish?: { minHiddenTests: number };
  now?: () => Date;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Hands queued submissions to Judge; index.ts starts and stops its background loop. */
    dispatcher?: JudgeDispatcher;
    /** Creates expected outputs from solutions; index.ts starts and stops its background loop. */
    generator?: GenerateService;
    /** Drafts testcases with a model; index.ts starts and stops its background loop. */
    aiTester?: AiTestService;
  }
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
      logger.setContext('http.error', request.id).error({
        message: 'Unhandled error',
        data: {
          method: request.method,
          path: request.url,
          params: request.params,
          userId: (request as { user?: { id?: string } }).user?.id,
        },
        error,
      });
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

/** Calls a user may make before accepting the current legal documents (GRD-122). */
function isLegalExempt(request: FastifyRequest): boolean {
  const path = (request.url.split('?')[0] ?? '').replace(/\/+$/, '');
  if (request.method === 'GET' && path === '/api/v1/me') return true;
  if (request.method === 'POST' && path === '/api/v1/me/legal-acceptance') return true;
  // Sign-in, sign-out and the provider list: a user must be able to leave or switch account.
  return path.startsWith('/api/v1/auth/');
}

/**
 * Accounts, Spaces, members and invitations under /api/v1. The Frontend
 * proxies /api/* here, so browsers only ever see the web app's origin.
 */
function registerApi(
  app: FastifyInstance,
  {
    prisma,
    auth,
    oauthProviders,
    storage,
    judge,
    publicAssetBaseUrl,
    tuning,
    publish,
    ai,
    now,
  }: ApiDependencies
) {
  const userRepository = new UserRepository();
  const sessionRepository = new SessionRepository();
  const spaceRepository = new SpaceRepository();
  const inviteRepository = new InviteRepository();
  const trackRepository = new TrackRepository();
  const auditRepository = new AuditRepository();

  const legalService = new LegalService(prisma, new LegalRepository(), now);
  const authService = new AuthService(
    prisma,
    userRepository,
    sessionRepository,
    spaceRepository,
    trackRepository,
    legalService,
    oauthProviders,
    auth,
    now
  );
  const userService = new UserService(prisma, userRepository, spaceRepository);
  const spaceService = new SpaceService(prisma, spaceRepository, trackRepository);
  const memberService = new MemberService(
    prisma,
    spaceRepository,
    userRepository,
    spaceService,
    trackRepository
  );

  const problemRepository = new ProblemRepository();
  const verificationRepository = new VerificationRepository();
  const historyRepository = new HistoryRepository();
  const testCaseRepository = new TestCaseRepository();
  const solutionRepository = new SolutionRepository();
  const submissionRepository = new SubmissionRepository();

  const trackService = new TrackService(
    prisma,
    trackRepository,
    spaceRepository,
    submissionRepository,
    spaceService
  );
  const collectionService = new CollectionService(
    prisma,
    trackRepository,
    problemRepository,
    spaceRepository,
    submissionRepository,
    spaceService,
    trackService
  );
  const trackMemberService = new TrackMemberService(
    prisma,
    trackRepository,
    spaceRepository,
    userRepository,
    auditRepository,
    trackService
  );
  const inviteService = new InviteService(
    prisma,
    inviteRepository,
    spaceRepository,
    userRepository,
    spaceService,
    trackService,
    trackRepository,
    auditRepository,
    now
  );
  const progressService = new ProgressService(
    prisma,
    trackRepository,
    spaceRepository,
    userRepository,
    submissionRepository,
    trackService
  );

  const problemService = new ProblemService(
    prisma,
    problemRepository,
    testCaseRepository,
    solutionRepository,
    spaceService,
    storage.tests,
    trackRepository,
    verificationRepository,
    historyRepository,
    { minHiddenTests: publish?.minHiddenTests ?? 1 },
    now
  );
  const statementService = new StatementService(
    prisma,
    problemRepository,
    problemService,
    storage.tests
  );
  const testCaseService = new TestCaseService(
    prisma,
    problemRepository,
    testCaseRepository,
    problemService,
    storage.tests
  );
  const solutionService = new SolutionService(
    prisma,
    problemRepository,
    solutionRepository,
    problemService
  );
  const imageService = new ImageService(prisma, problemService, storage.assets, publicAssetBaseUrl);
  const generateService = new GenerateService(
    prisma,
    new GenerateRepository(),
    problemRepository,
    testCaseRepository,
    solutionRepository,
    problemService,
    judge.client,
    storage.tests,
    { callbackUrl: judge.config.callbackUrl, now, timeoutMs: tuning?.generateTimeoutMs }
  );
  app.decorate('generator', generateService);
  const aiCredentialService = new AiCredentialService(
    prisma,
    new AiCredentialRepository(),
    ai.secretBox
  );
  const aiTestService = new AiTestService(
    prisma,
    new AiTestRepository(),
    problemRepository,
    solutionRepository,
    problemService,
    aiCredentialService,
    ai.client,
    judge.client,
    storage.tests,
    { callbackUrl: judge.config.callbackUrl, now, timeoutMs: tuning?.aiTestTimeoutMs }
  );
  app.decorate('aiTester', aiTestService);
  const dispatcher = new JudgeDispatcher(
    prisma,
    submissionRepository,
    testCaseRepository,
    problemRepository,
    judge.client,
    { callbackUrl: judge.config.callbackUrl, now, giveUpMs: tuning?.dispatchGiveUpMs }
  );
  app.decorate('dispatcher', dispatcher);
  const verificationService = new VerificationService(
    prisma,
    verificationRepository,
    problemRepository,
    testCaseRepository,
    solutionRepository,
    problemService,
    judge.client,
    { callbackUrl: judge.config.callbackUrl, now, timeoutMs: tuning?.verifyTimeoutMs }
  );
  // Verification runs ride the dispatcher's loop (retries with backoff, deadlines).
  dispatcher.attachVerifier(verificationService);
  const versionService = new VersionService(
    prisma,
    problemRepository,
    historyRepository,
    verificationRepository,
    problemService,
    now
  );
  const submissionService = new SubmissionService(
    prisma,
    submissionRepository,
    testCaseRepository,
    problemRepository,
    spaceRepository,
    problemService,
    dispatcher,
    trackRepository,
    now
  );
  const submissionReviewService = new SubmissionReviewService(
    prisma,
    new SubmissionReportRepository(),
    submissionRepository,
    trackRepository,
    spaceRepository,
    testCaseRepository,
    spaceService,
    storage.tests,
    now
  );
  const judgeResultService = new JudgeResultService(
    prisma,
    submissionRepository,
    testCaseRepository,
    judge.config.callbackKeys,
    generateService,
    verificationService,
    aiTestService,
    now
  );

  const authController = new AuthController(authService, auth, oauthProviders);
  const problemController = new ProblemController(problemService, imageService, statementService);
  const versionController = new VersionController(verificationService, versionService);
  const testCaseController = new TestCaseController(
    testCaseService,
    problemService,
    generateService
  );
  const solutionController = new SolutionController(solutionService);
  const assetController = new AssetController(imageService);
  const submissionController = new SubmissionController(
    submissionService,
    tuning?.streamIntervalMs
  );
  const submissionReviewController = new SubmissionReviewController(submissionReviewService);
  const judgeResultController = new JudgeResultController(judgeResultService);
  const userController = new UserController(userService, legalService);
  const legalController = new LegalController(userService, legalService);
  const aiCredentialController = new AiCredentialController(aiCredentialService);
  const aiTestController = new AiTestController(aiTestService);
  const spaceController = new SpaceController(spaceService, memberService, inviteService);
  const inviteController = new InviteController(inviteService);
  const trackController = new TrackController(
    trackService,
    collectionService,
    trackMemberService,
    inviteService,
    progressService
  );
  const collectionController = new CollectionController(collectionService);

  // Judge's result callback. Not part of the browser API: no cookies, no CSRF
  // check, no session. The body stays raw bytes because the HMAC signature
  // covers them exactly as sent (contracts/HMAC.md).
  app.register(async (internal) => {
    internal.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: 24 * 1024 * 1024 },
      (_request, body, done) => done(null, body)
    );
    internal.post(
      '/internal/judge/result',
      judgeResultController.result.bind(judgeResultController)
    );
  });

  // One plugin scope so cookie parsing is loaded before the session hook runs,
  // and the rate limits apply to the API only (not /health or /ready).
  app.register(async (scope) => {
    await scope.register(cookie, { secret: auth.sessionSecret });
    // Test uploads are two files of at most max_file_bytes each, plus a few fields.
    await scope.register(multipart, {
      limits: { fileSize: TEST_LIMITS.max_file_bytes, files: 4, fields: 8, parts: 12 },
    });
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

      // GRD-122: after the Terms or the Privacy Policy change, a signed-in
      // user can do nothing but read /me, accept, or log out until they accept.
      if (
        request.currentUser &&
        !isLegalExempt(request) &&
        !(await legalService.hasAcceptedCurrent(request.currentUser.id))
      ) {
        throw new LegalAcceptanceRequiredError();
      }
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

        // Changing the profile is rare: 10 changes a minute per person is plenty (GRD-68).
        const checkProfileLimit = scope.createRateLimit({
          max: PROFILE_UPDATES_PER_MINUTE,
          timeWindow: '1 minute',
          keyGenerator: (request) => `profile:${request.currentUser?.id ?? request.ip}`,
        });
        const profileLimit = async (request: FastifyRequest) => {
          const limit = await checkProfileLimit(request);
          if (!limit.isAllowed && limit.isExceeded) {
            throw new VError({
              message: `Too many changes. Try again in ${Math.ceil(limit.ttlInSeconds)} seconds.`,
              status: 429,
              error_code: 'RATE_LIMITED',
            });
          }
        };
        v1.get('/me', userController.me.bind(userController));
        v1.post('/me/legal-acceptance', legalController.accept.bind(legalController));
        v1.patch('/me', { preHandler: profileLimit }, userController.updateMe.bind(userController));
        v1.get('/me/ai-credentials', aiCredentialController.list.bind(aiCredentialController));
        v1.put(
          '/me/ai-credentials/:provider',
          { preHandler: profileLimit },
          aiCredentialController.save.bind(aiCredentialController)
        );
        v1.delete(
          '/me/ai-credentials/:provider',
          { preHandler: profileLimit },
          aiCredentialController.remove.bind(aiCredentialController)
        );
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

        // --- problems (M3) ---------------------------------------------------
        v1.get('/problem-constraints', problemController.constraints.bind(problemController));
        // Pasting and uploading many testcases at once is normal; this only stops a runaway script.
        const stageLimit = { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } };
        const problems = '/spaces/:slug/problems';
        const problem = `${problems}/:problemSlug`;
        v1.get(problems, problemController.list.bind(problemController));
        v1.post(problems, problemController.create.bind(problemController));
        v1.get(problem, problemController.get.bind(problemController));
        v1.patch(problem, problemController.update.bind(problemController));
        v1.delete(problem, problemController.remove.bind(problemController));
        v1.get(`${problem}/editor`, problemController.editor.bind(problemController));
        v1.post(`${problem}/publish`, problemController.publish.bind(problemController));
        v1.post(`${problem}/archive`, problemController.archive.bind(problemController));
        // Publish gate and versions (GRD-50 to GRD-54, GRD-116, GRD-117).
        v1.post(`${problem}/verify`, versionController.verify.bind(versionController));
        v1.get(`${problem}/verify`, versionController.getVerification.bind(versionController));
        v1.post(`${problem}/updates`, versionController.update.bind(versionController));
        v1.post(`${problem}/draft`, versionController.createDraft.bind(versionController));
        v1.delete(`${problem}/draft`, versionController.discardDraft.bind(versionController));
        v1.get(`${problem}/history`, versionController.history.bind(versionController));
        v1.post(`${problem}/images`, problemController.uploadImage.bind(problemController));
        v1.get('/assets/:name', assetController.get.bind(assetController));
        v1.put(
          `${problem}/statement/pdf`,
          problemController.uploadStatementPdf.bind(problemController)
        );
        v1.get(`${problem}/statement/pdf`, problemController.statementPdf.bind(problemController));

        v1.get(`${problem}/tests`, testCaseController.list.bind(testCaseController));
        v1.put(`${problem}/tests`, testCaseController.batchSave.bind(testCaseController));
        v1.post(
          `${problem}/tests/files`,
          stageLimit,
          testCaseController.stageFile.bind(testCaseController)
        );
        v1.get(
          `${problem}/tests/:testId/files/:side`,
          testCaseController.slice.bind(testCaseController)
        );
        v1.post(`${problem}/generate`, testCaseController.generate.bind(testCaseController));
        v1.get(
          `${problem}/generate/:jobId`,
          testCaseController.generateStatus.bind(testCaseController)
        );
        v1.post(
          `${problem}/generate/:jobId/stop`,
          testCaseController.generateStop.bind(testCaseController)
        );
        // Starting a draft costs the author's own provider quota: limited per person.
        const checkAiStartLimit = scope.createRateLimit({
          max: AI_TEST_LIMITS.starts_per_minute,
          timeWindow: '1 minute',
          keyGenerator: (request) => `ai-tests:${request.currentUser?.id ?? request.ip}`,
        });
        const aiStartLimit = async (request: FastifyRequest) => {
          const limit = await checkAiStartLimit(request);
          if (!limit.isAllowed && limit.isExceeded) {
            throw new VError({
              message: `Too many requests. Try again in ${Math.ceil(limit.ttlInSeconds)} seconds.`,
              status: 429,
              error_code: 'RATE_LIMITED',
            });
          }
        };
        v1.post(
          `${problem}/ai-tests`,
          { preHandler: aiStartLimit },
          aiTestController.start.bind(aiTestController)
        );
        v1.get(`${problem}/ai-tests/:jobId`, aiTestController.status.bind(aiTestController));
        v1.post(`${problem}/tests`, testCaseController.create.bind(testCaseController));
        v1.post(`${problem}/tests/reorder`, testCaseController.reorder.bind(testCaseController));
        v1.put(`${problem}/tests/:testId`, testCaseController.replace.bind(testCaseController));
        v1.patch(`${problem}/tests/:testId`, testCaseController.update.bind(testCaseController));
        v1.delete(`${problem}/tests/:testId`, testCaseController.remove.bind(testCaseController));
        v1.get(`${problem}/tests/:testId/input`, (request, reply) =>
          testCaseController.download(request, reply, 'input')
        );
        v1.get(`${problem}/tests/:testId/output`, (request, reply) =>
          testCaseController.download(request, reply, 'output')
        );

        v1.get(`${problem}/solutions`, solutionController.list.bind(solutionController));
        v1.post(`${problem}/solutions`, solutionController.create.bind(solutionController));
        v1.patch(
          `${problem}/solutions/:solutionId`,
          solutionController.update.bind(solutionController)
        );
        v1.delete(
          `${problem}/solutions/:solutionId`,
          solutionController.remove.bind(solutionController)
        );

        // --- tracks and collections (M3) ---------------------------------------
        const tracks = '/spaces/:slug/tracks';
        const track = `${tracks}/:trackSlug`;
        v1.get(tracks, trackController.list.bind(trackController));
        v1.post(tracks, trackController.create.bind(trackController));
        v1.post(`${tracks}/reorder`, trackController.reorder.bind(trackController));
        v1.get(track, trackController.get.bind(trackController));
        v1.patch(track, trackController.update.bind(trackController));
        v1.post(`${track}/archive`, trackController.archive.bind(trackController));
        v1.post(`${track}/restore`, trackController.restore.bind(trackController));
        v1.post(`${track}/collections`, trackController.addCollections.bind(trackController));
        v1.post(
          `${track}/collections/remove`,
          trackController.removeCollections.bind(trackController)
        );
        v1.post(
          `${track}/collections/reorder`,
          trackController.reorderCollections.bind(trackController)
        );
        v1.get(`${track}/members`, trackController.listMembers.bind(trackController));
        v1.delete(`${track}/members/:username`, trackController.removeMember.bind(trackController));
        v1.get(`${track}/invites`, trackController.listInvites.bind(trackController));
        v1.post(`${track}/invites`, trackController.createInvite.bind(trackController));
        v1.delete(`${track}/invites/:inviteId`, trackController.revokeInvite.bind(trackController));
        v1.get(`${track}/progress`, trackController.progress.bind(trackController));
        v1.get(`${track}/progress/members`, trackController.memberProgress.bind(trackController));

        const collections = '/spaces/:slug/collections';
        const collection = `${collections}/:collectionSlug`;
        v1.get(collections, collectionController.list.bind(collectionController));
        v1.post(collections, collectionController.create.bind(collectionController));
        v1.get(collection, collectionController.get.bind(collectionController));
        v1.patch(collection, collectionController.update.bind(collectionController));
        v1.post(`${collection}/archive`, collectionController.archive.bind(collectionController));
        v1.post(`${collection}/restore`, collectionController.restore.bind(collectionController));
        v1.post(
          `${collection}/problems`,
          collectionController.addProblems.bind(collectionController)
        );
        v1.post(
          `${collection}/problems/remove`,
          collectionController.removeProblems.bind(collectionController)
        );
        v1.post(
          `${collection}/problems/reorder`,
          collectionController.reorderProblems.bind(collectionController)
        );

        // --- submissions (M3) -------------------------------------------------
        // Submitting and re-checking share one per-user budget (GRD-44; GRD-55 tunes it).
        const checkSubmitLimit = scope.createRateLimit({
          max: SUBMISSIONS_PER_MINUTE,
          timeWindow: '1 minute',
          keyGenerator: (request) => `submit:${request.currentUser?.id ?? request.ip}`,
        });
        const submitLimit = async (request: FastifyRequest) => {
          const limit = await checkSubmitLimit(request);
          if (!limit.isAllowed && limit.isExceeded) {
            throw new VError({
              message: `Too many submissions. Try again in ${Math.ceil(limit.ttlInSeconds)} seconds.`,
              status: 429,
              error_code: 'RATE_LIMITED',
            });
          }
        };
        v1.post(
          `${problem}/submissions`,
          { preHandler: submitLimit },
          submissionController.create.bind(submissionController)
        );
        v1.get(`${problem}/submissions`, submissionController.list.bind(submissionController));
        // Space-wide submissions for owners, administrators, editors and observers (GRD-93).
        const spaceSubmissions = '/spaces/:slug/submissions';
        v1.get(spaceSubmissions, submissionReviewController.rows.bind(submissionReviewController));
        v1.get(
          `${spaceSubmissions}/versions`,
          submissionReviewController.versions.bind(submissionReviewController)
        );
        v1.get(
          `${spaceSubmissions}/by-member`,
          submissionReviewController.byMember.bind(submissionReviewController)
        );
        v1.get(
          `${spaceSubmissions}/by-member/:username/problems`,
          submissionReviewController.memberProblems.bind(submissionReviewController)
        );
        v1.get(
          `${spaceSubmissions}/by-track`,
          submissionReviewController.byTrack.bind(submissionReviewController)
        );
        v1.get(
          `${spaceSubmissions}/by-track/:trackSlug/problems`,
          submissionReviewController.trackProblems.bind(submissionReviewController)
        );
        v1.get(
          `${spaceSubmissions}/by-problem`,
          submissionReviewController.byProblem.bind(submissionReviewController)
        );
        v1.get('/submissions/:submissionId', submissionController.get.bind(submissionController));
        v1.get(
          '/submissions/:submissionId/tests/:position',
          submissionReviewController.testDetail.bind(submissionReviewController)
        );
        v1.get(
          '/submissions/:submissionId/events',
          submissionController.events.bind(submissionController)
        );
        v1.post(
          '/submissions/:submissionId/rejudge',
          { preHandler: submitLimit },
          submissionController.rejudge.bind(submissionController)
        );

        v1.get('/invites/:token', inviteController.preview.bind(inviteController));
        v1.post('/invites/:token/accept', inviteController.acceptByToken.bind(inviteController));
        v1.post('/invites/:token/decline', inviteController.declineByToken.bind(inviteController));
      },
      { prefix: '/api/v1' }
    );
  });
}
