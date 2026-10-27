const { tooMany } = require('../lib/errors');

// Fixed window counter in redis. Keyed by user id when logged in, else IP.
// If redis is down we let the request through - better than taking the API down.
function rateLimit(redis, logger, { name, windowSec, max, keyBy }) {
  return async (req, res, next) => {
    const who = keyBy ? keyBy(req) : req.user?.id || req.ip;
    const window = Math.floor(Date.now() / 1000 / windowSec);
    const key = `rl:${name}:${who}:${window}`;

    let count;
    try {
      const [[, c]] = await redis.multi().incr(key).expire(key, windowSec).exec();
      count = c;
    } catch (err) {
      logger.warn({ err: err.message }, 'rate limiter unavailable, failing open');
      return next();
    }

    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', Math.max(0, max - count));
    if (count > max) {
      res.setHeader('Retry-After', windowSec - (Math.floor(Date.now() / 1000) % windowSec));
      return next(tooMany());
    }
    next();
  };
}

module.exports = { rateLimit };
