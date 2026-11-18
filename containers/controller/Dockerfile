# Build from the repository root (the context is the whole monorepo):
#   docker build -f containers/controller/Dockerfile -t launchpad/controller:dev .
#
# Runs as an unprivileged user (uid 10001, the same as the worker image: the two share one data
# directory). Holds no secret: every setting arrives at run time. The operator commands are in
# the image too: `bun .output/admin.mjs migrate` (run it before the first start, and after an
# upgrade once you have taken a backup).
#
# /data must be shared with the worker: mount the same volume in both (a named volume picks up
# the image's ownership; a bind-mounted host directory must be owned by 10001:10001 and mode
# 0700). Without a mount each container gets its own anonymous volume. The base images are
# pinned by tag here and must be pinned by digest before a release.
ARG BUN_VERSION=1.4.4

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter @launchpad/controller build

FROM oven/bun:${BUN_VERSION}-slim AS runtime
ARG LAUNCHPAD_UID=10001
RUN groupadd --gid "${LAUNCHPAD_UID}" launchpad \
    && useradd --uid "${LAUNCHPAD_UID}" --gid launchpad --no-create-home --shell /usr/sbin/nologin launchpad \
    && install -d -o launchpad -g launchpad -m 0700 /data
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 LAUNCHPAD_DATA_DIR=/data
# Owned by root and read-only to the service user: the program cannot rewrite itself.
COPY --from=build --chown=root:root /app/apps/controller/.output ./.output
USER ${LAUNCHPAD_UID}:${LAUNCHPAD_UID}
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["bun", ".output/server/index.mjs"]
