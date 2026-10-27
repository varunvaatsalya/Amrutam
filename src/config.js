const { z } = require('zod');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().default(20),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET should be at least 32 chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  ENCRYPTION_KEYS: z.string(),
  ENCRYPTION_ACTIVE_KEY: z.string(),
  RATE_LIMIT_WINDOW_SEC: z.coerce.number().default(60),
  RATE_LIMIT_MAX: z.coerce.number().default(120),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().default(10),
  REQUIRE_STAFF_MFA: z.enum(['true', 'false']).default('true'),
  PAYMENT_WEBHOOK_SECRET: z.string().min(16),
  BOOKING_HOLD_MINUTES: z.coerce.number().default(10),
  STORAGE_DIR: z.string().default('./storage'),
  METRICS_TOKEN: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // fail fast, no point booting with half a config
  console.error('Invalid environment:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

const env = parsed.data;

module.exports = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  db: { url: env.DATABASE_URL, poolMax: env.DB_POOL_MAX },
  redisUrl: env.REDIS_URL,
  jwt: {
    accessSecret: env.JWT_ACCESS_SECRET,
    accessTtl: env.ACCESS_TOKEN_TTL,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
  },
  encryption: { keys: env.ENCRYPTION_KEYS, activeKey: env.ENCRYPTION_ACTIVE_KEY },
  rateLimit: { windowSec: env.RATE_LIMIT_WINDOW_SEC, max: env.RATE_LIMIT_MAX, authMax: env.AUTH_RATE_LIMIT_MAX },
  requireStaffMfa: env.REQUIRE_STAFF_MFA === 'true',
  payments: { webhookSecret: env.PAYMENT_WEBHOOK_SECRET },
  booking: { holdMinutes: env.BOOKING_HOLD_MINUTES },
  storageDir: env.STORAGE_DIR,
  metricsToken: env.METRICS_TOKEN,
};
