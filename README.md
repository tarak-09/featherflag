# featherflag

A small feature flag service, built to be operated: deterministic percentage
rollouts, structured logs, Prometheus metrics, real health and readiness
semantics, and a container that shuts down cleanly.

Zero runtime dependencies. The `package.json` has no `dependencies` block at all.

```console
$ curl -s localhost:8080/flags/new-checkout/evaluate?subject=user-1042 | jq
{
  "key": "new-checkout",
  "enabled": true,
  "reason": "included",
  "subject": "user-1042"
}
```

## Why it's built this way

Feature flag services are a good excuse to get the operational details right, because
the logic is simple enough that nothing hides behind it.

**Evaluation is pure and deterministic.** The same flag and subject always produce the
same answer, on every replica, with no coordination and no shared state. A user who sees
a feature on one request must not lose it on the next because a different pod answered.

**The flag key is part of the hash.** Bucketing on the subject alone would put the same
unlucky users outside every rollout forever. Hashing `"${flagKey}:${subject}"` makes each
flag's population independent.

**Growing a rollout never takes the feature away.** Because a subject's bucket is fixed
and the comparison is `bucket < percentage`, ramping 5% → 25% → 100% only ever adds
users. There's a test asserting exactly that, across 500 subjects at every step.

**Exclusions beat everything.** An explicit "not this user" is usually someone
mid-incident, so it wins over inclusion lists and over a 100% rollout.

## Endpoints

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/healthz` | Liveness. Reports the running git SHA. |
| GET | `/readyz` | Readiness. 503 while draining or if no flags loaded. |
| GET | `/metrics` | Prometheus text format. |
| GET | `/flags` | List all flags. |
| GET | `/flags/:key/evaluate?subject=X` | Evaluate one flag for one subject. |

### Health vs readiness

These are different questions and are wired to different probes.

`/healthz` asks "is this process wedged?" and reports on nothing but itself. Liveness
restarts the container when it fails, so making it depend on a downstream service would
restart perfectly healthy containers whenever that service had a bad minute.

`/readyz` asks "should this replica receive traffic?" It returns 503 as soon as shutdown
begins — before the listener closes — so the load balancer stops sending new requests
while in-flight ones finish. It also fails if no flags loaded, because a replica with an
empty store would answer every evaluation with a 404.

## Configuration

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `PORT` | `8080` | |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | `development` | |
| `APP_REVISION` | `unknown` | Git SHA, injected by CD and reported by `/healthz` |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Grace period before a forced exit |
| `FLAGS_PATH` | `./flags.json` | Flag document location |

Every value is validated at startup, and a bad one exits `78` (`EX_CONFIG`) with a
message naming the variable. In a platform that restarts on exit, a fast crash is much
easier to diagnose than a service that starts and then misbehaves.

## Flag document

```json
{
  "flags": [
    {
      "key": "new-checkout",
      "enabled": true,
      "rolloutPercentage": 25,
      "include": ["qa-team", "user-1042"],
      "exclude": ["user-9001"],
      "description": "Rebuilt checkout flow. Ramping 5% -> 25% -> 100%."
    }
  ]
}
```

Validated on load: unknown fields, malformed keys, out-of-range percentages, duplicate
keys, and subjects listed in both `include` and `exclude` are all rejected with the
offending index. That last one matters — exclude would win, so the include is dead
configuration that reads as though it does something.

## Running it

```bash
node src/index.js          # locally
npm test                   # 61 tests, no dependencies to install

docker build -t featherflag .
docker run -p 8080:8080 -e APP_REVISION=$(git rev-parse HEAD) featherflag
```

## Container notes

**Tests run inside the image build.** The runtime stage copies its files *from* the test
stage, which is what forces the tests to run — BuildKit prunes stages nothing depends on,
so a test stage referenced by nothing is silently skipped and the build goes green
without running anything.

**`CMD` is exec form, deliberately.** Shell form puts `/bin/sh` at PID 1, which does not
forward signals, so `SIGTERM` never reaches node and the graceful shutdown path never
runs. Every deploy would then drop in-flight requests.

**Runs as the unprivileged `node` user**, with a `HEALTHCHECK` hitting `/readyz`.

## Deploying

[`infra/main.bicep`](infra/main.bicep) provisions a Log Analytics workspace, a Container
Apps environment, and the container app itself with liveness and readiness probes wired
to the right endpoints and HTTP-concurrency autoscaling.

The [CD workflow](.github/workflows/cd.yml) builds, pushes to GHCR, deploys, and then
polls `/healthz` until it reports the SHA that was just deployed. Without that last step
a deploy reports success the moment ARM returns, while the old revision is still serving
traffic.

Images are tagged `sha-<commit>`, never `latest`. A mutable tag makes it impossible to
say what is actually running and breaks rollback.

Azure auth uses OIDC federated credentials, so there is no client secret stored in GitHub
to leak or rotate.

### One-time setup

```bash
az group create -n rg-featherflag-dev -l eastus
```

Then set repository variables `AZURE_RESOURCE_GROUP`, `OWNER_EMAIL`, `COST_CENTER`, and
secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, with a federated
identity credential on the app registration scoped to this repo.

## What's deliberately missing

No persistence, no admin API, no auth. Flags are read from a file at startup, so changing
one is a redeploy. That is a real limitation, and the honest boundary of what this is: the
evaluation logic and the operational surface are the parts worth getting right, and
they're separate modules precisely so a backing store could be added without touching
evaluation.

## License

MIT
