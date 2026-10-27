const { Router } = require('express');
const { validate } = require('../../middleware/validate');
const { requireRole } = require('../../middleware/auth');
const s = require('./doctors.schemas');

function doctorsRoutes({ doctorsService, availabilityService, authenticate }) {
  const r = Router();
  const doctorOnly = [authenticate, requireRole('doctor')];

  // --- doctor's own profile & calendar (must be above /:id)
  r.patch('/me', doctorOnly, validate({ body: s.updateMe }), async (req, res) => {
    res.json(await doctorsService.updateOwn(req.user.id, req.valid.body, req.auditCtx()));
  });

  r.get('/me/slots', doctorOnly, validate({ query: s.range }), async (req, res) => {
    res.json({ data: await availabilityService.listMine(req.user.id, req.valid.query) });
  });

  r.post('/me/slots', doctorOnly, validate({ body: s.createSlots }), async (req, res) => {
    res.status(201).json({ data: await availabilityService.createSlots(req.user.id, req.valid.body, req.auditCtx()) });
  });

  r.delete('/me/slots/:slotId', doctorOnly, validate({ params: s.slotParam }), async (req, res) => {
    res.json(await availabilityService.block(req.user.id, req.valid.params.slotId, req.auditCtx()));
  });

  // --- public discovery
  r.get('/', validate({ query: s.search }), async (req, res) => {
    res.json(await doctorsService.search(req.valid.query));
  });

  r.get('/:id', validate({ params: s.idParam }), async (req, res) => {
    res.json(await doctorsService.getById(req.valid.params.id));
  });

  r.get('/:id/slots', validate({ params: s.idParam, query: s.range }), async (req, res) => {
    await doctorsService.getById(req.valid.params.id); // 404 for unknown/unverified doctors
    res.json({ data: await availabilityService.listOpen(req.valid.params.id, req.valid.query) });
  });

  return r;
}

module.exports = { doctorsRoutes };
