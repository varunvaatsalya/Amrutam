// Rough latency check, not a benchmark. Needs seeded data and the API running
// with a high RATE_LIMIT_MAX (otherwise you're measuring the limiter).
//   RATE_LIMIT_MAX=1000000 npm run dev    then    node scripts/loadtest.js
const crypto = require('crypto');

const BASE = process.env.BASE_URL || 'http://localhost:3000/api/v1';
const CONCURRENCY = Number(process.env.CONCURRENCY || 20);
const READS = Number(process.env.READS || 3000);
const PASSWORD = 'Password123';

async function req(method, path, { token, body, headers = {} } = {}) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...headers },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, ms: performance.now() - t0 };
}

async function pool(tasks, n) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < tasks.length) out.push(await tasks[i++]());
  }));
  return out;
}

function report(name, results) {
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))].toFixed(1);
  const errors = results.filter((r) => r.status >= 400).length;
  console.log(`${name.padEnd(28)} n=${String(ms.length).padEnd(5)} p50=${pct(50)}ms  p95=${pct(95)}ms  p99=${pct(99)}ms  errors=${errors}`);
}

async function main() {
  const login = async (email) => (await req('POST', '/auth/login', { body: { email, password: PASSWORD } })).body;
  const doctor = await login('dr.khan@amrutam.local');
  const patient = await login('patient@amrutam.local');
  const doctorId = doctor.user.id;

  // fresh slots far in the future so we can book a few hundred
  const from = new Date(Date.now() + 40 * 86400_000);
  from.setUTCHours(0, 0, 0, 0);
  const made = await req('POST', '/doctors/me/slots', {
    token: doctor.accessToken,
    body: { generate: { from, to: new Date(+from + 50 * 3600_000), durationMinutes: 15 } },
  });
  const slots = made.body?.data || [];
  if (!slots.length) throw new Error(`could not create slots: ${JSON.stringify(made.body)}`);

  const searches = ['?language=hindi', '?sort=fee', '?specialization=ayurveda&minRating=4', '?q=sharma', ''];
  report('GET /doctors (search)', await pool(
    Array.from({ length: READS }, (_, i) => () => req('GET', `/doctors${searches[i % searches.length]}`)), CONCURRENCY));
  report('GET /doctors/:id/slots', await pool(
    Array.from({ length: READS }, () => () => req('GET', `/doctors/${doctorId}/slots`)), CONCURRENCY));
  report('POST /bookings', await pool(
    slots.map((s) => () => req('POST', '/bookings', {
      token: patient.accessToken,
      body: { slotId: s.id },
      headers: { 'idempotency-key': crypto.randomUUID() },
    })), CONCURRENCY));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
