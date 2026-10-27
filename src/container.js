// Composition root. Everything is wired here by hand - small enough that a DI
// library would be more ceremony than help. Tests build their own container
// with overrides (see tests/helpers.js).
const config = require('./config');
const logger = require('./lib/logger');
const { createDb } = require('./lib/db');
const { createRedis } = require('./lib/redis');
const { createCipher } = require('./lib/crypto');
const { createCache } = require('./lib/cache');
const { createLocker } = require('./lib/lock');
const { createQueue } = require('./lib/queue');
const { createAuditService } = require('./modules/audit/audit.service');
const { createAuthRepo } = require('./modules/auth/auth.repo');
const { createAuthService } = require('./modules/auth/auth.service');
const { createDoctorsRepo } = require('./modules/doctors/doctors.repo');
const { createDoctorsService } = require('./modules/doctors/doctors.service');
const { createAvailabilityRepo } = require('./modules/availability/availability.repo');
const { createAvailabilityService } = require('./modules/availability/availability.service');
const { createConsultationsRepo } = require('./modules/consultations/consultations.repo');
const { createConsultationsService } = require('./modules/consultations/consultations.service');
const { createPaymentsRepo } = require('./modules/payments/payments.repo');
const { createPaymentsService } = require('./modules/payments/payments.service');
const { createBookingsService } = require('./modules/bookings/bookings.service');
const { createPrescriptionsService } = require('./modules/prescriptions/prescriptions.service');
const { createAdminService } = require('./modules/admin/admin.service');

function createContainer(overrides = {}) {
  const c = { config, logger, ...overrides };

  c.db = c.db || createDb(config.db, logger);
  c.redis = c.redis || createRedis(config.redisUrl, logger);
  c.cipher = c.cipher || createCipher(config.encryption);
  c.queue = c.queue || createQueue(config.redisUrl, logger);
  c.cache = createCache(c.redis, logger);
  c.locker = createLocker(c.redis);

  c.auditService = createAuditService(c);

  c.authRepo = createAuthRepo(c.db);
  c.doctorsRepo = createDoctorsRepo(c.db);
  c.availabilityRepo = createAvailabilityRepo(c.db);
  c.consultationsRepo = createConsultationsRepo(c.db);
  c.paymentsRepo = createPaymentsRepo(c.db);

  c.authService = createAuthService(c);
  c.doctorsService = createDoctorsService(c);
  c.availabilityService = createAvailabilityService(c);
  c.bookingsService = createBookingsService(c);
  c.paymentsService = createPaymentsService(c);
  c.consultationsService = createConsultationsService(c);
  c.prescriptionsService = createPrescriptionsService(c);
  c.adminService = createAdminService(c);

  c.close = async () => {
    await Promise.allSettled([c.queue.close(), c.db.close(), c.redis.quit()]);
  };

  return c;
}

module.exports = { createContainer };
