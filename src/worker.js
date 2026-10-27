// Background worker - run as its own process/container so slow jobs never
// compete with request handling. Scale it independently of the API.
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'amrutam-worker';

const http = require('http');
const { Worker } = require('bullmq');
const { createContainer } = require('./container');
const { bullConnection, QUEUE_NAME } = require('./lib/queue');
const { createProcessors, SCHEDULES } = require('./jobs/processors');
const context = require('./lib/context');
const metrics = require('./lib/metrics');

const METRICS_PORT = Number(process.env.WORKER_METRICS_PORT || 9464);

async function main() {
  const c = createContainer();
  const { config, logger, queue } = c;
  const processors = createProcessors(c);

  for (const s of SCHEDULES) {
    await queue.queue.upsertJobScheduler(s.id, { every: s.every }, { name: s.name });
  }

  const worker = new Worker(QUEUE_NAME, async (job) => {
    const handler = processors[job.name];
    if (!handler) throw new Error(`no processor for ${job.name}`);

    const traceId = job.data?._trace || context.newTraceId();
    const end = metrics.jobDuration.startTimer({ name: job.name });
    return context.run({ traceId, jobId: job.id }, async () => {
      try {
        const result = await handler(job.data);
        metrics.jobs.inc({ name: job.name, result: 'ok' });
        return result;
      } catch (err) {
        metrics.jobs.inc({ name: job.name, result: 'error' });
        throw err;
      } finally {
        end();
      }
    });
  }, {
    connection: bullConnection(config.redisUrl),
    concurrency: 10,
  });

  worker.on('completed', (job) => logger.debug({ job: job.name, id: job.id }, 'job done'));
  worker.on('failed', (job, err) => {
    const final = job && job.attemptsMade >= (job.opts.attempts || 1);
    logger[final ? 'error' : 'warn']({ job: job?.name, id: job?.id, attempt: job?.attemptsMade, err: err.message }, final ? 'job failed permanently' : 'job failed, will retry');
  });

  // prometheus scrape target + k8s liveness for the worker
  const metricsServer = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('content-type', metrics.register.contentType);
      return res.end(await metrics.register.metrics());
    }
    if (req.url === '/health') return res.end(worker.isRunning() ? 'ok' : 'down');
    res.statusCode = 404;
    res.end();
  }).listen(METRICS_PORT);

  logger.info({ schedules: SCHEDULES.map((s) => s.name), metricsPort: METRICS_PORT }, 'worker started');

  const shutdown = async () => {
    logger.info('worker shutting down');
    metricsServer.close();
    await worker.close(); // waits for running jobs
    await c.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
