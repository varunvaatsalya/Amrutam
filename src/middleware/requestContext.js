const crypto = require('crypto');
const context = require('../lib/context');
const { httpDuration } = require('../lib/metrics');

// assigns request id + trace id, logs one line per request and records latency
function requestContext(logger) {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && incoming.length <= 64 ? incoming : crypto.randomUUID();
    const traceId = context.parseTraceparent(req.get('traceparent')) || context.newTraceId();
    req.log = logger.child({ reqId: req.id });
    res.setHeader('x-request-id', req.id);
    res.setHeader('traceparent', `00-${traceId}-${context.newSpanId()}-01`);

    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const sec = Number(process.hrtime.bigint() - start) / 1e9;
      // route template, not the raw path, keeps label cardinality bounded
      const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
      httpDuration.observe({ method: req.method, route, status: res.statusCode }, sec);

      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      req.log[level]({
        method: req.method,
        route,
        status: res.statusCode,
        ms: Math.round(sec * 10000) / 10,
        userId: req.user?.id,
      }, 'request');
    });

    context.run({ traceId, reqId: req.id }, next);
  };
}

module.exports = { requestContext };
