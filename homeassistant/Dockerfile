# Named directly rather than through BUILD_FROM and a build.yaml, for two
# reasons the Supervisor spells out itself:
#
#   1. It validates build_from against a regex that requires a namespace, so the
#      slashless `node:22-alpine` is rejected — and it does not fail on that, it
#      falls back to ghcr.io/home-assistant/base. That base has no Node in it, so
#      the real error surfaces much later as `npm: not found`.
#   2. build.yaml is deprecated: "Move build parameters into the Dockerfile
#      directly."
#
# This tag is multi-arch (amd64, arm64, arm/v7), and the Supervisor builds on the
# Home Assistant machine with --platform, so it resolves to the right one.
FROM node:22-alpine

# Declared and deliberately unused. The Supervisor passes --build-arg BUILD_FROM
# on every build; accepting it here keeps it out of the "build-args were not
# consumed" warning, and consuming it in FROM is exactly the mistake above.
ARG BUILD_FROM

# The add-on version from config.yaml, handed over by the Supervisor. It is also
# the npm version installed below, so the two cannot drift apart.
ARG BUILD_VERSION

WORKDIR /app

# Installed from the registry rather than copied from this repository, so the
# build context stays this one directory and the add-on can be built without a
# checkout. The package has no dependencies, so this resolves to exactly one
# tarball and works on every architecture without a compiler.
#
# The guard matters: without BUILD_VERSION the install line would read
# `modelium-3d@` and npm would happily fetch whatever is newest, which is not a
# reproducible add-on.
RUN test -n "${BUILD_VERSION}" \
      || { echo "BUILD_VERSION is required — it comes from version: in config.yaml"; exit 1; } \
 && npm install --omit=dev --no-audit --no-fund "modelium-3d@${BUILD_VERSION}" \
 && npm cache clean --force

COPY run.mjs /app/run.mjs

# Server mode, because this is a shared instance by definition: the settings
# panel is read-only and configuration comes from the environment, which run.js
# fills in from the add-on options.
#
# MODELIUM_SETUP=false closes the first-run window before it can open. It exists
# so that a container with no configuration interface can still be given a token
# once; here Home Assistant *is* the configuration interface, so the window would
# be a way in that buys nothing.
ENV NODE_ENV=production \
    MODELIUM_MODE=server \
    MODELIUM_CONFIG_DIR=/data \
    MODELIUM_SETUP=false \
    HOST=0.0.0.0 \
    PORT=8787

# Runs as root only long enough to hand /data to uid 1000 and drop to it. See the
# comment in run.mjs.
CMD ["node", "/app/run.mjs"]
