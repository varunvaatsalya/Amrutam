const { createContainer } = require('./container');
const { createApp } = require('./app');

const container = createContainer();
const { config, logger } = container;
const app = createApp(container);

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'api listening');
});

// keep-alive slightly above typical LB idle timeout (60s) to avoid 502s
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  // stop taking new connections, let in-flight requests finish
  server.close(async () => {
    await container.close();
    logger.info('bye');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
