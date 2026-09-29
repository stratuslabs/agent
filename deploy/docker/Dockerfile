# stratusd, built from this checkout. Build from the repository root:
#
#   docker build -f deploy/docker/Dockerfile -t stratusd .                    # slim (default)
#   docker build -f deploy/docker/Dockerfile --target browser -t stratusd .   # + Chromium for tool-browser
#
# Or `docker compose up -d` from deploy/docker. The recipe around it — the
# volume, credentials, logs, backups, upgrades, hardening — is
# docs/guides/deployment.md.
#
# Behind a TLS-intercepting proxy, hand the build its CA as a BuildKit
# secret: `--secret id=build_ca,src=/path/to/ca.pem` (and the usual
# HTTPS_PROXY/NO_PROXY build args). Neither is written into any layer, and
# without them nothing changes.

ARG NODE_IMAGE=node:22-bookworm-slim

# --- builder: install, build, and pack every publishable package ----------
FROM ${NODE_IMAGE} AS builder
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
# pnpm at exactly the version the root package.json's packageManager names:
# a different pnpm can read the same lockfile differently.
RUN corepack enable
WORKDIR /src
# The lockfile alone first, so a source change does not refetch every
# dependency: `pnpm fetch` fills the store from the lockfile, and the install
# after the copy is offline.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm build
RUN node deploy/docker/pack.mjs /src /packs

# --- install: the tarballs, flat, the way a global install lays them out ---
FROM ${NODE_IMAGE} AS install
WORKDIR /opt/stratus
COPY --from=builder /packs ./packs
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    mv packs/package.json . \
    && npm install --omit=dev --no-audit --no-fund \
    && rm -rf packs /root/.npm

# --- runtime ---------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
COPY --from=install /opt/stratus /opt/stratus
# `stratus` on PATH for the CMD, the health check, and `docker exec`.
ENV PATH=/opt/stratus/node_modules/.bin:$PATH \
    HOME=/home/node
# The node image's own unprivileged user (uid 1000). The home directory is
# created here, owned by it, so a fresh named volume mounted over it copies
# that ownership and mode instead of arriving root-owned.
RUN mkdir -p /home/node/.stratus \
    && chown node:node /home/node/.stratus \
    && chmod 0700 /home/node/.stratus
USER node
WORKDIR /home/node
# Everything stratusd keeps: config, credentials, souls, sessions, memory,
# logs. docs/reference/state-layout.md is the map.
VOLUME ["/home/node/.stratus"]
EXPOSE 4123
# No shell between Docker and the daemon. The node image's entrypoint is a
# POSIX sh script, and sh drops every environment variable whose name is not
# a shell identifier on its way to exec — which is every named credential an
# env file sets (`search.apiKey`). The daemon handles its own signals, and
# `--init` reaps what its children leave behind.
ENTRYPOINT []
# The daemon drains on SIGTERM for up to 30 seconds. Give `docker stop` more
# than that (`-t 45`, or compose's stop_grace_period) or the drain is cut
# short by SIGKILL.
STOPSIGNAL SIGTERM
# Asks the running daemon over its own API, with the token it wrote — so
# "healthy" means serving, not merely a live process.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["stratus", "health"]
# --api-host 0.0.0.0 so a published port can reach it: inside the container
# loopback is the container's own. Publish it on the host's loopback only
# (`-p 127.0.0.1:4123:4123`) — see the hardening checklist. --log-format
# json makes stdout the structured log for `docker logs` and log drivers.
# Run with `--init` (compose: `init: true`) so the shell tool's orphaned
# grandchildren are reaped.
CMD ["stratus", "serve", "--api-host", "0.0.0.0", "--log-format", "json"]

# --- browser: + Chromium and its system libraries, for tool-browser --------
FROM runtime AS browser
USER root
# Outside the home on purpose: the browser is part of the image, read-only
# at runtime, and not something a backup of the volume should carry.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# playwright-core's own installer, from the copy tool-browser depends on, so
# the browser build is the one that playwright-core version drives.
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    node /opt/stratus/node_modules/playwright-core/cli.js install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm
USER node

# --- slim: the default target ----------------------------------------------
FROM runtime AS slim
