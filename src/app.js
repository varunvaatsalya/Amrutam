const express = require('express');
const helmet = require('helmet');
const { requestContext } = require('./middleware/requestContext');
const { authenticate } = require('./middleware/auth');
const { rateLimit } = require('./middleware/rateLimit');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { auditContext } = require('./modules/audit/audit.service');
const { authRoutes } = require('./modules/auth/auth.routes');

function createApp(c) {
  const app = express();
  const { config, logger, redis, db } = c;

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  app.use(requestContext(logger));
  app.use(auditContext);

  // liveness - process is up
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // readiness - dependencies reachable, used by the load balancer / k8s
  app.get('/ready', async (req, res) => {
    const checks = await Promise.allSettled([db.query('SELECT 1'), redis.ping()]);
    const [pg, rd] = checks.map((x) => x.status === 'fulfilled');
    res.status(pg && rd ? 200 : 503).json({ postgres: pg, redis: rd });
  });

  const auth = authenticate(config);
  const apiLimiter = rateLimit(redis, logger, { name: 'api', ...config.rateLimit });
  // tighter limit on credential endpoints, always keyed by IP
  const strictLimiter = rateLimit(redis, logger, { name: 'auth', windowSec: 60, max: 10, keyBy: (req) => req.ip });

  const api = express.Router();
  api.use(apiLimiter);
  api.use('/auth', authRoutes({ authService: c.authService, authenticate: auth, strictLimiter }));

  app.use('/api/v1', api);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
