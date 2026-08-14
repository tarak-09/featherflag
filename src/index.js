/**
 * Process entry point: wire everything together, then shut down cleanly.
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { loadConfig, ConfigError } from './config.js';
import { createLogger } from './logger.js';
import { createMetrics } from './metrics.js';
import { createApp } from './server.js';
import { FlagStore, FlagValidationError } from './store.js';

const FLAGS_PATH = process.env.FLAGS_PATH ?? new URL('../flags.json', import.meta.url).pathname;

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`configuration error: ${error.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  const logger = createLogger({ level: config.logLevel, base: { revision: config.revision } });
  const metrics = createMetrics();

  let store;
  try {
    store = FlagStore.fromDocument(await readFile(FLAGS_PATH, 'utf8'));
  } catch (error) {
    const reason = error instanceof FlagValidationError || error instanceof SyntaxError
      ? `invalid flag document at ${FLAGS_PATH}: ${error.message}`
      : `could not read ${FLAGS_PATH}: ${error.message}`;
    logger.error('failed to load flags', { reason });
    process.exit(78);
  }

  const { server, beginShutdown } = createApp({ store, logger, metrics, config });

  server.listen(config.port, () => {
    logger.info('listening', {
      port: config.port,
      environment: config.environment,
      flags: store.size,
    });
  });

  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Fail readiness first so the load balancer stops sending new requests,
    // then drain. Closing the listener immediately would reject in-flight
    // traffic that has already been routed here.
    beginShutdown();
    logger.info('shutting down', { signal });

    const forceExit = setTimeout(() => {
      logger.warn('shutdown timed out, exiting', { timeoutMs: config.shutdownTimeoutMs });
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExit.unref();

    server.close((error) => {
      if (error) {
        logger.error('error during shutdown', { error });
        process.exit(1);
      }
      logger.info('shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { error: reason instanceof Error ? reason : new Error(String(reason)) });
    process.exit(1);
  });
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error?.stack ?? error}\n`);
  process.exit(1);
});
