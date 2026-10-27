const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { requestContext } = require('./middleware/requestContext');
const { authenticate, requireMfa } = require('./middleware/auth');
const { rateLimit } = require('./middleware/rateLimit');
const { idempotency } = require('./middleware/idempotency');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const metrics = require('./lib/metrics');
const { auditContext } = require('./modules/audit/audit.service');
const { authRoutes } = require('./modules/auth/auth.routes');
const { usersRoutes } = require('./modules/users/users.routes');
const { doctorsRoutes } = require('./modules/doctors/doctors.routes');
const { bookingsRoutes } = require('./modules/bookings/bookings.routes');
const { paymentsRoutes } = require('./modules/payments/payments.routes');
const { consultationsRoutes, prescriptionsRoutes } = require('./modules/consultations/consultations.routes');
const { adminRoutes } = require('./modules/admin/admin.routes');

function createApp(c) {
  const app = express();
  const { config, logger, redis, db } = c;

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  // keep the raw bytes around, webhook signatures are computed over them
  app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { req.rawBody = buf; } }));
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

  app.get('/openapi.yaml', (req, res) => res.sendFile(path.join(__dirname, '..', 'docs', 'openapi.yaml')));

  // scraped by prometheus. lives outside /api so it skips auth + rate limiting;
  // in k8s it's only reachable inside the cluster, METRICS_TOKEN adds a guard elsewhere
  app.get('/metrics', async (req, res) => {
    if (config.metricsToken && req.get('authorization') !== `Bearer ${config.metricsToken}`) {
      return res.status(401).end();
    }
    res.setHeader('content-type', metrics.register.contentType);
    res.send(await metrics.register.metrics());
  });

  const deps = {
    ...c,
    authenticate: authenticate(config),
    requireMfa: requireMfa(config),
    idempotent: idempotency(redis),
    // tighter limit on credential endpoints, always keyed by IP
    strictLimiter: rateLimit(redis, logger, { name: 'auth', windowSec: 60, max: config.rateLimit.authMax, keyBy: (req) => req.ip }),
  };

  const api = express.Router();
  api.use(rateLimit(redis, logger, { name: 'api', windowSec: config.rateLimit.windowSec, max: config.rateLimit.max }));
  api.use('/auth', authRoutes(deps));
  api.use('/users', usersRoutes(deps));
  api.use('/doctors', doctorsRoutes(deps));
  api.use('/bookings', bookingsRoutes(deps));
  api.use('/payments', paymentsRoutes(deps));
  api.use('/consultations', consultationsRoutes(deps));
  api.use('/prescriptions', prescriptionsRoutes(deps));
  api.use('/admin', adminRoutes(deps));

  app.use('/api/v1', api);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
