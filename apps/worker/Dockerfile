# Build from the repository root with BuildKit (the default in current Docker; the classic builder
# ignores this recipe's own .dockerignore and would copy nothing):
#   docker build -f apps/worker/Dockerfile -t launchpad/worker:dev .
#
# Runs as uid 10001 (the controller's uid: both use one data directory). It needs, at run time
# and not in the image: the data directory, SSH access to Dokku (a private key and a pinned
# known_hosts file), and a Docker engine it can reach, whose socket it must be allowed to use
# (give the container the socket's group). It holds no secret; an enabled alias worker reads a router token and epoch from mounted files.
#
# Two things to know when running it:
# - Access to the Docker socket is root-equivalent on that host. Run the worker only where that
#   is acceptable, and treat the data directory it shares with the controller as trusted.
# - Use a stop grace period of at least 30 seconds so cancellation reaches local subprocesses.
#   Stopping the worker does not prove an already dispatched Dokku operation stopped.
# - Mount the shared /data volume as described in the controller recipe. The base images are
#   pinned by tag and digest. The `docker` client inside the
#   image has no buildx plugin, so the worker's `docker build` uses the classic
#   builder (a deprecation notice on stderr is expected).
ARG BUN_VERSION=1.4.4
# Index digests verified with `docker buildx imagetools inspect` on 2026-11-21; change them with the tag.
ARG BUN_DIGEST=sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
ARG BUN_SLIM_DIGEST=sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
ARG DOCKER_CLI_VERSION=28
ARG DOCKER_CLI_DIGEST=sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d

FROM oven/bun:${BUN_VERSION}@${BUN_DIGEST} AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter @launchpad-kit/worker build

FROM docker:${DOCKER_CLI_VERSION}-cli@${DOCKER_CLI_DIGEST} AS docker-cli

FROM oven/bun:${BUN_VERSION}-slim@${BUN_SLIM_DIGEST} AS runtime
ARG LAUNCHPAD_UID=10001
# The release version, recorded in backups and shown in the operator status. Pass it at build
# time (`--build-arg LAUNCHPAD_VERSION=<version>`); an image built without it reports `unknown`.
ARG LAUNCHPAD_VERSION=unknown
# OCI metadata, supplied by the release build (`--build-arg LAUNCHPAD_REVISION=<commit>`,
# `--build-arg LAUNCHPAD_CREATED=<RFC 3339 time>`); the version label is LAUNCHPAD_VERSION. Empty or
# `unknown` in a local build.
ARG LAUNCHPAD_REVISION=
ARG LAUNCHPAD_CREATED=
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
# Licence and third-party notices (root-owned, read-only to the service user).
COPY --from=build --chown=root:root /app/LICENSE /app/THIRD_PARTY_NOTICES.md /licenses/
COPY --from=build --chown=root:root /app/apps/worker/dist ./dist
LABEL org.opencontainers.image.title="Launchpad worker" \
      org.opencontainers.image.description="Launchpad worker: builds and deploys uploaded sites through Dokku" \
      org.opencontainers.image.source="https://github.com/launchpad-kit/launchpad" \
      org.opencontainers.image.url="https://github.com/launchpad-kit/launchpad" \
      org.opencontainers.image.documentation="https://github.com/launchpad-kit/launchpad/tree/main/docs" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${LAUNCHPAD_VERSION}" \
      org.opencontainers.image.revision="${LAUNCHPAD_REVISION}" \
      org.opencontainers.image.created="${LAUNCHPAD_CREATED}"
USER ${LAUNCHPAD_UID}:${LAUNCHPAD_UID}
VOLUME /data
# Liveness only: the worker touches this file after a successful queue check or lease renewal (and
# while idle with deployments off). A stale file can also mean recovery is blocking writes.
# It does not prove that Dokku or Docker work. Needs a writable /tmp (a tmpfs on a read-only root).
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD test -n "$(find "$LAUNCHPAD_WORKER_HEALTH_FILE" -mmin -1 2>/dev/null)"
CMD ["bun", "dist/index.js"]
