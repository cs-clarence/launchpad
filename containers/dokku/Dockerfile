ARG DOKKU_VERSION=0.38.34
# Index digest of dokku/dokku:0.38.34, verified with `docker buildx imagetools inspect` on 2026-11-21.
ARG DOKKU_DIGEST=sha256:70c09c7f5badff1b0a7077fe899db269255a22aed08571f4da605bfcb50fd8a8
# dokku-http-auth master at 9c3e2636eda583ac667fbdca2b565b3dd6e8107e (committed 2026-11-09), read from
# `git ls-remote https://github.com/dokku/dokku-http-auth.git` on 2026-11-21. The upstream has no
# release tag newer than 0.14.1; change the commit only after reviewing the upstream diff.
ARG DOKKU_HTTP_AUTH_COMMIT=9c3e2636eda583ac667fbdca2b565b3dd6e8107e
FROM dokku/dokku:${DOKKU_VERSION}@${DOKKU_DIGEST}
ARG DOKKU_HTTP_AUTH_COMMIT

# Defer plugin install triggers until Dokku starts.
RUN dokku plugin:install https://github.com/dokku/dokku-http-auth.git --committish "${DOKKU_HTTP_AUTH_COMMIT}" --skip-install-trigger
