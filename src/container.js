// Composition root. Everything is wired here by hand - small enough that a DI
// library would be more ceremony than help. Tests build their own container
// with overrides (see tests/helpers.js).
const config = require('./config');
const logger = require('./lib/logger');
const { createDb } = require('./lib/db');
const { createRedis } = require('./lib/redis');
const { createCipher } = require('./lib/crypto');
const { createAuditService } = require('./modules/audit/audit.service');
const { createAuthRepo } = require('./modules/auth/auth.repo');
const { createAuthService } = require('./modules/auth/auth.service');

function createContainer(overrides = {}) {
  const c = { config, logger, ...overrides };

  c.db = c.db || createDb(config.db, logger);
  c.redis = c.redis || createRedis(config.redisUrl, logger);
  c.cipher = c.cipher || createCipher(config.encryption);

  c.auditService = createAuditService(c);

  c.authRepo = createAuthRepo(c.db);
  c.authService = createAuthService(c);

  c.close = async () => {
    await Promise.allSettled([c.db.close(), c.redis.quit()]);
  };

  return c;
}

module.exports = { createContainer };
