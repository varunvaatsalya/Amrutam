const crypto = require('crypto');

// only delete the lock if we still own it (it may have expired and been taken by someone else)
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

// Short-lived lock used to fail fast when two people hit the same slot.
// It's not the source of truth - the row lock + unique index in postgres is.
function createLocker(redis) {
  async function acquire(key, ttlMs) {
    const token = crypto.randomUUID();
    const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? token : null;
  }

  async function release(key, token) {
    await redis.eval(RELEASE, 1, key, token).catch(() => {});
  }

  return { acquire, release };
}

module.exports = { createLocker };
