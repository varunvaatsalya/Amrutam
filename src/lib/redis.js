const Redis = require('ioredis');

function createRedis(url, logger) {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 2,
    // exponential backoff capped at 2s
    retryStrategy: (times) => Math.min(2 ** times * 50, 2000),
  });
  redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
  return redis;
}

module.exports = { createRedis };
