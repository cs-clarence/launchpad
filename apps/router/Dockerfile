# Build from the repository root with BuildKit (the default in current Docker; the classic builder
# ignores this recipe's own .dockerignore and would copy nothing):
#   docker build -f apps/router/Dockerfile -t launchpad/router:dev .
#
# The alias router: a private control plane and a public data plane over one durable routing state.
# It runs as uid 10001 and holds no secret except an optional 0600 database URL file for managed `rotate`: settings arrive as environment variables and the control
# token is supplied once to `init`/`rotate` on standard input or from a 0600 file (never an
# argument or the environment). At run time it needs:
# - a /state volume it owns (a named volume picks up the image's 0700 ownership; a bind-mounted
#   host directory must be owned by 10001:10001, mode 0700). Run exactly ONE router per state
#   directory: the process lock is a kernel file lock, not reliable on NFS or across hosts.
# - LAUNCHPAD_ROUTER_INSTANCE_ID, LAUNCHPAD_APPS_DOMAIN, LAUNCHPAD_ROUTER_CONTROL_LISTEN,
#   LAUNCHPAD_ROUTER_DATA_LISTEN and LAUNCHPAD_APPS_PROXY_URL (see apps/router/README.md). No port is
#   EXPOSEd: which addresses to bind and publish is the operator's choice. Inside a container the
#   control listener usually binds a private-network address and needs
#   LAUNCHPAD_ROUTER_CONTROL_PRIVATE_NETWORK=1.
#
# One-off commands reuse this image:
#   docker run --rm -i -v state:/state --env-file router.env launchpad/router:dev init --token-stdin
# The base image is pinned by tag and must be pinned by digest before a release.
ARG BUN_VERSION=1.4.4

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter @launchpad-kit/router build

FROM oven/bun:${BUN_VERSION}-slim AS runtime
ARG LAUNCHPAD_UID=10001
# The release version, recorded in the image. Pass it at build time
# (`--build-arg LAUNCHPAD_VERSION=<version>`); an image built without it reports `unknown`.
ARG LAUNCHPAD_VERSION=unknown
RUN groupadd --gid "${LAUNCHPAD_UID}" launchpad \
    && useradd --uid "${LAUNCHPAD_UID}" --gid launchpad --no-create-home --shell /usr/sbin/nologin launchpad \
    && install -d -o launchpad -g launchpad -m 0700 /state
WORKDIR /app
ENV NODE_ENV=production LAUNCHPAD_VERSION=${LAUNCHPAD_VERSION} \
    LAUNCHPAD_ROUTER_STATE_FILE=/state/routes.sqlite
COPY --from=build --chown=root:root /app/apps/router/dist ./dist
USER ${LAUNCHPAD_UID}:${LAUNCHPAD_UID}
VOLUME /state
# Liveness of the routing state only: the control listener answers /healthz when the store does. It
# does not prove that Dokku or the network work.
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD ["bun", "dist/index.js", "healthcheck"]
ENTRYPOINT ["bun", "dist/index.js"]
CMD ["serve"]
