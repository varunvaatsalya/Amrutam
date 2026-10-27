// job name -> handler. handlers must be idempotent: bullmq retries on throw,
// and the same job can run twice if a worker dies mid-way.
function createProcessors(c) {
  const { db, logger, bookingsService, paymentsService, prescriptionsService, adminService } = c;

  return {
    'booking.expire': async ({ consultationId }) => bookingsService.expireHold(consultationId),

    'payment.refund': async ({ paymentId, reason }) => paymentsService.refund(paymentId, reason),

    'prescription.pdf': async ({ prescriptionId }) => prescriptionsService.renderPdf(prescriptionId),

    // stand-in for email/SMS/push. only ids go in the job payload, never PHI.
    notify: async ({ template, consultationId, userIds }) => {
      logger.info({ template, consultationId, userIds }, 'notification sent (stub)');
      return true;
    },

    // safety net for lost/failed booking.expire jobs
    'maintenance.sweep-holds': async () => {
      const n = await bookingsService.sweepStaleHolds();
      if (n) logger.warn({ expired: n }, 'sweeper released stale holds');
      return n;
    },

    // keep partitions 3 months ahead so inserts never hit a missing range
    'maintenance.partitions': async () => {
      await db.query(`
        SELECT create_monthly_partition(t, (date_trunc('month', now()) + make_interval(months => m))::date)
        FROM unnest(ARRAY['consultations', 'audit_logs']) AS t, generate_series(0, 3) AS m`);
      return true;
    },

    'analytics.refresh': async () => {
      await adminService.refreshStats();
      return true;
    },
  };
}

const SCHEDULES = [
  { id: 'sweep-holds', name: 'maintenance.sweep-holds', every: 60_000 },
  { id: 'partitions', name: 'maintenance.partitions', every: 24 * 3600_000 },
  { id: 'analytics', name: 'analytics.refresh', every: 15 * 60_000 },
];

module.exports = { createProcessors, SCHEDULES };
