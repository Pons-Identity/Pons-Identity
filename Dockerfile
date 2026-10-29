# Pons Identity: build the console, then run on a slim image with only production dependencies.
# Needs Node 22.13+ (node:sqlite). State lives in /app/data; mount a volume there.

FROM node:24-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

# The user API's reference page (docs/api.html), rendered from docs/openapi.yaml by Redocly.
FROM node:24-slim AS docs
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY redocly.yaml ./
COPY docs ./docs
RUN npm run docs:build

FROM node:24-slim
ENV NODE_ENV=production \
    PORT=3000 \
    PROTOCOL=http \
    TLS=false
WORKDIR /app
# git: Integrations > Git commits integrations to a repository kept in /app/data (needs the git program).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY views ./views
COPY --from=web /app/web/dist ./web/dist
COPY --from=docs /app/docs ./docs
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME /app/data
EXPOSE 3000
EXPOSE 1812/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
