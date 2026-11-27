# Build from the repository root with BuildKit (the default in current Docker; the classic builder
# ignores this recipe's own .dockerignore and would copy nothing):
#   docker build -f apps/controller/Dockerfile -t launchpad/controller:dev .
#
# Runs as an unprivileged user (uid 10001, the same as the worker image: the two share one data
# directory). Holds no secret: every setting arrives at run time. The operator commands are in
# the image too: `bun .output/admin.mjs migrate` (run it before the first start, and after an
# upgrade once you have taken a backup).
#
# /data must be shared with the worker: mount the same volume in both (a named volume picks up
# the image's ownership; a bind-mounted host directory must be owned by 10001:10001 and mode
# 0700). Without a mount each container gets its own anonymous volume. The base images are
# pinned by tag and digest. The default build is the
# controller; `--target admin` builds the one-off operator image with the PostgreSQL client tools.
ARG BUN_VERSION=1.4.4
# Index digests verified with `docker buildx imagetools inspect` on 2026-11-21; change them with the tag.
ARG BUN_DIGEST=sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
ARG BUN_SLIM_DIGEST=sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

FROM oven/bun:${BUN_VERSION}@${BUN_DIGEST} AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter @launchpad-kit/controller build

FROM oven/bun:${BUN_VERSION}-slim@${BUN_SLIM_DIGEST} AS base
ARG LAUNCHPAD_UID=10001
# The release version, recorded in backups and shown in the operator status. Pass it at build
# time (`--build-arg LAUNCHPAD_VERSION=<version>`); an image built without it reports `unknown`.
ARG LAUNCHPAD_VERSION=unknown
# openssh-client: `check-restore` asks Dokku over SSH.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid "${LAUNCHPAD_UID}" launchpad \
    && useradd --uid "${LAUNCHPAD_UID}" --gid launchpad --no-create-home --shell /usr/sbin/nologin launchpad \
    && install -d -o launchpad -g launchpad -m 0700 /data
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 LAUNCHPAD_DATA_DIR=/data LAUNCHPAD_VERSION=${LAUNCHPAD_VERSION}
# Licence and third-party notices (root-owned, read-only to the service user).
COPY --from=build --chown=root:root /app/LICENSE /app/THIRD_PARTY_NOTICES.md /licenses/
# Owned by root and read-only to the service user: the program cannot rewrite itself.
COPY --from=build --chown=root:root /app/apps/controller/.output ./.output
USER ${LAUNCHPAD_UID}:${LAUNCHPAD_UID}
VOLUME /data

# The operator image: the same program and user, plus PostgreSQL 17 client tools (`pg_dump`,
# `pg_restore`) that `backup` and `restore` need and the controller image does not carry. Run it
# one-off, never as a service: `docker run --rm <image> migrate --status`. Its entry point is the
# admin command. Build it with `--target admin`.
FROM base AS admin
ARG LAUNCHPAD_UID=10001
# OCI labels: the release build supplies the version, commit and time (`--build-arg`); a local build
# leaves them `unknown` or empty.
ARG LAUNCHPAD_VERSION=unknown
ARG LAUNCHPAD_REVISION=
ARG LAUNCHPAD_CREATED=
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*
USER ${LAUNCHPAD_UID}:${LAUNCHPAD_UID}
LABEL org.opencontainers.image.title="Launchpad admin" \
      org.opencontainers.image.description="One-off operator commands for Launchpad (migrate, backup, restore) with PostgreSQL 17 client tools" \
      org.opencontainers.image.source="https://github.com/launchpad-kit/launchpad" \
      org.opencontainers.image.url="https://github.com/launchpad-kit/launchpad" \
      org.opencontainers.image.documentation="https://github.com/launchpad-kit/launchpad/tree/main/docs" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${LAUNCHPAD_VERSION}" \
      org.opencontainers.image.revision="${LAUNCHPAD_REVISION}" \
      org.opencontainers.image.created="${LAUNCHPAD_CREATED}"
ENTRYPOINT ["bun", ".output/admin.mjs"]
CMD ["--help"]

# The controller image is the last stage, so a build without `--target` produces it.
FROM base AS runtime
ARG LAUNCHPAD_VERSION=unknown
ARG LAUNCHPAD_REVISION=
ARG LAUNCHPAD_CREATED=
EXPOSE 3000
LABEL org.opencontainers.image.title="Launchpad controller" \
      org.opencontainers.image.description="Launchpad controller: the management API and dashboard" \
      org.opencontainers.image.source="https://github.com/launchpad-kit/launchpad" \
      org.opencontainers.image.url="https://github.com/launchpad-kit/launchpad" \
      org.opencontainers.image.documentation="https://github.com/launchpad-kit/launchpad/tree/main/docs" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${LAUNCHPAD_VERSION}" \
      org.opencontainers.image.revision="${LAUNCHPAD_REVISION}" \
      org.opencontainers.image.created="${LAUNCHPAD_CREATED}"
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["bun", ".output/server/index.mjs"]
