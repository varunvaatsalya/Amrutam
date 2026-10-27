// Read-through cache on redis. Cache is an optimisation, never a dependency:
// any redis error falls back to the loader.
function createCache(redis, logger) {
  async function getOrSet(key, ttlSec, loader) {
    try {
      const hit = await redis.get(key);
      if (hit !== null) return JSON.parse(hit);
    } catch (err) {
      logger.warn({ err: err.message, key }, 'cache read failed');
    }

    const value = await loader();
    if (value !== undefined && value !== null) {
      redis.set(key, JSON.stringify(value), 'EX', ttlSec).catch(() => {});
    }
    return value;
  }

  const del = (...keys) => redis.del(...keys).catch(() => {});

  // version counters let us invalidate a whole family of keys (e.g. every
  // slot listing of one doctor) with a single INCR instead of SCAN+DEL
  async function version(name) {
    try {
      return (await redis.get(`ver:${name}`)) || '0';
    } catch {
      return 'x';
    }
  }
  const bump = (name) => redis.incr(`ver:${name}`).catch(() => {});

  return { getOrSet, del, version, bump };
}

module.exports = { createCache };
