/**
 * Structured JSON logging to stdout.
 *
 * One JSON object per line, no log files, no rotation: the container runtime
 * owns log collection, and anything written elsewhere is invisible to it.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = 'info', stream = process.stdout, base = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const write = (levelName, message, fields = {}) => {
    if (LEVELS[levelName] < threshold) return;

    const entry = {
      time: new Date().toISOString(),
      level: levelName,
      message,
      ...base,
      ...fields,
    };

    // Errors do not survive JSON.stringify — it produces {}.
    for (const [key, value] of Object.entries(entry)) {
      if (value instanceof Error) {
        entry[key] = { name: value.name, message: value.message, stack: value.stack };
      }
    }

    stream.write(`${JSON.stringify(entry)}\n`);
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (childFields) => createLogger({ level, stream, base: { ...base, ...childFields } }),
  };
}
