# Build stage
FROM node:20-alpine AS builder

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Remove build tools after native modules are compiled
RUN apk del python3 make g++

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create data directory for SQLite database
RUN mkdir -p /app/data && chown -R node:node /app/data

# Use non-root user for security
USER node

# Environment variables (override in docker-compose or docker run)
ENV NODE_ENV=production
ENV DB_PATH=/app/data/crypto-snipper.db
ENV LOG_LEVEL=info

# Expose volume for persistent database
VOLUME ["/app/data"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "console.log('healthy')" || exit 1

# Default command: run telegram bot
CMD ["node", "dist/index.js", "telegram"]
