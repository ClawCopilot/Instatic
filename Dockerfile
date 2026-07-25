# syntax=docker/dockerfile:1

FROM oven/bun:1.3.14 AS build
# `oven/bun:1.3.14` is a floating tag — the image may ship a different
# 1.3.14 patch than the one that wrote the committed `bun.lock`, which
# makes `bun install --frozen-lockfile` fail with "lockfile had
# changes". Pin to the exact release that wrote the lockfile
# (v1.3.14) so lockfile writer and runtime agree.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip -o /tmp/bun.zip \
    && unzip /tmp/bun.zip -d /usr/local/bun \
    && ln -sf /usr/local/bun/bun-linux-x64/bun /usr/local/bin/bun \
    && bun --version
WORKDIR /app
# vendor/pixel-art-icons is a `file:` dep — `bun install` needs it on disk to
# resolve the dependency, so copy it alongside the manifest before installing.
COPY package.json ./
COPY vendor ./vendor
RUN bun install
COPY . .
RUN bun run build
RUN bun run build:plugins

FROM oven/bun:1.3.14 AS production-deps
WORKDIR /app
# Same pin: replace the image's bun with the exact release that wrote
# `bun.lock`, so `bun install --frozen-lockfile --production` agrees.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip -o /tmp/bun.zip \
    && unzip /tmp/bun.zip -d /usr/local/bun \
    && ln -sf /usr/local/bun/bun-linux-x64/bun /usr/local/bin/bun \
    && bun --version
COPY package.json ./
COPY vendor ./vendor
RUN bun install --production

# ---- cloudflared download layer (cached separately) ----
# 核心功能: Cloudflare Tunnel 将 Instatic 托管到公网，无需开放服务器端口
FROM alpine:latest AS cloudflared-layer
ARG CLOUDFLARED_VERSION=latest
RUN wget -nv -O /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/${CLOUDFLARED_VERSION}/download/cloudflared-linux-amd64 \
    && chmod +x /tmp/cloudflared

# ---- sing-box download layer (cached, 可选) ----
# sing-box 作为可选的代理/协议层，默认不启用
FROM alpine:latest AS sing-box-layer
ARG SING_BOX_VERSION=1.10.1
RUN wget -nv https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/sing-box-${SING_BOX_VERSION}-linux-amd64.tar.gz \
    && tar -zxf sing-box-${SING_BOX_VERSION}-linux-amd64.tar.gz \
    && mv sing-box-${SING_BOX_VERSION}-linux-amd64/sing-box /tmp/sing-box

# ---- runtime (Instatic + Cloudflare Tunnel) ----
FROM oven/bun:1.3.14 AS runtime
WORKDIR /app

ARG INSTATIC_VERSION=dev
ARG INSTATIC_REVISION=unknown
ARG INSTATIC_CREATED=unknown

LABEL org.opencontainers.image.title="Instatic"
LABEL org.opencontainers.image.description="Self-hosted CMS with built-in Cloudflare Tunnel — deploy your site to the public internet without opening any ports."
LABEL org.opencontainers.image.source="https://github.com/clawcopilot/instatic"
LABEL org.opencontainers.image.url="https://github.com/clawcopilot/instatic"
LABEL org.opencontainers.image.documentation="https://github.com/clawcopilot/instatic/tree/main/docs/deployment"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="${INSTATIC_VERSION}"
LABEL org.opencontainers.image.revision="${INSTATIC_REVISION}"
LABEL org.opencontainers.image.created="${INSTATIC_CREATED}"

ENV NODE_ENV=production
ENV PORT=3001
ENV STATIC_DIR=/app/dist
ENV UPLOADS_DIR=/app/uploads

# Runtime-visible version info — exposed via the /health endpoint so operators
# can confirm which release is running without inspecting image labels.
ENV INSTATIC_VERSION=${INSTATIC_VERSION}
ENV INSTATIC_REVISION=${INSTATIC_REVISION}

# Install bash (start.sh dependency), ca-certificates, python3, git (HF CLI needs git)
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates python3 python3-pip git \
    && rm -rf /var/lib/apt/lists/*

# Install huggingface_hub CLI (required by HuggingFace Skill for hf CLI tools)
RUN pip3 install --break-system-packages --no-cache-dir "huggingface_hub[cli]>=0.31.1" \
    && hf --version

COPY --from=production-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun tsconfig*.json ./
COPY --chown=bun:bun server ./server
COPY --chown=bun:bun src ./src
COPY --from=build --chown=bun:bun /app/plugins ./plugins

# Copy cloudflared (核心) + sing-box (可选)
COPY --from=cloudflared-layer /tmp/cloudflared /usr/local/bin/cloudflared
COPY --from=sing-box-layer /tmp/sing-box /usr/local/bin/sing-box
RUN chmod +x /usr/local/bin/cloudflared /usr/local/bin/sing-box

# Copy start script
COPY start.sh /app/start.sh
COPY scripts/hf-backup.sh /usr/local/bin/hf-backup
COPY scripts/hf-restore.sh /usr/local/bin/hf-restore
COPY scripts/ha-switch.sh /usr/local/bin/ha-switch
COPY sing-box-config.json /app/sing-box-config.json.default
RUN chmod +x /app/start.sh /usr/local/bin/hf-backup /usr/local/bin/hf-restore /usr/local/bin/ha-switch \
    && chown bun:bun /app/start.sh /usr/local/bin/hf-backup /usr/local/bin/hf-restore /usr/local/bin/ha-switch

RUN mkdir -p /app/uploads /app/data && chown -R bun:bun /app

USER bun
EXPOSE 3001 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["bun", "run", "server/healthcheck.ts"]

CMD ["/bin/bash", "/app/start.sh"]
