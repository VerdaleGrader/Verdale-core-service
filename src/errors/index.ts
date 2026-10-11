/** One error detail per invalid field. */
export interface ErrorDetail {
  field: string;
  message: string;
}

/**
 * Base class for every expected error. Rendered as the contract's
 * ErrorResponse: { status, error_code, message, request_id, details? }.
 */
class TError extends Error {
  status: number;
  error_code: string;
  details?: ErrorDetail[];

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

class BadRequestError extends TError {
  constructor(message = 'Bad request', details?: ErrorDetail[]) {
    super({ message, status: 400, error_code: 'BAD_REQUEST', details });
  }
}

class ValidationError extends TError {
  constructor(details: ErrorDetail[]) {
    super({
      message: 'The request is invalid.',
      status: 400,
      error_code: 'VALIDATION_FAILED',
      details,
    });
  }
}

class UnauthorizedError extends TError {
  constructor(message = 'Unauthorized') {
    super({ message, status: 401, error_code: 'UNAUTHORIZED' });
  }
}

class ForbiddenError extends TError {
  constructor(message = 'Forbidden') {
    super({ message, status: 403, error_code: 'FORBIDDEN' });
  }
}

class NotFoundError extends TError {
  constructor(message = 'Not found') {
    super({ message, status: 404, error_code: 'NOT_FOUND' });
  }
}

class ConflictError extends TError {
  constructor(message = 'Conflict') {
    super({ message, status: 409, error_code: 'CONFLICT' });
  }
}

class InternalServerError extends TError {
  constructor(message = 'Internal server error.') {
    super({ message, status: 500, error_code: 'INTERNAL_ERROR' });
  }
}

export {
  TError,
  BadRequestError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InternalServerError,
};
