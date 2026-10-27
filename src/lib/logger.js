const pino = require('pino');
const config = require('../config');

const logger = pino({
  level: config.logLevel,
  base: { service: 'amrutam-api' },
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
