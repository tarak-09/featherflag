# syntax=docker/dockerfile:1

# Tests run inside the image so what ships is what was verified — a test stage
# that passes on the CI host but against different base-image libraries proves
# less than it appears to.
FROM node:22-alpine AS test
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test
COPY flags.json ./
RUN node --test

FROM node:22-alpine AS runtime

# There are no dependencies to install, so there is no node_modules layer and
# nothing to npm-audit at build time. Adding one should be a deliberate act.
WORKDIR /app

# Copied from the test stage rather than the build context, so the runtime image
# has a real dependency on the tests. BuildKit prunes stages nothing depends on,
# and a test stage referenced by nothing is silently skipped.
COPY --from=test --chown=node:node /app/package.json ./
COPY --from=test --chown=node:node /app/src ./src
COPY --from=test --chown=node:node /app/flags.json ./

# node:alpine ships an unprivileged `node` user. Running as root inside a
# container is a needless escalation path.
USER node

ENV NODE_ENV=production \
    PORT=8080 \
    LOG_LEVEL=info

EXPOSE 8080

# Container Apps and Kubernetes probe /readyz themselves, but this keeps
# `docker run` and Compose honest too.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so PID 1 is node itself and it receives SIGTERM directly. Shell
# form would put /bin/sh at PID 1, which does not forward signals, and the
# graceful shutdown path would never run.
CMD ["node", "src/index.js"]
