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
  constructor(message = 'Conflict') {
    super({ message, status: 409, error_code: 'CONFLICT' });
  }
}

class GoneError extends VError {
  constructor(message = 'Gone') {
    super({ message, status: 410, error_code: 'GONE' });
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
  InternalServerError,
};
