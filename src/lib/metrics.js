const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status'],
  // tuned around our SLOs: 200ms reads, 500ms writes
  buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

const dbDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Postgres query latency',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

const bookings = new client.Counter({
  name: 'bookings_total',
  help: 'Booking attempts by outcome',
  labelNames: ['outcome'],
  registers: [register],
});

const payments = new client.Counter({
  name: 'payments_settled_total',
  help: 'Payment webhook outcomes',
  labelNames: ['status'],
  registers: [register],
});

const jobs = new client.Counter({
  name: 'jobs_processed_total',
  help: 'Background jobs by name and result',
  labelNames: ['name', 'result'],
  registers: [register],
});

const jobDuration = new client.Histogram({
  name: 'job_duration_seconds',
  help: 'Background job run time',
  labelNames: ['name'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15],
  registers: [register],
});

function trackDbPool(pool) {
  new client.Gauge({
    name: 'db_pool_connections',
    help: 'pg pool connections by state',
    labelNames: ['state'],
    registers: [register],
    collect() {
      this.set({ state: 'total' }, pool.totalCount);
      this.set({ state: 'idle' }, pool.idleCount);
      this.set({ state: 'waiting' }, pool.waitingCount);
    },
  });
}

module.exports = { register, httpDuration, dbDuration, bookings, payments, jobs, jobDuration, trackDbPool };
