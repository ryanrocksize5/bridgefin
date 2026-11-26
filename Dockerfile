# Bridgefin: Stremio addons + TorBox, served over the Jellyfin API.
# No build step and no runtime dependencies: Node 24 runs the TypeScript sources directly.
FROM node:24-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8096

WORKDIR /app
COPY package.json ./
COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8096

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8096/health >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
