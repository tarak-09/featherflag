import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createLogger } from '../src/logger.js';
import { createMetrics } from '../src/metrics.js';
import { createApp } from '../src/server.js';
import { FlagStore } from '../src/store.js';

const silent = createLogger({ level: 'error', stream: { write() {} } });

const config = {
  port: 0,
  logLevel: 'error',
  environment: 'test',
  revision: 'test-revision',
  shutdownTimeoutMs: 0,
};

function startApp(store) {
  const app = createApp({ store, logger: silent, metrics: createMetrics(), config });
  return new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', () => {
      const { port } = app.server.address();
      resolve({ ...app, base: `http://127.0.0.1:${port}` });
    });
  });
}

describe('HTTP API', () => {
  let app;

  before(async () => {
    app = await startApp(
      FlagStore.fromDocument({
        flags: [
          { key: 'always-on', enabled: true, rolloutPercentage: 100 },
          { key: 'always-off', enabled: false },
          { key: 'half', enabled: true, rolloutPercentage: 50, exclude: ['blocked'] },
        ],
      }),
    );
  });

  after(() => new Promise((resolve) => app.server.close(resolve)));

  describe('GET /healthz', () => {
    it('reports the running revision', async () => {
      const res = await fetch(`${app.base}/healthz`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'ok');
      assert.equal(body.revision, 'test-revision');
    });
  });

  describe('GET /readyz', () => {
    it('is ready when flags are loaded', async () => {
      const res = await fetch(`${app.base}/readyz`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).flags, 3);
    });

    it('is not ready when the store is empty', async () => {
      const empty = await startApp(new FlagStore());
      try {
        const res = await fetch(`${empty.base}/readyz`);
        assert.equal(res.status, 503);
        assert.equal((await res.json()).reason, 'no flags loaded');
      } finally {
        await new Promise((resolve) => empty.server.close(resolve));
      }
    });

    it('fails readiness once shutdown begins, before the listener closes', async () => {
      const draining = await startApp(FlagStore.fromDocument([{ key: 'a', enabled: true }]));
      try {
        assert.equal((await fetch(`${draining.base}/readyz`)).status, 200);
        draining.beginShutdown();
        const res = await fetch(`${draining.base}/readyz`);
        assert.equal(res.status, 503);
        assert.equal((await res.json()).status, 'shutting_down');
      } finally {
        await new Promise((resolve) => draining.server.close(resolve));
      }
    });
  });

  describe('GET /flags', () => {
    it('lists flags in a stable order', async () => {
      const res = await fetch(`${app.base}/flags`);
      assert.equal(res.status, 200);
      const { flags } = await res.json();
      assert.deepEqual(flags.map((f) => f.key), ['always-off', 'always-on', 'half']);
    });
  });

  describe('GET /flags/:key/evaluate', () => {
    it('evaluates a flag for a subject', async () => {
      const res = await fetch(`${app.base}/flags/always-on/evaluate?subject=user-1`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.enabled, true);
      assert.equal(body.subject, 'user-1');
    });

    it('requires a subject', async () => {
      const res = await fetch(`${app.base}/flags/always-on/evaluate`);
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /subject/);
    });

    it('404s an unknown flag', async () => {
      const res = await fetch(`${app.base}/flags/nope/evaluate?subject=user-1`);
      assert.equal(res.status, 404);
    });

    it('honours exclusions', async () => {
      const res = await fetch(`${app.base}/flags/half/evaluate?subject=blocked`);
      assert.equal((await res.json()).enabled, false);
    });

    it('decodes URL-encoded subjects and keys', async () => {
      const res = await fetch(`${app.base}/flags/always-on/evaluate?subject=${encodeURIComponent('user@example.com')}`);
      assert.equal((await res.json()).subject, 'user@example.com');
    });

    it('is stable across repeated calls', async () => {
      const call = async () =>
        (await (await fetch(`${app.base}/flags/half/evaluate?subject=user-7`)).json()).enabled;
      const first = await call();
      for (let i = 0; i < 5; i += 1) {
        assert.equal(await call(), first);
      }
    });
  });

  describe('routing', () => {
    it('404s an unknown path', async () => {
      assert.equal((await fetch(`${app.base}/nope`)).status, 404);
    });

    it('405s a known path with the wrong method', async () => {
      const res = await fetch(`${app.base}/flags`, { method: 'POST' });
      assert.equal(res.status, 405);
      assert.match((await res.json()).error, /not allowed/);
    });

    it('labels a 405 with the route it matched, not "unmatched"', async () => {
      await fetch(`${app.base}/flags`, { method: 'DELETE' });
      const body = await (await fetch(`${app.base}/metrics`)).text();
      assert.match(body, /http_requests_total\{method="DELETE",route="\/flags",status="405"\}/);
    });

    it('echoes a supplied request id', async () => {
      const res = await fetch(`${app.base}/healthz`, { headers: { 'x-request-id': 'abc-123' } });
      assert.equal(res.headers.get('x-request-id'), 'abc-123');
    });

    it('generates a request id when none is supplied', async () => {
      const res = await fetch(`${app.base}/healthz`);
      assert.match(res.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    });
  });

  describe('GET /metrics', () => {
    it('exposes Prometheus text format', async () => {
      await fetch(`${app.base}/flags/always-on/evaluate?subject=user-1`);
      const res = await fetch(`${app.base}/metrics`);

      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/plain/);

      const body = await res.text();
      assert.match(body, /# TYPE http_requests_total counter/);
      assert.match(body, /flag_evaluations_total\{key="always-on",result="enabled"\}/);
      assert.match(body, /http_request_duration_seconds_bucket/);
    });

    it('labels by route pattern, not raw path', async () => {
      // Labelling by raw path would give every flag key its own time series
      // and eventually take out the scrape target.
      await fetch(`${app.base}/flags/half/evaluate?subject=a`);
      const body = await (await fetch(`${app.base}/metrics`)).text();

      assert.match(body, /route="\/flags\/:key\/evaluate"/);
      assert.doesNotMatch(body, /route="\/flags\/half\/evaluate"/);
    });
  });
});
