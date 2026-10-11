import fastify, { FastifyError } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { InternalServerError, NotFoundError, VError, ValidationError } from '@/errors';
import TLogger, { Layer } from '@/logging/logger';
import SystemController from '@/controllers/system/system.controller';
import SystemService, { ReadinessCheck } from '@/services/system/system.service';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export interface AppDependencies {
  version: string;
  readinessChecks: ReadinessCheck[];
}

/**
 * Builds the HTTP app. Dependencies are wired by hand here
 * (repository -> service -> controller), as in the other services.
 */
export function buildApp({ version, readinessChecks }: AppDependencies) {
  const logger = new TLogger(Layer.CONTROLLER);

  // The caller's X-Request-Id is reused when well-formed (Frontend or Judge
  // can then correlate), otherwise a UUID is generated. It is the
  // request_id on every log line and every error body.
  const app = fastify({
    logger: false,
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

  return app;
}
