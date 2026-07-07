# syntax=docker/dockerfile:1

FROM oven/bun:1.3.11 AS build
WORKDIR /app
# vendor/pixel-art-icons is a `file:` dep — `bun install` needs it on disk to
# resolve the dependency, so copy it alongside the manifest before installing.
COPY package.json bun.lock ./
COPY vendor ./vendor
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.11 AS production-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY vendor ./vendor
RUN bun install --frozen-lockfile --production

# ---- sing-box download layer (cached separately) ----
# 参考: link-nvidia 的 sing-box + cloudflared 合体架构
FROM alpine:latest AS sing-box-layer
ARG SING_BOX_VERSION=1.10.1
RUN wget -q https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/sing-box-${SING_BOX_VERSION}-linux-amd64.tar.gz \
    && tar -zxf sing-box-${SING_BOX_VERSION}-linux-amd64.tar.gz \
    && mv sing-box-${SING_BOX_VERSION}-linux-amd64/sing-box /tmp/sing-box

# ---- cloudflared download layer (cached separately) ----
FROM alpine:latest AS cloudflared-layer
ARG CLOUDFLARED_VERSION=latest
RUN wget -q -O /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/${CLOUDFLARED_VERSION}/download/cloudflared-linux-amd64 \
    && chmod +x /tmp/cloudflared

# ---- runtime (Instatic + sing-box + cloudflared) ----
FROM oven/bun:1.3.11 AS runtime
WORKDIR /app

ARG INSTATIC_VERSION=dev
ARG INSTATIC_REVISION=unknown
ARG INSTATIC_CREATED=unknown

LABEL org.opencontainers.image.title="Instatic"
LABEL org.opencontainers.image.description="Self-hosted CMS with an integrated visual editor — bundled with sing-box + Cloudflare Tunnel."
LABEL org.opencontainers.image.source="https://github.com/corebunch/instatic"
LABEL org.opencontainers.image.url="https://github.com/corebunch/instatic"
LABEL org.opencontainers.image.documentation="https://github.com/corebunch/instatic/tree/main/docs/deployment"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="${INSTATIC_VERSION}"
LABEL org.opencontainers.image.revision="${INSTATIC_REVISION}"
LABEL org.opencontainers.image.created="${INSTATIC_CREATED}"

ENV NODE_ENV=production
ENV PORT=3001
ENV STATIC_DIR=/app/dist
ENV UPLOADS_DIR=/app/uploads

# Install bash (start.sh dependency) and ca-certificates
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=production-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun tsconfig*.json ./
COPY --chown=bun:bun server ./server
COPY --chown=bun:bun src ./src

# Copy sing-box and cloudflared binaries
COPY --from=sing-box-layer /tmp/sing-box /usr/local/bin/sing-box
COPY --from=cloudflared-layer /tmp/cloudflared /usr/local/bin/cloudflared
RUN chmod +x /usr/local/bin/sing-box /usr/local/bin/cloudflared

# Copy start script and sing-box default config
COPY start.sh /app/start.sh
COPY sing-box-config.json /app/sing-box-config.json.default
RUN chmod +x /app/start.sh && chown bun:bun /app/start.sh

RUN mkdir -p /app/uploads /app/data && chown -R bun:bun /app

USER bun
EXPOSE 3001 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["bun", "run", "server/healthcheck.ts"]

CMD ["/bin/bash", "/app/start.sh"]
