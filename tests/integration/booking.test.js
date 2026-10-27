const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { setup } = require('./helpers');

const h = setup();
test.after(() => h.close());

test('booking holds the slot and creates a pending payment', async () => {
  const doctor = await h.createUser('doctor');
  const patient = await h.createUser('patient');
  const slotId = await h.createSlot(doctor.id);

  const res = await h.book(patient.token, slotId, undefined, { reason: 'back pain' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.consultation.status, 'pending');
  assert.strictEqual(res.body.payment.amountInr, 500);
  assert.strictEqual(await h.slotStatus(slotId), 'held');

  // reason is encrypted at rest
  const row = await h.consultation(res.body.consultation.id);
  assert.ok(!row.reason_enc.includes('back pain'));
});

test('idempotency: replay, conflicting body, missing key', async () => {
  const doctor = await h.createUser('doctor');
  const patient = await h.createUser('patient');
  const slotA = await h.createSlot(doctor.id);
  const slotB = await h.createSlot(doctor.id, 48 * 60);
  const key = crypto.randomUUID();

  const first = await h.book(patient.token, slotA, key);
  const again = await h.book(patient.token, slotA, key);
  assert.strictEqual(again.status, 201);
  assert.strictEqual(again.headers['idempotent-replayed'], 'true');
  assert.deepStrictEqual(again.body, first.body);

  const { rows } = await h.c.db.query('SELECT count(*)::int n FROM consultations WHERE slot_id = $1', [slotA]);
  assert.strictEqual(rows[0].n, 1, 'replay must not create a second booking');

  const other = await h.book(patient.token, slotB, key);
  assert.strictEqual(other.status, 422);

  const noKey = await h.api().post('/api/v1/bookings').set('authorization', `Bearer ${patient.token}`).send({ slotId: slotB });
  assert.strictEqual(noKey.status, 400);
});

test('idempotency keys are scoped per user', async () => {
  const doctor = await h.createUser('doctor');
  const p1 = await h.createUser('patient');
  const p2 = await h.createUser('patient');
  const key = crypto.randomUUID();

  const a = await h.book(p1.token, await h.createSlot(doctor.id), key);
  const b = await h.book(p2.token, await h.createSlot(doctor.id, 48 * 60), key);
  assert.strictEqual(a.status, 201);
  assert.strictEqual(b.status, 201);
  assert.notStrictEqual(a.body.consultation.id, b.body.consultation.id);
});

test('concurrent bookings for one slot: exactly one wins', async () => {
  const doctor = await h.createUser('doctor');
  const patients = await Promise.all(Array.from({ length: 8 }, () => h.createUser('patient')));
  const slotId = await h.createSlot(doctor.id);

  const results = await Promise.all(patients.map((p) => h.book(p.token, slotId)));
  const codes = results.map((r) => r.status).sort();
  assert.strictEqual(codes.filter((s) => s === 201).length, 1, `got ${codes}`);
  assert.ok(codes.filter((s) => s !== 201).every((s) => s === 409));
});

test('db unique index still blocks double booking without the redis lock', async () => {
  const doctor = await h.createUser('doctor');
  const patient = await h.createUser('patient');
  const slotId = await h.createSlot(doctor.id);
  const ok = await h.book(patient.token, slotId);
  const c = await h.consultation(ok.body.consultation.id);

  await assert.rejects(
    h.c.db.query(
      'INSERT INTO consultations (scheduled_at, patient_id, doctor_id, slot_id) VALUES ($1, $2, $3, $4)',
      [c.scheduled_at, patient.id, doctor.id, slotId],
    ),
    (err) => err.code === '23505',
  );
});

test('payment success confirms; duplicate webhook is a no-op', async () => {
  const doctor = await h.createUser('doctor');
  const patient = await h.createUser('patient');
  const slotId = await h.createSlot(doctor.id);
  const b = await h.book(patient.token, slotId);

  const event = { paymentId: b.body.payment.id, succeeded: true, providerRef: `ref-${crypto.randomUUID()}` };
  await h.c.bookingsService.settlePayment(event);
  const dup = await h.c.bookingsService.settlePayment(event);

  assert.strictEqual(dup.noop, true);
  assert.strictEqual((await h.consultation(b.body.consultation.id)).status, 'confirmed');
  assert.strictEqual(await h.slotStatus(slotId), 'booked');
});

test('webhook rejects a bad signature', async () => {
  const res = await h.api().post('/api/v1/payments/webhook')
    .set('x-mockpay-signature', 'sha256=00')
    .send({ eventId: 'e1', paymentId: crypto.randomUUID(), status: 'succeeded', providerRef: 'x' });
  assert.strictEqual(res.status, 401);
});

test('payment failure compensates: consultation cancelled, slot reopened', async () => {
  const doctor = await h.createUser('doctor');
  const patient = await h.createUser('patient');
  const slotId = await h.createSlot(doctor.id);
  const b = await h.book(patient.token, slotId);

  await h.c.bookingsService.settlePayment({ paymentId: b.body.payment.id, succeeded: false, providerRef: `ref-${crypto.randomUUID()}` });
  const c = await h.consultation(b.body.consultation.id);
  assert.strictEqual(c.status, 'cancelled');
  assert.strictEqual(c.cancel_reason, 'payment_failed');
  assert.strictEqual(await h.slotStatus(slotId), 'open');
});

test('hold expiry releases the slot; a late payment is refunded', async () => {
  const doctor = await h.createUser('doctor');
  const patient = await h.createUser('patient');
  const slotId = await h.createSlot(doctor.id);
  const b = await h.book(patient.token, slotId);

  assert.strictEqual(await h.c.bookingsService.expireHold(b.body.consultation.id), true);
  assert.strictEqual(await h.c.bookingsService.expireHold(b.body.consultation.id), false, 'second run is a no-op');
  assert.strictEqual(await h.slotStatus(slotId), 'open');

  const late = await h.c.bookingsService.settlePayment({ paymentId: b.body.payment.id, succeeded: true, providerRef: `ref-${crypto.randomUUID()}` });
  assert.strictEqual(late.refund, true);
  assert.strictEqual((await h.consultation(b.body.consultation.id)).status, 'cancelled');

  assert.strictEqual(await h.c.paymentsService.refund(b.body.payment.id, 'late_payment'), true);
  assert.strictEqual(await h.c.paymentsService.refund(b.body.payment.id, 'late_payment'), false, 'refund is idempotent');
  assert.strictEqual((await h.payment(b.body.payment.id)).status, 'refunded');
});

test('unverified doctors cannot be booked', async () => {
  const doctor = await h.createUser('doctor', { verified: false });
  const patient = await h.createUser('patient');
  const res = await h.book(patient.token, await h.createSlot(doctor.id));
  assert.strictEqual(res.status, 404);
});
