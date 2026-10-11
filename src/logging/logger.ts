import { logger } from '@/libs/winston';

export enum Layer {
  CONTROLLER = 'controller',
  SERVICE = 'service',
  REPOSITORY = 'repository',
  MIDDLEWARE = 'middleware',
  PROVIDER = 'provider',
  OTHER = 'other',
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
      error:
        meta.error instanceof Error
          ? { message: meta.error.message, stack: meta.error.stack }
          : meta.error,
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
