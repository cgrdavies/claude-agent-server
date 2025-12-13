# Use official Bun image
FROM oven/bun:1.2-alpine

# Install git and other dependencies for Claude Agent SDK
RUN apk add --no-cache git curl bash

# Create non-root user (matching E2B's structure for compatibility)
RUN addgroup -g 1000 user && \
    adduser -u 1000 -G user -s /bin/bash -D user

# Create workspace directory
RUN mkdir -p /home/user/agent-workspace && \
    chown -R user:user /home/user

# Set working directory
WORKDIR /home/user/app

# Copy package files first for better caching
COPY package.json bun.lock* ./
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Ensure correct ownership
RUN chown -R user:user /home/user/app

# Create .claude directory placeholder (will be mounted at runtime)
RUN mkdir -p /home/user/.claude && \
    chown -R user:user /home/user/.claude

# Copy Claude configuration if present (for Claude Max)
# This is optional - can also be mounted at runtime
COPY --chown=user:user .claude-config /home/user/.claude/ 2>/dev/null || true

# Switch to non-root user
USER user

# Expose port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1

# Start server
CMD ["bun", "run", "start:server"]
