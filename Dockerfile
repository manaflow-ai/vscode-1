# VSCode Server Web - Multi-stage Dockerfile
#
# This Dockerfile builds VSCode serve-web from source and creates
# a minimal runtime image. Uses OpenVSIX marketplace by default.
#
# Usage:
#   docker build -t vscode-web .
#   docker run -p 8080:8080 vscode-web
#
# To use a pre-built artifact instead of building from source:
#   docker build --target runtime -t vscode-web \
#     --build-arg ARTIFACT_URL=https://github.com/manaflow-ai/vscode-1/releases/download/v1.0.0/vscode-server-linux-x64-web.tar.gz .

# =============================================================================
# Build Stage - Compile VSCode from source
# =============================================================================
FROM node:22-bookworm AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    pkg-config \
    libx11-dev \
    libxkbfile-dev \
    libsecret-1-dev \
    libkrb5-dev \
    python3 \
    rpm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy source code first (simpler, more reliable)
COPY . .

# Install build dependencies
RUN cd build && npm ci --legacy-peer-deps

# Install main dependencies (skip electron/playwright for web build)
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --legacy-peer-deps

# Apply patches
RUN ./scripts/apply-patches.sh

# Compile and build
ENV NODE_OPTIONS="--max-old-space-size=8192"
RUN npm run gulp compile-build-without-mangling && \
    npm run gulp compile-extensions-build && \
    npm run gulp compile-extension-media-build && \
    npm run gulp minify-vscode-reh-web && \
    npm run gulp vscode-reh-web-linux-x64-min-ci

# =============================================================================
# Runtime Stage - Minimal image with just the server
# =============================================================================
FROM debian:bookworm-slim AS runtime

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libsecret-1-0 \
    libkrb5-3 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -s /bin/bash vscode

# Copy the built server from builder stage
COPY --from=builder --chown=vscode:vscode /vscode-reh-web-linux-x64 /opt/vscode-server

# Set working directory
WORKDIR /home/vscode

# Switch to non-root user
USER vscode

# Expose the default port
EXPOSE 8080

# Default workspace directory
VOLUME ["/home/vscode/workspace"]

# Environment variables
ENV VSCODE_SERVER_PORT=8080
ENV VSCODE_SERVER_HOST=0.0.0.0

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${VSCODE_SERVER_PORT}/ || exit 1

# Entry point
ENTRYPOINT ["/opt/vscode-server/bin/code-server-oss"]
CMD ["--host", "0.0.0.0", "--port", "8080", "--without-connection-token", "/home/vscode/workspace"]
