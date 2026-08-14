/**
 * HTTP surface.
 *
 * Built on node:http with no framework. The routing table is five entries; a
 * framework would add a dependency tree larger than the service for the benefit
 * of a shorter route file.
 */

import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import { evaluate } from './evaluate.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...JSON_HEADERS,
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res, status, message, details) {
  sendJson(res, status, { error: message, ...(details ? { details } : {}) });
}

/**
 * Match a pathname against the route table, returning the handler and any
 * captured parameters. Returns the route pattern too, so metrics can be
 * labelled by pattern rather than by raw path.
 */
function matchRoute(routes, method, pathname) {
  const segments = pathname.split('/').filter(Boolean);
  let pathMatched = null;

  for (const route of routes) {
    if (route.segments.length !== segments.length) continue;

    const params = {};
    const matches = route.segments.every((segment, i) => {
      if (segment.startsWith(':')) {
        params[segment.slice(1)] = decodeURIComponent(segments[i]);
        return true;
      }
      return segment === segments[i];
    });

    if (!matches) continue;
    // Keep the first matching pattern so a 405 is still labelled with the route
    // it matched, rather than being lumped in with genuinely unknown paths.
    pathMatched = pathMatched ?? route;
    if (route.method === method) return { route, params };
  }

  // Distinguishing 405 from 404 tells a caller whether the URL is wrong or the
  // verb is.
  return pathMatched ? { route: pathMatched, methodNotAllowed: true } : null;
}

export function createApp({ store, logger, metrics, config }) {
  const routes = [
    {
      method: 'GET',
      pattern: '/healthz',
      handler: (req, res) => {
        sendJson(res, 200, {
          status: 'ok',
          revision: config.revision,
          environment: config.environment,
          uptimeSeconds: Math.floor(process.uptime()),
        });
      },
    },
    {
      method: 'GET',
      pattern: '/readyz',
      handler: (req, res, ctx) => {
        // Readiness is about dependencies, not liveness. With flags loaded at
        // startup, an empty store means the load failed and this replica should
        // not receive traffic.
        if (ctx.shuttingDown()) {
          return sendJson(res, 503, { status: 'shutting_down' });
        }
        if (store.size === 0) {
          return sendJson(res, 503, { status: 'not_ready', reason: 'no flags loaded' });
        }
        return sendJson(res, 200, { status: 'ready', flags: store.size });
      },
    },
    {
      method: 'GET',
      pattern: '/metrics',
      handler: (req, res) => {
        const body = metrics.render();
        res.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
      },
    },
    {
      method: 'GET',
      pattern: '/flags',
      handler: (req, res) => {
        sendJson(res, 200, { flags: store.list() });
      },
    },
    {
      method: 'GET',
      pattern: '/flags/:key/evaluate',
      handler: (req, res, ctx) => {
        const { key } = ctx.params;
        const subject = ctx.url.searchParams.get('subject');

        if (!subject) {
          return sendError(res, 400, "query parameter 'subject' is required");
        }

        const flag = store.get(key);
        if (!flag) {
          metrics.incrementCounter('flag_evaluation_errors_total', { key });
          return sendError(res, 404, `unknown flag '${key}'`);
        }

        const result = evaluate(flag, subject);
        metrics.incrementCounter('flag_evaluations_total', {
          key,
          result: result.enabled ? 'enabled' : 'disabled',
        });

        return sendJson(res, 200, { ...result, subject });
      },
    },
  ].map((route) => ({ ...route, segments: route.pattern.split('/').filter(Boolean) }));

  let shuttingDown = false;

  const handler = (req, res) => {
    const startedAt = process.hrtime.bigint();
    const requestId = req.headers['x-request-id'] ?? randomUUID();
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    res.setHeader('x-request-id', requestId);

    const match = matchRoute(routes, req.method, url.pathname);
    const routeLabel = match?.route?.pattern ?? 'unmatched';

    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const labels = { method: req.method, route: routeLabel, status: res.statusCode };
      metrics.incrementCounter('http_requests_total', labels);
      metrics.observeDuration({ method: req.method, route: routeLabel }, seconds);

      // Health and metrics endpoints are polled constantly; logging them at
      // info would bury everything else.
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
      logger[level]('request', {
        requestId,
        method: req.method,
        path: url.pathname,
        route: routeLabel,
        status: res.statusCode,
        durationMs: Number((seconds * 1000).toFixed(3)),
      });
    });

    try {
      if (!match) {
        return sendError(res, 404, `no route for ${req.method} ${url.pathname}`);
      }
      if (match.methodNotAllowed) {
        return sendError(res, 405, `method ${req.method} not allowed for ${url.pathname}`);
      }

      return match.route.handler(req, res, {
        params: match.params,
        url,
        requestId,
        shuttingDown: () => shuttingDown,
      });
    } catch (error) {
      logger.error('unhandled request error', { requestId, error });
      if (!res.headersSent) {
        return sendError(res, 500, 'internal server error');
      }
      return res.end();
    }
  };

  const server = createHttpServer(handler);

  return {
    server,
    handler,
    beginShutdown: () => {
      shuttingDown = true;
    },
  };
}
