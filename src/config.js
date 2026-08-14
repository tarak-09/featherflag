/**
 * Configuration, resolved once at startup from the environment.
 *
 * Everything is validated here so a bad value fails the container immediately
 * rather than at the first request. In a container platform that restarts on
 * exit, a fast crash with a clear message is far easier to diagnose than a
 * service that starts and then misbehaves.
 */

class ConfigError extends Error {}

function readPort(env) {
  const raw = env.PORT ?? '8080';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

function readLogLevel(env) {
  const level = (env.LOG_LEVEL ?? 'info').toLowerCase();
  const valid = ['debug', 'info', 'warn', 'error'];
  if (!valid.includes(level)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${valid.join(', ')}, got ${JSON.stringify(level)}`);
  }
  return level;
}

function readShutdownTimeout(env) {
  const raw = env.SHUTDOWN_TIMEOUT_MS ?? '10000';
  const timeout = Number(raw);
  if (!Number.isInteger(timeout) || timeout < 0) {
    throw new ConfigError(`SHUTDOWN_TIMEOUT_MS must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return timeout;
}

export function loadConfig(env = process.env) {
  return {
    port: readPort(env),
    logLevel: readLogLevel(env),
    shutdownTimeoutMs: readShutdownTimeout(env),
    environment: env.NODE_ENV ?? 'development',
    // Injected by the CD pipeline so /healthz can report exactly what is running.
    revision: env.APP_REVISION ?? 'unknown',
  };
}

export { ConfigError };
