import { logger } from '@/libs/winston';

export enum Layer {
  CONTROLLER = 'controller',
  SERVICE = 'service',
  REPOSITORY = 'repository',
  MIDDLEWARE = 'middleware',
  PROVIDER = 'provider',
  OTHER = 'other',
}

/** What is worth keeping of a thrown value: Prisma and Node errors carry `code`, `meta` and `cause`. */
function describeError(error: Error | string): unknown {
  if (!(error instanceof Error)) return error;
  const detail = error as Error & { code?: unknown; meta?: unknown; cause?: unknown };
  return {
    name: error.name,
    message: error.message,
    code: detail.code,
    meta: detail.meta,
    cause: detail.cause instanceof Error ? describeError(detail.cause) : detail.cause,
    stack: error.stack,
  };
}

interface LogMeta {
  message: string;
  data?: Record<string, unknown>;
  error?: Error | string;
}

/**
 * Structured logger, one per class. setContext() never mutates: it returns
 * a new TLogger, so concurrent requests cannot overwrite each other's
 * request id. Always use the returned value:
 *
 *   const logger = this.logger.setContext('service.user.create', requestId);
 *   logger.info({ message: 'user created', data: { userId } });
 *
 * Never log passwords, tokens, secrets or hidden test content.
 */
export default class TLogger {
  constructor(
    private readonly layer: Layer,
    private readonly context = '',
    private readonly requestId = ''
  ) {}

  setContext(context: string, requestId?: string): TLogger {
    return new TLogger(this.layer, context, requestId ?? this.requestId);
  }

  private payload(meta: LogMeta) {
    return {
      layer: this.layer,
      context: this.context,
      request_id: this.requestId || undefined,
      data: meta.data,
      error: meta.error === undefined ? undefined : describeError(meta.error),
    };
  }

  info(meta: LogMeta) {
    logger.info(meta.message, this.payload(meta));
  }

  warn(meta: LogMeta) {
    logger.warn(meta.message, this.payload(meta));
  }

  error(meta: LogMeta) {
    logger.error(meta.message, this.payload(meta));
  }

  debug(meta: LogMeta) {
    logger.debug(meta.message, this.payload(meta));
  }
}
