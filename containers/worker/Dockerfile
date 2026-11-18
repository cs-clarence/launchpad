# Build from the repository root:
#   docker build -f containers/worker/Dockerfile -t launchpad/worker:dev .
#
# Runs as uid 10001 (the controller's uid: both use one data directory). It needs, at run time
# and not in the image: the data directory, SSH access to Dokku (a private key and a pinned
# known_hosts file), and a Docker engine it can reach, whose socket it must be allowed to use
# (give the container the socket's group). It holds no secret.
ARG BUN_VERSION=1.4.4
ARG DOCKER_CLI_VERSION=27

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter @launchpad/worker build

FROM docker:${DOCKER_CLI_VERSION}-cli AS docker-cli

FROM oven/bun:${BUN_VERSION}-slim AS runtime
ARG LAUNCHPAD_UID=10001
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid "${LAUNCHPAD_UID}" launchpad \
    && useradd --uid "${LAUNCHPAD_UID}" --gid launchpad --no-create-home --shell /usr/sbin/nologin launchpad \
    && install -d -o launchpad -g launchpad -m 0700 /data
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
ENV NODE_ENV=production LAUNCHPAD_DATA_DIR=/data
COPY --from=build --chown=root:root /app/apps/worker/dist ./dist
USER ${LAUNCHPAD_UID}:${LAUNCHPAD_UID}
VOLUME /data
CMD ["bun", "dist/index.js"]
