const { randomToken } = require('../../lib/crypto');
const { conflict, notFound } = require('../../lib/errors');
const metrics = require('../../lib/metrics');
const { assertTransition } = require('../consultations/stateMachine');
const { toConsultationDto, toPaymentDto } = require('../consultations/consultation.dto');

const MIN_LEAD_MINUTES = 5;
const SLOT_LOCK_MS = 5000;

// Booking saga (orchestrated, each step is a local transaction):
//   1. hold slot + create pending consultation + create payment   (createBooking)
//   2a. payment succeeded -> confirm consultation, slot booked      (settlePayment)
//   2b. payment failed    -> cancel consultation, slot reopened     (settlePayment)
//   2c. no payment within hold window -> same as 2b                 (expireHold, delayed job + sweeper)
//   late success after 2c -> refund (compensation for money taken)
// Row locks are always taken consultation -> payment -> slot to avoid deadlocks.
function createBookingsService({ db, config, cipher, locker, cache, queue, auditService, availabilityRepo, consultationsRepo, paymentsRepo }) {
  const holdMs = config.booking.holdMinutes * 60_000;

  async function createBooking(patientId, { slotId, reason }, ctx) {
    const lockKey = `lock:slot:${slotId}`;
    let token;
    try {
      token = await locker.acquire(lockKey, SLOT_LOCK_MS);
    } catch {
      // redis down - skip the fast path, the row lock below still keeps us correct
      token = undefined;
    }
    if (token === null) {
      metrics.bookings.inc({ outcome: 'lock_contention' });
      throw conflict('Slot is being booked by someone else, pick another or retry', 'SLOT_BUSY');
    }

    let result;
    try {
      result = await db.tx(async (client) => {
        const slot = await availabilityRepo.lockForBooking(client, slotId);
        if (!slot || !slot.is_verified) throw notFound('Slot');
        if (slot.status !== 'open') throw conflict('Slot is no longer available', 'SLOT_UNAVAILABLE');
        if (new Date(slot.starts_at) - Date.now() < MIN_LEAD_MINUTES * 60_000) {
          throw conflict(`Slots must be booked at least ${MIN_LEAD_MINUTES} minutes in advance`, 'SLOT_TOO_SOON');
        }

        const holdUntil = new Date(Date.now() + holdMs);
        await availabilityRepo.setStatus(client, slot.id, 'held', holdUntil);

        const consultation = await consultationsRepo.insert(client, {
          scheduledAt: slot.starts_at,
          patientId,
          doctorId: slot.doctor_id,
          slotId: slot.id,
          reasonEnc: cipher.encrypt(reason),
        });
        const payment = await paymentsRepo.insert(client, {
          consultationId: consultation.id,
          scheduledAt: consultation.scheduled_at,
          patientId,
          amountPaise: slot.fee_paise,
        });
        return { consultation, payment, holdUntil };
      });
    } catch (err) {
      metrics.bookings.inc({ outcome: err.code === 'SLOT_UNAVAILABLE' || err.code === '23505' ? 'conflict' : 'rejected' });
      if (err.code === '23505') throw conflict('Slot is no longer available', 'SLOT_UNAVAILABLE');
      throw err;
    } finally {
      if (token) await locker.release(lockKey, token);
    }

    const { consultation, payment, holdUntil } = result;
    metrics.bookings.inc({ outcome: 'held' });
    await queue.enqueue('booking.expire', { consultationId: consultation.id }, {
      delay: holdMs,
      jobId: `expire-${consultation.id}`,
    });
    await cache.bump(`slots:${consultation.doctor_id}`);
    await auditService.record({ ...ctx, action: 'booking.create', resourceType: 'consultation', resourceId: consultation.id, metadata: { slotId } });

    return {
      consultation: toConsultationDto(consultation, cipher),
      payment: { ...toPaymentDto(payment), payUrl: `/api/v1/payments/${payment.id}/mock-pay` },
      holdExpiresAt: holdUntil,
    };
  }

  // called from the payment webhook. safe to call any number of times for the same event.
  async function settlePayment({ paymentId, succeeded, providerRef, failureReason }) {
    const existing = await paymentsRepo.findById(paymentId);
    if (!existing) throw notFound('Payment');

    const outcome = await db.tx(async (client) => {
      const consultation = await consultationsRepo.lockById(client, existing.consultation_id);
      const payment = await paymentsRepo.lockById(client, paymentId);

      if (payment.status === 'succeeded' || payment.status === 'refunded') return { noop: true, payment, consultation };

      if (!succeeded) {
        if (payment.status === 'failed') return { noop: true, payment, consultation };
        const p = await paymentsRepo.update(client, payment.id, { status: 'failed', provider_ref: providerRef, failure_reason: failureReason || 'declined' });
        const c = consultation.status === 'pending' ? await releaseBooking(client, consultation, 'payment_failed') : consultation;
        return { payment: p, consultation: c };
      }

      const p = await paymentsRepo.update(client, payment.id, { status: 'succeeded', provider_ref: providerRef, failure_reason: null });

      if (consultation.status !== 'pending') {
        // money came in after the hold expired / booking was cancelled -> give it back
        return { payment: p, consultation, refund: true };
      }

      assertTransition(consultation.status, 'confirmed');
      const c = await consultationsRepo.update(client, consultation, {
        status: 'confirmed',
        meeting_url: `https://meet.amrutam.local/c/${randomToken(12)}`,
      });
      await availabilityRepo.setStatus(client, c.slot_id, 'booked');
      return { payment: p, consultation: c, confirmed: true };
    });

    if (outcome.noop) {
      metrics.payments.inc({ status: 'duplicate' });
      return outcome;
    }
    metrics.payments.inc({ status: succeeded ? (outcome.refund ? 'late_success' : 'succeeded') : 'failed' });

    const c = outcome.consultation;
    await cache.bump(`slots:${c.doctor_id}`);
    if (outcome.refund) {
      await queue.enqueue('payment.refund', { paymentId, reason: 'late_payment' }, { jobId: `refund-${paymentId}` });
    }
    if (outcome.confirmed) {
      await queue.enqueue('notify', { template: 'booking_confirmed', consultationId: c.id, userIds: [c.patient_id, c.doctor_id] });
    }
    await auditService.record({
      action: succeeded ? 'payment.succeeded' : 'payment.failed',
      resourceType: 'payment',
      resourceId: paymentId,
      metadata: { consultationId: c.id, refund: !!outcome.refund },
    });
    return outcome;
  }

  // delayed job / sweeper. no-op unless the booking is still waiting for payment.
  async function expireHold(consultationId) {
    const changed = await db.tx(async (client) => {
      const consultation = await consultationsRepo.lockById(client, consultationId);
      if (!consultation || consultation.status !== 'pending') return null;

      const payment = await paymentsRepo.lockLatestForConsultation(client, consultationId);
      if (payment?.status === 'created') {
        await paymentsRepo.update(client, payment.id, { status: 'failed', failure_reason: 'hold_expired' });
      }
      return releaseBooking(client, consultation, 'hold_expired');
    });

    if (changed) {
      await cache.bump(`slots:${changed.doctor_id}`);
      await auditService.record({ action: 'booking.expired', resourceType: 'consultation', resourceId: consultationId });
    }
    return !!changed;
  }

  // compensation: cancel the pending consultation and put the slot back on sale
  async function releaseBooking(client, consultation, reason) {
    assertTransition(consultation.status, 'cancelled');
    const c = await consultationsRepo.update(client, consultation, { status: 'cancelled', cancel_reason: reason });
    await availabilityRepo.setStatus(client, consultation.slot_id, 'open');
    return c;
  }

  async function getPaymentForPatient(paymentId, patientId) {
    const p = await paymentsRepo.findById(paymentId);
    if (!p || p.patient_id !== patientId) throw notFound('Payment');
    return p;
  }

  async function sweepStaleHolds() {
    const ids = await consultationsRepo.findStaleHolds();
    let expired = 0;
    for (const id of ids) {
      if (await expireHold(id)) expired++;
    }
    return expired;
  }

  return { createBooking, settlePayment, expireHold, sweepStaleHolds, getPaymentForPatient };
}

module.exports = { createBookingsService };
