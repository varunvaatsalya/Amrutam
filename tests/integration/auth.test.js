const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { setup, PASSWORD } = require('./helpers');
const totp = require('../../src/lib/totp');

const h = setup();
test.after(() => h.close());

test('register validates input and rejects duplicates', async () => {
  const email = `p-${crypto.randomUUID()}@test.local`;
  const body = { role: 'patient', email, password: 'longenough1', fullName: 'Asha' };

  assert.strictEqual((await h.api().post('/api/v1/auth/register').send(body)).status, 201);
  assert.strictEqual((await h.api().post('/api/v1/auth/register').send(body)).status, 409);

  const weak = await h.api().post('/api/v1/auth/register').send({ ...body, email: `x${email}`, password: 'short' });
  assert.strictEqual(weak.status, 400);

  const admin = await h.api().post('/api/v1/auth/register').send({ ...body, email: `y${email}`, role: 'admin' });
  assert.strictEqual(admin.status, 400, 'nobody self-registers as admin');
});

test('refresh rotates; reusing an old token kills the session family', async () => {
  const u = await h.createUser('patient');
  const r1 = await h.api().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken });
  assert.strictEqual(r1.status, 200);

  const reuse = await h.api().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken });
  assert.strictEqual(reuse.status, 401);

  const afterTheft = await h.api().post('/api/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken });
  assert.strictEqual(afterTheft.status, 401, 'new token from the same family is revoked too');
});

test('rbac: patient cannot hit doctor or admin routes', async () => {
  const p = await h.createUser('patient');
  const slots = await h.api().post('/api/v1/doctors/me/slots').set('authorization', `Bearer ${p.token}`).send({ slots: [] });
  assert.strictEqual(slots.status, 403);
  const admin = await h.api().get('/api/v1/admin/audit-logs').set('authorization', `Bearer ${p.token}`);
  assert.strictEqual(admin.status, 403);
  const none = await h.api().get('/api/v1/auth/me');
  assert.strictEqual(none.status, 401);
});

test('tampered or foreign-signed jwt is rejected', async () => {
  const p = await h.createUser('patient');
  const [head, , sig] = p.token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: p.id, role: 'admin', mfa: true, iss: 'amrutam-api' })).toString('base64url');
  const res = await h.api().get('/api/v1/auth/me').set('authorization', `Bearer ${head}.${forged}.${sig}`);
  assert.strictEqual(res.status, 401);
});

test('mfa: staff gated until enabled, codes cannot be replayed', async () => {
  const d = await h.createUser('doctor');
  const setupRes = await h.api().post('/api/v1/auth/mfa/setup').set('authorization', `Bearer ${d.token}`);
  const { secret } = setupRes.body;

  const code = totp.generate(secret);
  const en = await h.api().post('/api/v1/auth/mfa/enable').set('authorization', `Bearer ${d.token}`).send({ code });
  assert.strictEqual(en.status, 200);

  const noCode = await h.api().post('/api/v1/auth/login').send({ email: d.email, password: PASSWORD });
  assert.strictEqual(noCode.status, 401);
  assert.strictEqual(noCode.body.error.details.mfaRequired, true);

  const replay = await h.api().post('/api/v1/auth/login').send({ email: d.email, password: PASSWORD, mfaCode: code });
  assert.strictEqual(replay.status, 401);

  const next = totp.generate(secret, Date.now() + 30_000);
  const okRes = await h.api().post('/api/v1/auth/login').send({ email: d.email, password: PASSWORD, mfaCode: next });
  assert.strictEqual(okRes.status, 200);
});

test('consultations are invisible to non-participants', async () => {
  const doctor = await h.createUser('doctor');
  const patient = await h.createUser('patient');
  const stranger = await h.createUser('patient');
  const b = await h.book(patient.token, await h.createSlot(doctor.id));

  const mine = await h.api().get(`/api/v1/consultations/${b.body.consultation.id}`).set('authorization', `Bearer ${patient.token}`);
  assert.strictEqual(mine.status, 200);
  const theirs = await h.api().get(`/api/v1/consultations/${b.body.consultation.id}`).set('authorization', `Bearer ${stranger.token}`);
  assert.strictEqual(theirs.status, 404);
});

test('audit log is append-only', async () => {
  await assert.rejects(h.c.db.query("UPDATE audit_logs SET action = 'x' WHERE true"), /append-only/);
  await assert.rejects(h.c.db.query('DELETE FROM audit_logs WHERE true'), /append-only/);
});
