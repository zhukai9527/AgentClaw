# ── Stage 1: Build ──
FROM node:20-slim AS builder

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Use China mirror for faster package downloads
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null || true

# Install build dependencies for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Copy everything and install
COPY . .
RUN pnpm install --frozen-lockfile
RUN npm run build

# ── Stage 2: Runtime ──
FROM node:20-slim

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Use China mirror for faster package downloads
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null || true

# Use China mirror
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null || true

# 安装默认运行时工具。浏览器自动化不进入默认镜像。
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg git curl python3 \
    && rm -rf /var/lib/apt/lists/*

# 需要 browser_cdp 时，用 --build-arg INSTALL_BROWSER=true 构建镜像，
# 并在运行时设置 AGENTCLAW_ENABLE_BROWSER_CDP=true。
ARG INSTALL_BROWSER=false
RUN if [ "$INSTALL_BROWSER" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-ipafont-gothic fonts-wqy-zenhei fonts-noto-cjk \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# Copy built artifacts from builder
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages/types/package.json packages/types/
COPY --from=builder /app/packages/types/dist packages/types/dist
COPY --from=builder /app/packages/providers/package.json packages/providers/
COPY --from=builder /app/packages/providers/dist packages/providers/dist
COPY --from=builder /app/packages/tools/package.json packages/tools/
COPY --from=builder /app/packages/tools/dist packages/tools/dist
COPY --from=builder /app/packages/memory/package.json packages/memory/
COPY --from=builder /app/packages/memory/dist packages/memory/dist
COPY --from=builder /app/packages/core/package.json packages/core/
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/gateway/package.json packages/gateway/
COPY --from=builder /app/packages/gateway/dist packages/gateway/dist
COPY --from=builder /app/packages/cli/package.json packages/cli/
COPY --from=builder /app/packages/cli/dist packages/cli/dist
COPY --from=builder /app/packages/web/package.json packages/web/
COPY --from=builder /app/packages/web/dist packages/web/dist

# Copy non-code assets
COPY system-prompt.md ./
COPY skills/ skills/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Create data directories
RUN mkdir -p data/tmp data/temp data/browser-states

ENV PORT=3100
ENV HOST=0.0.0.0
EXPOSE 3100

# Run as non-root user
RUN groupadd -r agentclaw && useradd -r -g agentclaw -u 1001 agentclaw \
    && chown -R agentclaw:agentclaw /app/data
USER agentclaw

CMD ["node", "packages/gateway/dist/index.js"]
