import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults for an empty environment', () => {
    const config = loadConfig({});
    assert.equal(config.port, 8080);
    assert.equal(config.logLevel, 'info');
    assert.equal(config.shutdownTimeoutMs, 10000);
    assert.equal(config.revision, 'unknown');
  });

  it('reads values from the environment', () => {
    const config = loadConfig({
      PORT: '3000',
      LOG_LEVEL: 'DEBUG',
      SHUTDOWN_TIMEOUT_MS: '5000',
      NODE_ENV: 'production',
      APP_REVISION: 'abc123',
    });
    assert.equal(config.port, 3000);
    assert.equal(config.logLevel, 'debug');
    assert.equal(config.shutdownTimeoutMs, 5000);
    assert.equal(config.environment, 'production');
    assert.equal(config.revision, 'abc123');
  });

  it('rejects a non-numeric port', () => {
    assert.throws(() => loadConfig({ PORT: 'http' }), ConfigError);
  });

  it('rejects an out-of-range port', () => {
    assert.throws(() => loadConfig({ PORT: '0' }), ConfigError);
    assert.throws(() => loadConfig({ PORT: '70000' }), ConfigError);
  });

  it('rejects a fractional port', () => {
    // Number('8080.5') parses happily; without the integer check this would
    // reach listen() and fail far less clearly.
    assert.throws(() => loadConfig({ PORT: '8080.5' }), ConfigError);
  });

  it('rejects an unknown log level', () => {
    assert.throws(() => loadConfig({ LOG_LEVEL: 'verbose' }), ConfigError);
  });

  it('rejects a negative shutdown timeout', () => {
    assert.throws(() => loadConfig({ SHUTDOWN_TIMEOUT_MS: '-1' }), ConfigError);
  });

  it('names the offending variable in the message', () => {
    assert.throws(() => loadConfig({ PORT: 'nope' }), /PORT/);
  });
});
