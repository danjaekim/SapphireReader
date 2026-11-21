# Sapphire: builds the web app, then the server that serves it.
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine AS server
WORKDIR /server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 WEB_DIR=/app/public
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
WORKDIR /app
COPY --from=server /server/node_modules ./node_modules
COPY --from=server /server/dist ./dist
COPY --from=server /server/package.json ./package.json
COPY --from=web /web/dist ./public
RUN apk add --no-cache su-exec && mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data
# Starts as root only to fix ownership of the mounted /data folder, then drops to node.
RUN printf '#!/bin/sh\nchown -R node:node /data 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && chmod +x /entrypoint.sh
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]
