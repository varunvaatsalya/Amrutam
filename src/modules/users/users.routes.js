const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');

const updateProfile = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  phone: z.string().regex(/^\+?\d{10,14}$/).optional(),
  dateOfBirth: z.iso.date().optional(),
  gender: z.enum(['male', 'female', 'other']).optional(),
  city: z.string().trim().max(60).optional(),
}).refine((v) => Object.keys(v).length > 0, 'Nothing to update');

function usersRoutes({ db, cipher, authService, auditService, authenticate }) {
  const r = Router();

  r.patch('/me', authenticate, validate({ body: updateProfile }), async (req, res) => {
    const b = req.valid.body;
    const fields = {
      full_name: b.fullName,
      phone_enc: b.phone !== undefined ? cipher.encrypt(b.phone) : undefined,
      date_of_birth: b.dateOfBirth,
      gender: b.gender,
      city: b.city,
    };
    const cols = Object.keys(fields).filter((k) => fields[k] !== undefined);
    await db.query(
      `UPDATE profiles SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE user_id = $1`,
      [req.user.id, ...cols.map((c) => fields[c])],
    );
    await auditService.record({ ...req.auditCtx(), action: 'profile.update', resourceType: 'user', resourceId: req.user.id, metadata: { fields: Object.keys(b) } });
    res.json(await authService.me(req.user.id));
  });

  return r;
}

module.exports = { usersRoutes };
