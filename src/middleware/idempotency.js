const { sha256 } = require('../lib/crypto');
const { AppError, badRequest } = require('../lib/errors');

const TTL_SEC = 24 * 3600;
// while the first request is running the key holds this marker. short ttl so a
// crashed process doesn't block the key for a whole day
const IN_FLIGHT_TTL_SEC = 60;

// Idempotency-Key handling for unsafe writes (Stripe style):
//  - first request with a key runs, its response is stored for 24h
//  - same key + same body => stored response is replayed
//  - same key + different body => 422
//  - same key while first one is still running => 409
// Keys are scoped per user so one client can't replay another's response.
// Redis down => 503. We'd rather refuse a booking than risk charging twice.
function idempotency(redis, { required = true } = {}) {
  return async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key) {
      return required ? next(badRequest('Idempotency-Key header is required for this endpoint')) : next();
    }
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) return next(badRequest('Idempotency-Key must be 8-100 chars [A-Za-z0-9_-]'));

    const redisKey = `idem:${req.user?.id || 'anon'}:${key}`;
    const fingerprint = sha256(`${req.method} ${req.baseUrl}${req.path} ${JSON.stringify(req.body ?? {})}`);

    let claimed;
    try {
      claimed = await redis.set(redisKey, JSON.stringify({ state: 'processing', fingerprint }), 'EX', IN_FLIGHT_TTL_SEC, 'NX');
    } catch {
      return next(new AppError(503, 'IDEMPOTENCY_UNAVAILABLE', 'Cannot process writes right now, retry shortly'));
    }

    if (!claimed) {
      const saved = JSON.parse((await redis.get(redisKey).catch(() => null)) || 'null');
      if (!saved) return next(new AppError(409, 'REQUEST_IN_PROGRESS', 'Retry in a moment'));
      if (saved.fingerprint !== fingerprint) {
        return next(new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request'));
      }
      if (saved.state === 'processing') {
        return next(new AppError(409, 'REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed'));
      }
      res.setHeader('Idempotent-Replayed', 'true');
      return res.status(saved.status).json(saved.body);
    }

    // capture whatever the handler sends back
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      if (status >= 500) {
        // server side failure - let the client retry with the same key
        redis.del(redisKey).catch(() => {});
      } else {
        redis.set(redisKey, JSON.stringify({ state: 'done', fingerprint, status, body }), 'EX', TTL_SEC).catch(() => {});
      }
      return originalJson(body);
    };
    next();
  };
}

module.exports = { idempotency };
