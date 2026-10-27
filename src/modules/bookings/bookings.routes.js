const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');
const { requireRole } = require('../../middleware/auth');

const createBooking = z.object({
  slotId: z.uuid(),
  reason: z.string().trim().max(1000).optional(),
});

function bookingsRoutes({ bookingsService, authenticate, idempotent }) {
  const r = Router();

  r.post('/', authenticate, requireRole('patient'), idempotent, validate({ body: createBooking }), async (req, res) => {
    res.status(201).json(await bookingsService.createBooking(req.user.id, req.valid.body, req.auditCtx()));
  });

  return r;
}

module.exports = { bookingsRoutes };
