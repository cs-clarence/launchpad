ARG DOKKU_VERSION=0.38.34
FROM dokku/dokku:${DOKKU_VERSION}

# Defer plugin install triggers until Dokku starts.
RUN dokku plugin:install https://github.com/dokku/dokku-http-auth.git --skip-install-trigger
