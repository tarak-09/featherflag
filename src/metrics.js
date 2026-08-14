/**
 * Prometheus metrics in the text exposition format.
 *
 * Hand-rolled rather than pulling in a client library: the service exposes four
 * metrics, and a dependency that ships a metrics registry, a clustering shim,
 * and default process collectors is a poor trade for that.
 *
 * Label values are escaped per the exposition format. Route labels use the
 * matched pattern (`/flags/:key/evaluate`), never the raw path — labelling by
 * raw path would give every flag key its own time series and eventually take
 * out the scrape target.
 */

const DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function serializeLabels(labels) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`;
}

export function createMetrics() {
  const counters = new Map();
  const histogram = new Map();
  const startedAt = Date.now();

  const counterKey = (name, labels) => `${name}${serializeLabels(labels)}`;

  const incrementCounter = (name, labels = {}, amount = 1) => {
    const key = counterKey(name, labels);
    const existing = counters.get(key);
    if (existing) {
      existing.value += amount;
    } else {
      counters.set(key, { name, labels, value: amount });
    }
  };

  const observeDuration = (labels, seconds) => {
    const key = counterKey('http_request_duration_seconds', labels);
    let entry = histogram.get(key);
    if (!entry) {
      entry = { labels, counts: new Array(DURATION_BUCKETS.length).fill(0), sum: 0, count: 0 };
      histogram.set(key, entry);
    }
    entry.sum += seconds;
    entry.count += 1;
    for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
      if (seconds <= DURATION_BUCKETS[i]) entry.counts[i] += 1;
    }
  };

  const render = () => {
    const lines = [];

    lines.push('# HELP featherflag_uptime_seconds Seconds since the process started.');
    lines.push('# TYPE featherflag_uptime_seconds gauge');
    lines.push(`featherflag_uptime_seconds ${((Date.now() - startedAt) / 1000).toFixed(3)}`);

    const byName = new Map();
    for (const entry of counters.values()) {
      if (!byName.has(entry.name)) byName.set(entry.name, []);
      byName.get(entry.name).push(entry);
    }

    const help = {
      http_requests_total: 'Total HTTP requests, by method, route, and status code.',
      flag_evaluations_total: 'Total flag evaluations, by flag key and outcome.',
      flag_evaluation_errors_total: 'Evaluations rejected because the flag does not exist.',
    };

    for (const [name, entries] of byName) {
      if (help[name]) lines.push(`# HELP ${name} ${help[name]}`);
      lines.push(`# TYPE ${name} counter`);
      for (const entry of entries) {
        lines.push(`${name}${serializeLabels(entry.labels)} ${entry.value}`);
      }
    }

    if (histogram.size > 0) {
      lines.push('# HELP http_request_duration_seconds Request duration in seconds.');
      lines.push('# TYPE http_request_duration_seconds histogram');
      for (const entry of histogram.values()) {
        DURATION_BUCKETS.forEach((bound, i) => {
          lines.push(
            `http_request_duration_seconds_bucket${serializeLabels({ ...entry.labels, le: bound })} ${entry.counts[i]}`,
          );
        });
        lines.push(
          `http_request_duration_seconds_bucket${serializeLabels({ ...entry.labels, le: '+Inf' })} ${entry.count}`,
        );
        lines.push(
          `http_request_duration_seconds_sum${serializeLabels(entry.labels)} ${entry.sum.toFixed(6)}`,
        );
        lines.push(`http_request_duration_seconds_count${serializeLabels(entry.labels)} ${entry.count}`);
      }
    }

    return `${lines.join('\n')}\n`;
  };

  return { incrementCounter, observeDuration, render };
}
