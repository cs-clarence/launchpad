ARG DOKKU_VERSION=0.38.34
# Index digest of dokku/dokku:0.38.34, verified with `docker buildx imagetools inspect` on 2026-11-21.
ARG DOKKU_DIGEST=sha256:70c09c7f5badff1b0a7077fe899db269255a22aed08571f4da605bfcb50fd8a8
# dokku-http-auth master at 9c3e2636eda583ac667fbdca2b565b3dd6e8107e (committed 2026-11-09), read from
# `git ls-remote https://github.com/dokku/dokku-http-auth.git` on 2026-11-21. The upstream has no
# release tag newer than 0.14.1; change the commit only after reviewing the upstream diff.
ARG DOKKU_HTTP_AUTH_COMMIT=9c3e2636eda583ac667fbdca2b565b3dd6e8107e
# Build from the repository root (the licence files are in its context):
#   docker build -f containers/dokku/Dockerfile -t launchpad/dokku:dev .
FROM dokku/dokku:${DOKKU_VERSION}@${DOKKU_DIGEST}
ARG DOKKU_HTTP_AUTH_COMMIT
# OCI labels: the release build supplies the version, commit and time (`--build-arg`); a local build
# leaves them `unknown` or empty.
ARG LAUNCHPAD_VERSION=unknown
ARG LAUNCHPAD_REVISION=
ARG LAUNCHPAD_CREATED=
LABEL org.opencontainers.image.title="Launchpad Dokku" \
      org.opencontainers.image.description="Dokku with the http-auth plugin, as the Launchpad stack runs it" \
      org.opencontainers.image.source="https://github.com/launchpad-kit/launchpad" \
      org.opencontainers.image.url="https://github.com/launchpad-kit/launchpad" \
      org.opencontainers.image.documentation="https://github.com/launchpad-kit/launchpad/tree/main/docs" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${LAUNCHPAD_VERSION}" \
      org.opencontainers.image.revision="${LAUNCHPAD_REVISION}" \
      org.opencontainers.image.created="${LAUNCHPAD_CREATED}"

# Launchpad's licence and the notices for what the image contains (Dokku and its base are covered
# in THIRD_PARTY_NOTICES.md).
COPY LICENSE THIRD_PARTY_NOTICES.md /licenses/

# Defer plugin install triggers until Dokku starts.
RUN dokku plugin:install https://github.com/dokku/dokku-http-auth.git --committish "${DOKKU_HTTP_AUTH_COMMIT}" --skip-install-trigger
