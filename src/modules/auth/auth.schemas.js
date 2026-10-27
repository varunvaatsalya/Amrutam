const { z } = require('zod');

const email = z.string().trim().toLowerCase().email().max(254);
// 10+ chars, at least one letter and one digit. not going overboard with rules (NIST 800-63b)
const password = z.string().min(10).max(128)
  .regex(/[A-Za-z]/, 'must contain a letter')
  .regex(/\d/, 'must contain a digit');

const doctorFields = z.object({
  registrationNo: z.string().trim().min(3).max(50),
  specialization: z.string().trim().min(2).max(80),
  languages: z.array(z.string().trim().min(2).max(30)).max(10).default([]),
  experienceYears: z.number().int().min(0).max(70).default(0),
  feeInr: z.number().int().min(0).max(100000),
  bio: z.string().max(2000).optional(),
});

const register = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('patient'),
    email,
    password,
    fullName: z.string().trim().min(2).max(120),
    phone: z.string().regex(/^\+?\d{10,14}$/).optional(),
  }),
  z.object({
    role: z.literal('doctor'),
    email,
    password,
    fullName: z.string().trim().min(2).max(120),
    phone: z.string().regex(/^\+?\d{10,14}$/).optional(),
    doctor: doctorFields,
  }),
]);

const login = z.object({
  email,
  password: z.string().min(1).max(128),
  mfaCode: z.string().regex(/^\d{6}$/).optional(),
});

const refresh = z.object({ refreshToken: z.string().min(20).max(200) });

module.exports = { register, login, refresh };
