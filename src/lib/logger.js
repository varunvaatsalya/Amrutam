const pino = require('pino');
const config = require('../config');
const context = require('./context');

const logger = pino({
  level: config.logLevel,
  base: { service: process.env.SERVICE_NAME || 'amrutam-api' },
  // every log line inside a request/job carries its trace id
  mixin() {
    const { traceId } = context.current();
    return traceId ? { traceId } : {};
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.refreshToken',
      '*.mfaCode',
    ],
    censor: '[redacted]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
