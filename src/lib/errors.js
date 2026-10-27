class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (msg, details) => new AppError(400, 'BAD_REQUEST', msg, details);
const unauthorized = (msg = 'Unauthorized', details) => new AppError(401, 'UNAUTHORIZED', msg, details);
const forbidden = (msg = 'Forbidden') => new AppError(403, 'FORBIDDEN', msg);
const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
const conflict = (msg, code = 'CONFLICT') => new AppError(409, code, msg);
const tooMany = (msg = 'Too many requests') => new AppError(429, 'RATE_LIMITED', msg);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, tooMany };
