const { Pool, types } = require('pg');
const { dbDuration, trackDbPool } = require('./metrics');

// DATE columns stay 'YYYY-MM-DD' - turning them into JS Dates shifts them by the server tz
types.setTypeParser(types.builtins.DATE, (v) => v);

const SLOW_QUERY_MS = 200;

function createDb({ url, poolMax }, logger) {
  const pool = new Pool({
    connectionString: url,
    max: poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });

  pool.on('error', (err) => logger.error({ err }, 'pg pool error'));
  trackDbPool(pool);

  async function query(text, params) {
    const start = process.hrtime.bigint();
    try {
      return await pool.query(text, params);
    } finally {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      dbDuration.observe(ms / 1000);
      if (ms > SLOW_QUERY_MS) logger.warn({ ms: Math.round(ms), sql: text.replace(/\s+/g, ' ').slice(0, 200) }, 'slow query');
    }
  }

  // runs fn inside BEGIN/COMMIT, rolls back on any throw
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return { pool, query, tx, close: () => pool.end() };
}

module.exports = { createDb };
