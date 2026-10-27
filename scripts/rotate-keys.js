// Re-encrypts every PHI/PII column still on an old key with ENCRYPTION_ACTIVE_KEY.
// Rotation runbook (docs/security.md):
//   1. add new key to ENCRYPTION_KEYS, point ENCRYPTION_ACTIVE_KEY at it, deploy
//   2. run this script (safe to re-run, works in batches)
//   3. once it reports 0 remaining, drop the old key from ENCRYPTION_KEYS and deploy
const config = require('../src/config');
const logger = require('../src/lib/logger');
const { createDb } = require('../src/lib/db');
const { createCipher } = require('../src/lib/crypto');

const TARGETS = [
  { table: 'users', key: ['id'], cols: ['mfa_secret_enc'] },
  { table: 'profiles', key: ['user_id'], cols: ['phone_enc'] },
  { table: 'consultations', key: ['id', 'scheduled_at'], cols: ['reason_enc', 'doctor_notes_enc'] },
  { table: 'prescriptions', key: ['id'], cols: ['medications_enc', 'advice_enc'] },
];
const BATCH = 500;

async function main() {
  const db = createDb(config.db, logger);
  const cipher = createCipher(config.encryption);
  const prefix = `${config.encryption.activeKey}.%`;

  for (const t of TARGETS) {
    const stale = t.cols.map((c) => `(${c} IS NOT NULL AND ${c} NOT LIKE $1)`).join(' OR ');
    let total = 0;
    for (;;) {
      const { rows } = await db.query(
        `SELECT ${[...t.key, ...t.cols].join(', ')} FROM ${t.table} WHERE ${stale} LIMIT ${BATCH}`,
        [prefix],
      );
      if (!rows.length) break;

      await db.tx(async (client) => {
        for (const row of rows) {
          const sets = t.cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
          const where = t.key.map((k, i) => `${k} = $${t.cols.length + i + 1}`).join(' AND ');
          const values = t.cols.map((c) => (row[c] && cipher.needsRotation(row[c]) ? cipher.encrypt(cipher.decrypt(row[c])) : row[c]));
          await client.query(`UPDATE ${t.table} SET ${sets} WHERE ${where}`, [...values, ...t.key.map((k) => row[k])]);
        }
      });
      total += rows.length;
    }
    console.log(`${t.table}: re-encrypted ${total} rows`);
  }
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
