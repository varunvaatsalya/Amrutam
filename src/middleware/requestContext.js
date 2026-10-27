const crypto = require('crypto');

// assigns a request id (or trusts the one from the gateway) and logs one line per request
function requestContext(logger) {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && incoming.length <= 64 ? incoming : crypto.randomUUID();
    req.log = logger.child({ reqId: req.id });
    res.setHeader('x-request-id', req.id);

    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      req.log[level]({
        method: req.method,
        path: req.route ? req.baseUrl + req.route.path : req.path,
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
        userId: req.user?.id,
      }, 'request');
    });
    next();
  };
}

module.exports = { requestContext };
