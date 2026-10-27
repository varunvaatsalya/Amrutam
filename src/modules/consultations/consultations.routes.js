const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');
const { requireRole } = require('../../middleware/auth');

const idParam = z.object({ id: z.uuid() });
const listQuery = z.object({
  status: z.enum(['pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(300).optional(),
});
const completeBody = z.object({ notes: z.string().trim().max(5000).optional() });
const cancelBody = z.object({ reason: z.string().trim().max(300).optional() });

const medication = z.object({
  name: z.string().trim().min(1).max(120),
  dosage: z.string().trim().min(1).max(60),
  frequency: z.string().trim().min(1).max(60),
  durationDays: z.number().int().min(1).max(365),
  instructions: z.string().trim().max(300).optional(),
});
const prescriptionBody = z.object({
  medications: z.array(medication).min(1).max(30),
  advice: z.string().trim().max(3000).optional(),
});

function consultationsRoutes({ consultationsService, prescriptionsService, authenticate, idempotent, requireMfa }) {
  const r = Router();
  const doctor = [authenticate, requireRole('doctor')];
  const participant = [authenticate, requireRole('patient', 'doctor', 'admin')];

  r.get('/', authenticate, requireRole('patient', 'doctor'), validate({ query: listQuery }), async (req, res) => {
    res.json(await consultationsService.list(req.user, req.valid.query));
  });

  r.get('/:id', participant, validate({ params: idParam }), async (req, res) => {
    res.json(await consultationsService.get(req.valid.params.id, req.user, req.auditCtx()));
  });

  r.post('/:id/start', doctor, validate({ params: idParam }), async (req, res) => {
    res.json(await consultationsService.start(req.valid.params.id, req.user.id, req.auditCtx()));
  });

  r.post('/:id/complete', doctor, validate({ params: idParam, body: completeBody }), async (req, res) => {
    res.json(await consultationsService.complete(req.valid.params.id, req.user.id, req.valid.body.notes, req.auditCtx()));
  });

  r.post('/:id/no-show', doctor, validate({ params: idParam }), async (req, res) => {
    res.json(await consultationsService.markNoShow(req.valid.params.id, req.user.id, req.auditCtx()));
  });

  r.post('/:id/cancel', authenticate, requireRole('patient', 'doctor'), idempotent, validate({ params: idParam, body: cancelBody }), async (req, res) => {
    res.json(await consultationsService.cancel(req.valid.params.id, req.user, req.valid.body.reason, req.auditCtx()));
  });

  r.post('/:id/prescription', doctor, requireMfa, idempotent, validate({ params: idParam, body: prescriptionBody }), async (req, res) => {
    res.status(201).json(await prescriptionsService.create(req.valid.params.id, req.user.id, req.valid.body, req.auditCtx()));
  });

  r.get('/:id/prescription', participant, validate({ params: idParam }), async (req, res) => {
    res.json(await prescriptionsService.getForConsultation(req.valid.params.id, req.user, req.auditCtx()));
  });

  return r;
}

function prescriptionsRoutes({ prescriptionsService, authenticate }) {
  const r = Router();

  r.get('/', authenticate, requireRole('patient'), async (req, res) => {
    res.json({ data: await prescriptionsService.listForPatient(req.user.id) });
  });

  r.get('/:id/pdf', authenticate, validate({ params: idParam }), async (req, res) => {
    const file = await prescriptionsService.getPdfPath(req.valid.params.id, req.user, req.auditCtx());
    res.setHeader('Cache-Control', 'no-store');
    res.download(file, `prescription-${req.valid.params.id}.pdf`);
  });

  return r;
}

module.exports = { consultationsRoutes, prescriptionsRoutes };
