const crypto = require('crypto');
const { unauthorized, conflict, notFound } = require('../../lib/errors');
const { toPaymentDto } = require('../consultations/consultation.dto');

// "mockpay" stands in for a real gateway (Razorpay/Stripe). The shape is the
// same: we create a payment, the gateway calls our webhook with a signed event.
function createPaymentsService({ db, config, logger, bookingsService, paymentsRepo, auditService }) {
  const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', config.payments.webhookSecret).update(raw).digest('hex');

  function verifySignature(rawBody, header) {
    if (!rawBody || !header) return false;
    const expected = Buffer.from(sign(rawBody));
    const got = Buffer.from(header);
    return expected.length === got.length && crypto.timingSafeEqual(expected, got);
  }

  // replays are harmless: settlePayment is a no-op once the payment left 'created'
  async function handleWebhook(rawBody, signature, event) {
    if (!verifySignature(rawBody, signature)) throw unauthorized('Bad webhook signature');
    const outcome = await bookingsService.settlePayment({
      paymentId: event.paymentId,
      succeeded: event.status === 'succeeded',
      providerRef: event.providerRef,
      failureReason: event.failureReason,
    });
    return { received: true, duplicate: !!outcome.noop };
  }

  // dev/demo helper: pretend the patient finished checkout on the gateway page
  async function mockPay(paymentId, patientId, outcome) {
    const payment = await bookingsService.getPaymentForPatient(paymentId, patientId);
    if (payment.status !== 'created') throw conflict(`Payment is already ${payment.status}`, 'PAYMENT_NOT_PENDING');

    const event = {
      eventId: `evt_${crypto.randomUUID()}`,
      paymentId,
      status: outcome === 'success' ? 'succeeded' : 'failed',
      providerRef: `mp_${crypto.randomBytes(8).toString('hex')}`,
      failureReason: outcome === 'success' ? undefined : 'card_declined',
    };
    const raw = Buffer.from(JSON.stringify(event));
    await handleWebhook(raw, sign(raw), event);
    return toPaymentDto(await paymentsRepo.findById(paymentId));
  }

  async function get(paymentId, patientId) {
    return toPaymentDto(await bookingsService.getPaymentForPatient(paymentId, patientId));
  }

  // background job. idempotent: only a 'succeeded' payment gets refunded, once.
  async function refund(paymentId, reason) {
    const refunded = await db.tx(async (client) => {
      const p = await paymentsRepo.lockById(client, paymentId);
      if (!p) throw notFound('Payment');
      if (p.status !== 'succeeded') return null;
      // real gateway call would go here, with p.id as its idempotency key
      logger.info({ paymentId, amount: p.amount_paise, reason }, 'mockpay refund issued');
      return paymentsRepo.update(client, p.id, { status: 'refunded', failure_reason: reason });
    });
    if (refunded) {
      await auditService.record({ action: 'payment.refunded', resourceType: 'payment', resourceId: paymentId, metadata: { reason } });
    }
    return !!refunded;
  }

  return { handleWebhook, mockPay, get, refund, sign };
}

module.exports = { createPaymentsService };
