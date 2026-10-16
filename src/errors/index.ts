/** One error detail per invalid field. */
export interface ErrorDetail {
  field: string;
  message: string;
}

/**
 * Base class for every expected error. Rendered as the contract's
 * ErrorResponse: { status, error_code, message, request_id, details? }.
 */
class VError extends Error {
  status: number;
  error_code: string;
  details?: ErrorDetail[];
  /** Sent as the Retry-After header (429 and 503 answers that say when to come back). */
  retryAfterSeconds?: number;

  constructor({
    message,
    status,
    error_code,
    details,
  }: {
    message: string;
    status: number;
    error_code: string;
    details?: ErrorDetail[];
  }) {
    super(message);
    this.status = status;
    this.error_code = error_code;
    this.details = details;
  }

  toJSON(requestId: string) {
    return {
      status: this.status,
      error_code: this.error_code,
      message: this.message,
      request_id: requestId,
      ...(this.details && this.details.length > 0 ? { details: this.details } : {}),
    };
  }
}

class BadRequestError extends VError {
  constructor(message = 'Bad request', details?: ErrorDetail[]) {
    super({ message, status: 400, error_code: 'BAD_REQUEST', details });
  }
}

class ValidationError extends VError {
  constructor(details: ErrorDetail[]) {
    super({
      message: 'The request is invalid.',
      status: 400,
      error_code: 'VALIDATION_FAILED',
      details,
    });
  }
}

class UnauthorizedError extends VError {
  constructor(message = 'Unauthorized') {
    super({ message, status: 401, error_code: 'UNAUTHORIZED' });
  }
}

class ForbiddenError extends VError {
  constructor(message = 'Forbidden') {
    super({ message, status: 403, error_code: 'FORBIDDEN' });
  }
}

class NotFoundError extends VError {
  constructor(message = 'Not found') {
    super({ message, status: 404, error_code: 'NOT_FOUND' });
  }
}

class ConflictError extends VError {
  /** `errorCode` lets the web app tell kinds of conflict apart, e.g. VERSION_PUBLISHED. */
  constructor(message = 'Conflict', errorCode = 'CONFLICT', details?: ErrorDetail[]) {
    super({ message, status: 409, error_code: errorCode, details });
  }
}

/** 403 that says why: the platform administrators stopped this account, Space or kind of action. */
class SuspendedError extends VError {
  constructor(
    message: string,
    errorCode: 'ACCOUNT_SUSPENDED' | 'SPACE_SUSPENDED' | 'SUBMISSIONS_SUSPENDED'
  ) {
    super({ message, status: 403, error_code: errorCode });
  }
}

/** 429: over a limit. Says in the message and in Retry-After when to try again. */
class RateLimitedError extends VError {
  constructor(
    retryAfterSeconds: number,
    message = `Too many requests. Try again in ${Math.max(1, Math.ceil(retryAfterSeconds))} seconds.`,
    errorCode = 'RATE_LIMITED'
  ) {
    super({ message, status: 429, error_code: errorCode });
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

class GoneError extends VError {
  constructor(message = 'Gone') {
    super({ message, status: 410, error_code: 'GONE' });
  }
}

class ServiceUnavailableError extends VError {
  constructor(message = 'The service is temporarily unavailable. Try again in a moment.') {
    super({ message, status: 503, error_code: 'UNAVAILABLE' });
  }
}

class InternalServerError extends VError {
  constructor(message = 'Internal server error.') {
    super({ message, status: 500, error_code: 'INTERNAL_ERROR' });
  }
}

export {
  VError,
  BadRequestError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  GoneError,
  RateLimitedError,
  ServiceUnavailableError,
  SuspendedError,
  InternalServerError,
};
