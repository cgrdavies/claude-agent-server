# Use official Bun image
FROM oven/bun:1.2-alpine

# Install git and other dependencies for Claude Agent SDK
RUN apk add --no-cache git curl bash

# Create workspace and .claude directories (using bun user from image)
RUN mkdir -p /home/bun/agent-workspace /home/bun/.claude && \
    chown -R bun:bun /home/bun

# Set working directory
WORKDIR /home/bun/app

# Copy package files first for better caching
COPY package.json bun.lock* ./
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Ensure correct ownership
RUN chown -R bun:bun /home/bun/app

# Switch to non-root user
USER bun

# Expose port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1

# Start server
CMD ["bun", "run", "start:server"]
