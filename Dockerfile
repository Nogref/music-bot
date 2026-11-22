# syntax=docker/dockerfile:1

# ---- build: compile TypeScript; native modules use prebuilt binaries ----------
FROM node:26-bookworm-slim AS build
WORKDIR /app
# Toolchain only used if a native module (better-sqlite3) has no prebuilt binary.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ------------------------------------------------------------------
FROM node:26-bookworm-slim
LABEL org.opencontainers.image.title="music-bot" \
      org.opencontainers.image.description="Discord music bot that plays your own library (Aurral or any Subsonic server) in voice channels" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HEALTH_PORT=8080 \
    PUID=99 \
    PGID=100
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh && mkdir -p /data
# The entrypoint fixes /data ownership for PUID:PGID, then drops root (setpriv).
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
