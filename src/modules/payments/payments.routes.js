const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');
const { requireRole } = require('../../middleware/auth');

const idParam = z.object({ id: z.uuid() });
const webhookEvent = z.object({
  eventId: z.string().min(1).max(100),
  paymentId: z.uuid(),
  status: z.enum(['succeeded', 'failed']),
  providerRef: z.string().min(1).max(100),
  failureReason: z.string().max(200).optional(),
});
const mockPay = z.object({ outcome: z.enum(['success', 'failure']).default('success') });

function paymentsRoutes({ paymentsService, authenticate, idempotent }) {
  const r = Router();
  const patient = [authenticate, requireRole('patient')];

  // called by the gateway - authenticated by HMAC signature, not JWT
  r.post('/webhook', validate({ body: webhookEvent }), async (req, res) => {
    res.json(await paymentsService.handleWebhook(req.rawBody, req.get('x-mockpay-signature'), req.valid.body));
  });

  r.get('/:id', patient, validate({ params: idParam }), async (req, res) => {
    res.json(await paymentsService.get(req.valid.params.id, req.user.id));
  });

  r.post('/:id/mock-pay', patient, idempotent, validate({ params: idParam, body: mockPay }), async (req, res) => {
    res.json(await paymentsService.mockPay(req.valid.params.id, req.user.id, req.valid.body.outcome));
  });

  return r;
}

module.exports = { paymentsRoutes };
