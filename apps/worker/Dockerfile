# Build from the repository root with BuildKit (the default in current Docker; the classic builder
# ignores this recipe's own .dockerignore and would copy nothing):
#   docker build -f apps/worker/Dockerfile -t launchpad/worker:dev .
#
# Runs as uid 10001 (the controller's uid: both use one data directory). It needs, at run time
# and not in the image: the data directory, SSH access to Dokku (a private key and a pinned
# known_hosts file), and a Docker engine it can reach, whose socket it must be allowed to use
# (give the container the socket's group). It holds no secret.
#
# Two things to know when running it:
# - Access to the Docker socket is root-equivalent on that host. Run the worker only where that
#   is acceptable, and treat the data directory it shares with the controller as trusted.
# - Use a stop grace period of at least 30 seconds so cancellation reaches local subprocesses.
#   Stopping the worker does not prove an already dispatched Dokku operation stopped.
# - Mount the shared /data volume as described in the controller recipe. The base images are
#   pinned by tag and must be pinned by digest before a release. The `docker` client inside the
#   image has no buildx plugin, so the worker's `docker build` uses the classic
#   builder (a deprecation notice on stderr is expected).
ARG BUN_VERSION=1.4.4
ARG DOCKER_CLI_VERSION=28

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter @launchpad-kit/worker build

FROM docker:${DOCKER_CLI_VERSION}-cli AS docker-cli

FROM oven/bun:${BUN_VERSION}-slim AS runtime
ARG LAUNCHPAD_UID=10001
# The release version, recorded in backups and shown in the operator status. Pass it at build
# time (`--build-arg LAUNCHPAD_VERSION=<version>`); an image built without it reports `unknown`.
ARG LAUNCHPAD_VERSION=unknown
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid "${LAUNCHPAD_UID}" launchpad \
    && useradd --uid "${LAUNCHPAD_UID}" --gid launchpad --no-create-home --shell /usr/sbin/nologin launchpad \
    && install -d -o launchpad -g launchpad -m 0700 /data
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
ENV NODE_ENV=production LAUNCHPAD_DATA_DIR=/data LAUNCHPAD_VERSION=${LAUNCHPAD_VERSION} \
    LAUNCHPAD_WORKER_HEALTH_FILE=/tmp/launchpad-worker-health
COPY --from=build --chown=root:root /app/apps/worker/dist ./dist
USER ${LAUNCHPAD_UID}:${LAUNCHPAD_UID}
VOLUME /data
# Liveness only: the worker touches this file after a successful queue check or lease renewal (and
# while idle with deployments off). A stale file can also mean recovery is blocking writes.
# It does not prove that Dokku or Docker work. Needs a writable /tmp (a tmpfs on a read-only root).
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD test -n "$(find "$LAUNCHPAD_WORKER_HEALTH_FILE" -mmin -1 2>/dev/null)"
CMD ["bun", "dist/index.js"]
