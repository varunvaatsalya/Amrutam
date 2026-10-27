const { conflict, notFound, badRequest } = require('../../lib/errors');
const { assertTransition } = require('./stateMachine');
const { toConsultationDto } = require('./consultation.dto');

const EARLY_START_MIN = 10;
const NO_SHOW_AFTER_MIN = 15;
// patient cancels closer than this to the start => no refund
const FREE_CANCEL_HOURS = 2;

function createConsultationsService({ db, cipher, cache, queue, auditService, consultationsRepo, paymentsRepo, availabilityRepo }) {
  // 404 (not 403) for non-participants so ids can't be probed
  function assertParticipant(row, user) {
    if (!row) throw notFound('Consultation');
    if (user.role === 'admin') return;
    if (user.role === 'patient' && row.patient_id === user.id) return;
    if (user.role === 'doctor' && row.doctor_id === user.id) return;
    throw notFound('Consultation');
  }

  async function get(id, user, ctx) {
    const row = await consultationsRepo.findById(id);
    assertParticipant(row, user);
    // PHI read - compliance wants to know who looked
    await auditService.record({ ...ctx, action: 'consultation.read', resourceType: 'consultation', resourceId: id });
    return toConsultationDto(row, cipher);
  }

  async function list(user, { status, from, to, cursor, limit }) {
    let cur = null;
    if (cursor) {
      try {
        cur = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      } catch {
        throw badRequest('Invalid cursor');
      }
    }
    const rows = await consultationsRepo.listFor({ userId: user.id, role: user.role, status, from, to, cursor: cur, limit });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      // list view skips PHI, open a single consultation for details
      data: page.map((r) => toConsultationDto(r, cipher, { includePhi: false })),
      nextCursor: hasMore ? Buffer.from(JSON.stringify({ at: last.scheduled_at, id: last.id })).toString('base64url') : null,
    };
  }

  // shared skeleton for doctor-driven transitions
  async function doctorTransition(id, doctorId, to, check, fields, ctx) {
    const row = await db.tx(async (client) => {
      const c = await consultationsRepo.lockById(client, id);
      if (!c || c.doctor_id !== doctorId) throw notFound('Consultation');
      assertTransition(c.status, to);
      check?.(c);
      return consultationsRepo.update(client, c, { status: to, ...fields });
    });
    await auditService.record({ ...ctx, action: `consultation.${to}`, resourceType: 'consultation', resourceId: id });
    return toConsultationDto(row, cipher);
  }

  const start = (id, doctorId, ctx) => doctorTransition(id, doctorId, 'in_progress', (c) => {
    if (Date.now() < new Date(c.scheduled_at) - EARLY_START_MIN * 60_000) {
      throw conflict(`Can start at most ${EARLY_START_MIN} minutes early`, 'TOO_EARLY');
    }
  }, { started_at: new Date() }, ctx);

  const complete = (id, doctorId, notes, ctx) =>
    doctorTransition(id, doctorId, 'completed', null, { completed_at: new Date(), doctor_notes_enc: cipher.encrypt(notes) }, ctx);

  const markNoShow = (id, doctorId, ctx) => doctorTransition(id, doctorId, 'no_show', (c) => {
    if (Date.now() < new Date(c.scheduled_at).getTime() + NO_SHOW_AFTER_MIN * 60_000) {
      throw conflict(`Wait ${NO_SHOW_AFTER_MIN} minutes after start before marking no-show`, 'TOO_EARLY');
    }
  }, {}, ctx);

  async function cancel(id, user, reason, ctx) {
    const result = await db.tx(async (client) => {
      const c = await consultationsRepo.lockById(client, id);
      assertParticipant(c, user);
      assertTransition(c.status, 'cancelled');
      if (new Date(c.scheduled_at) <= new Date()) throw conflict('Consultation already started, cannot cancel', 'TOO_LATE');

      const byDoctor = user.role === 'doctor';
      const payment = await paymentsRepo.lockLatestForConsultation(client, id);
      let refund = false;
      if (payment?.status === 'created') {
        await paymentsRepo.update(client, payment.id, { status: 'failed', failure_reason: 'cancelled' });
      } else if (payment?.status === 'succeeded') {
        const hoursLeft = (new Date(c.scheduled_at) - Date.now()) / 3600_000;
        refund = byDoctor || hoursLeft >= FREE_CANCEL_HOURS;
      }

      const updated = await consultationsRepo.update(client, c, {
        status: 'cancelled',
        cancel_reason: reason || (byDoctor ? 'cancelled_by_doctor' : 'cancelled_by_patient'),
        cancelled_by: user.id,
      });
      // doctor cancelled => they're not available then, don't resell the slot
      await availabilityRepo.setStatus(client, c.slot_id, byDoctor ? 'blocked' : 'open');
      return { updated, refund, paymentId: payment?.id };
    });

    const { updated, refund, paymentId } = result;
    await cache.bump(`slots:${updated.doctor_id}`);
    if (refund) await queue.enqueue('payment.refund', { paymentId, reason: 'consultation_cancelled' }, { jobId: `refund-${paymentId}` });
    await queue.enqueue('notify', { template: 'booking_cancelled', consultationId: id, userIds: [updated.patient_id, updated.doctor_id] });
    await auditService.record({ ...ctx, action: 'consultation.cancelled', resourceType: 'consultation', resourceId: id, metadata: { refund } });
    return { ...toConsultationDto(updated, cipher), refundInitiated: refund };
  }

  return { get, list, start, complete, markNoShow, cancel, assertParticipant };
}

module.exports = { createConsultationsService };
