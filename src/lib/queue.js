const { Queue } = require('bullmq');
const Redis = require('ioredis');
const context = require('./context');

// one queue, job type in job.name. enough for our volume and keeps ops simple.
const QUEUE_NAME = 'amrutam-jobs';

const defaultJobOptions = {
  attempts: 5,
  // 2s, 4s, 8s, 16s ... bullmq adds no jitter so we keep attempts low
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 5000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

// bullmq wants its own connection with maxRetriesPerRequest = null
const bullConnection = (url) => new Redis(url, { maxRetriesPerRequest: null });

function createQueue(redisUrl, logger) {
  const connection = bullConnection(redisUrl);
  const queue = new Queue(QUEUE_NAME, { connection, defaultJobOptions });
  queue.on('error', (err) => logger.warn({ err: err.message }, 'queue error'));

  // enqueue failures shouldn't break the request that triggered them - the
  // sweeper job reconciles anything that was missed (see jobs/processors.js)
  async function enqueue(name, data, opts = {}) {
    try {
      // carry the trace id over so worker logs line up with the request
      await queue.add(name, { ...data, _trace: context.current().traceId }, opts);
    } catch (err) {
      logger.error({ err: err.message, job: name }, 'enqueue failed');
    }
  }

  // bullmq doesn't close connections it was handed, so quit ours explicitly
  const close = async () => {
    await queue.close();
    await connection.quit();
  };

  return { queue, enqueue, close };
}

module.exports = { createQueue, bullConnection, QUEUE_NAME };
