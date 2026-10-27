const { Pool } = require('pg');

function createDb({ url, poolMax }, logger) {
  const pool = new Pool({
    connectionString: url,
    max: poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });

  pool.on('error', (err) => logger.error({ err }, 'pg pool error'));

  async function query(text, params) {
    return pool.query(text, params);
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
