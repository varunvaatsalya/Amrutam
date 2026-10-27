// Tiny forward-only migration runner. Each file in /migrations runs once,
// inside its own transaction, in filename order.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const dir = path.join(__dirname, '..', 'migrations');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const { rows } = await client.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    process.stdout.write(`applying ${file} ... `);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('ok');
    } catch (err) {
      await client.query('ROLLBACK');
      console.log('failed');
      throw err;
    }
  }

  await client.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
