// Demo data: 1 admin (MFA on), 3 verified doctors with slots for the next 3 days, 1 patient.
// Safe to re-run - existing emails are skipped.
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const logger = require('../src/lib/logger');
const { createDb } = require('../src/lib/db');
const { createCipher } = require('../src/lib/crypto');
const totp = require('../src/lib/totp');

const PASSWORD = 'Password123';

const doctors = [
  { email: 'dr.sharma@amrutam.local', name: 'Dr. Anjali Sharma', spec: 'Ayurveda', langs: ['hindi', 'english'], fee: 500, exp: 12, city: 'Delhi', rating: 4.7 },
  { email: 'dr.iyer@amrutam.local', name: 'Dr. Ramesh Iyer', spec: 'Panchakarma', langs: ['tamil', 'english'], fee: 800, exp: 20, city: 'Chennai', rating: 4.9 },
  { email: 'dr.khan@amrutam.local', name: 'Dr. Sameer Khan', spec: 'Ayurveda', langs: ['hindi', 'urdu'], fee: 350, exp: 5, city: 'Lucknow', rating: 4.2 },
];

async function main() {
  const db = createDb(config.db, logger);
  const cipher = createCipher(config.encryption);
  const hash = await bcrypt.hash(PASSWORD, 11);

  async function user(client, email, role, fullName, city) {
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING RETURNING id`,
      [email, hash, role],
    );
    if (!rows[0]) return null;
    await client.query('INSERT INTO profiles (user_id, full_name, city) VALUES ($1, $2, $3)', [rows[0].id, fullName, city]);
    return rows[0].id;
  }

  const out = await db.tx(async (client) => {
    const res = {};
    const adminId = await user(client, 'admin@amrutam.local', 'admin', 'Platform Admin', null);
    if (adminId) {
      res.adminMfaSecret = totp.generateSecret();
      await client.query('UPDATE users SET mfa_enabled = true, mfa_secret_enc = $2 WHERE id = $1', [adminId, cipher.encrypt(res.adminMfaSecret)]);
    }

    await user(client, 'patient@amrutam.local', 'patient', 'Ravi Kumar', 'Pune');

    for (const [i, d] of doctors.entries()) {
      const id = await user(client, d.email, 'doctor', d.name, d.city);
      if (!id) continue;
      await client.query(
        `INSERT INTO doctors (user_id, registration_no, specialization, languages, experience_years, fee_paise, rating_avg, rating_count, is_verified, bio)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)`,
        [id, `AYUSH-${1000 + i}`, d.spec, d.langs, d.exp, d.fee * 100, d.rating, 20 + i * 7, `${d.exp} years of practice in ${d.spec}.`],
      );
      // 10:00-13:00 IST, 30 min slots, next 3 days
      await client.query(
        `INSERT INTO availability_slots (doctor_id, starts_at, ends_at)
         SELECT $1, t, t + interval '30 minutes'
         FROM generate_series(1, 3) AS day,
              generate_series(0, 5) AS n,
              LATERAL (SELECT ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + make_interval(days => day, hours => 10, mins => n * 30))
                               AT TIME ZONE 'Asia/Kolkata') AS t) x`,
        [id],
      );
    }
    return res;
  });

  console.log(`seeded. password for every account: ${PASSWORD}`);
  console.log('  admin@amrutam.local, patient@amrutam.local, dr.sharma@ / dr.iyer@ / dr.khan@amrutam.local');
  if (out.adminMfaSecret) {
    console.log(`  admin TOTP secret: ${out.adminMfaSecret}  (current code: node scripts/totp.js ${out.adminMfaSecret})`);
  }
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
