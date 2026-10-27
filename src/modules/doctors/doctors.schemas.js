const { z } = require('zod');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const idParam = z.object({ id: z.uuid() });

const search = z.object({
  q: z.string().trim().min(2).max(60).optional(),
  specialization: z.string().trim().max(80).optional(),
  language: z.string().trim().max(30).optional(),
  city: z.string().trim().max(60).optional(),
  minFee: z.coerce.number().int().min(0).optional(),
  maxFee: z.coerce.number().int().min(0).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  availableOn: isoDate.optional(),
  sort: z.enum(['rating', 'fee', 'experience']).default('rating'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(300).optional(),
});

const updateMe = z.object({
  specialization: z.string().trim().min(2).max(80).optional(),
  languages: z.array(z.string().trim().toLowerCase().min(2).max(30)).max(10).optional(),
  experienceYears: z.number().int().min(0).max(70).optional(),
  feeInr: z.number().int().min(0).max(100000).optional(),
  bio: z.string().max(2000).optional(),
}).refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const range = z.object({ from: isoDate.optional(), to: isoDate.optional() });

const slot = z.object({ startsAt: z.coerce.date(), endsAt: z.coerce.date() })
  .refine((s) => s.endsAt > s.startsAt, 'endsAt must be after startsAt')
  .refine((s) => s.endsAt - s.startsAt <= 2 * 3600_000, 'a slot can be at most 2 hours');

const createSlots = z.union([
  z.object({ slots: z.array(slot).min(1).max(200) }),
  // convenience: "every 15 min from 10:00 to 13:00"
  z.object({
    generate: z.object({
      from: z.coerce.date(),
      to: z.coerce.date(),
      durationMinutes: z.number().int().min(10).max(120),
    }).refine((g) => g.to > g.from, 'to must be after from'),
  }),
]);

const slotParam = z.object({ slotId: z.uuid() });

module.exports = { search, idParam, updateMe, range, createSlots, slotParam };
