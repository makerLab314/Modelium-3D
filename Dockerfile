# Single stage on purpose: the project has no dependencies and no build step, so
# a builder stage would only add a layer to keep in sync with this one.
FROM node:22-alpine

WORKDIR /app

# The application is copied in rather than bind mounted, which is also what keeps
# the static file server honest — nothing under public/ can be a symlink out of
# the image.
COPY --chown=node:node package.json ./
COPY --chown=node:node bin/ ./bin/
COPY --chown=node:node server/ ./server/
COPY --chown=node:node public/ ./public/

USER node

# Server mode: the settings panel is read-only and configuration comes from the
# environment, except for one setup window on first run. See server/lib/setupWindow.js.
ENV NODE_ENV=production \
    MODELIUM_MODE=server \
    MODELIUM_CONFIG_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8787

# Holds .env and the setup marker. Must be writable by uid 1000 (the node user):
# a named volume gets that right, a bind mount needs chown -R 1000:1000.
VOLUME /data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# SIGTERM is handled in server/index.js, so no init shim is needed here.
CMD ["node", "server/index.js"]
