const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');
const { requireRole } = require('../../middleware/auth');

const idParam = z.object({ id: z.uuid() });
const isoDate = z.iso.date();
const range = z.object({ from: isoDate.optional(), to: isoDate.optional() });
const auditQuery = z.object({
  actorId: z.uuid().optional(),
  action: z.string().max(60).optional(),
  resourceType: z.string().max(40).optional(),
  resourceId: z.string().max(80).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(300).optional(),
});

const daysAgo = (n) => new Date(Date.now() + 330 * 60_000 - n * 86400_000).toISOString().slice(0, 10);

function adminRoutes({ doctorsService, adminService, authenticate, requireMfa }) {
  const r = Router();
  r.use(authenticate, requireRole('admin'), requireMfa);

  r.patch('/doctors/:id/verification', validate({ params: idParam, body: z.object({ verified: z.boolean() }) }), async (req, res) => {
    res.json(await doctorsService.setVerified(req.valid.params.id, req.valid.body.verified, req.auditCtx()));
  });

  r.patch('/users/:id/status', validate({ params: idParam, body: z.object({ status: z.enum(['active', 'suspended']) }) }), async (req, res) => {
    res.json(await adminService.setUserStatus(req.valid.params.id, req.valid.body.status, req.auditCtx()));
  });

  r.get('/analytics/summary', validate({ query: range }), async (req, res) => {
    const { from = daysAgo(30), to = daysAgo(-30) } = req.valid.query;
    res.json(await adminService.summary({ from, to }));
  });

  r.get('/analytics/live', async (req, res) => {
    res.json(await adminService.live());
  });

  r.get('/audit-logs', validate({ query: auditQuery }), async (req, res) => {
    res.json(await adminService.auditLogs(req.valid.query));
  });

  return r;
}

module.exports = { adminRoutes };
