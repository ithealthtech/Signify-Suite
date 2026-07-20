# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false && npm cache clean --force

FROM node:24-bookworm-slim AS builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts=false
COPY . .
RUN npm run build && node scripts/artifact-test.cjs

FROM node:24-bookworm-slim AS runtime
ARG VERSION=development
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Signify Creator" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.source="https://github.com/ithealthtech/Signify-Suite"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173
WORKDIR /app
COPY --from=builder --chown=node:node /build/dist/ ./
COPY --from=production-dependencies --chown=node:node /build/node_modules/ ./node_modules/
RUN mkdir -p /var/lib/signify/data /var/lib/signify/backups public/uploads public/generated-banners \
    && chown -R node:node /var/lib/signify public/uploads public/generated-banners
USER node
EXPOSE 4173
VOLUME ["/var/lib/signify"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4173/api/ready').then(r=>{if(!r.ok)throw new Error(String(r.status))}).catch(()=>process.exit(1))"]
CMD ["node", "server.cjs"]
