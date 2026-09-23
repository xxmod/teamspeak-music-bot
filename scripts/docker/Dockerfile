# ==========================================
# TSMusicBot Docker Image
# One-click deployment — all dependencies included
# ==========================================

# --- Stage 1: Build frontend ---
FROM node:22-slim AS web-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- Stage 2: Build backend & compile native modules ---
FROM node:22-slim AS builder

# Install build tools for native modules (opus, better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install backend dependencies (compiles native addons once)
COPY package*.json ./
RUN npm ci

# Copy backend source and compile TypeScript
COPY . .
RUN npx tsc

# Prune devDependencies to keep only production dependencies (preserves compiled native addons)
RUN npm prune --omit=dev && npm cache clean --force

# --- Stage 3: Production image ---
FROM node:22-slim

# Install system FFmpeg — the ffmpeg-static npm package bundles a pre-compiled
# binary that can SIGSEGV inside Docker (incompatible glibc / missing libs).
# System-installed FFmpeg is always compatible with the container runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built output and pre-compiled production node_modules
COPY --from=builder /app/dist ./dist
COPY --from=web-builder /app/web/dist ./web/dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
# package.json declares a `prestart` preflight, so `npm start` inside the
# container needs this file. The image's own CMD calls node directly and never
# goes through npm, but an interactive `docker exec ... npm start` would
# otherwise die on a missing script rather than starting the bot.
COPY --from=builder /app/scripts/check-native.mjs ./scripts/check-native.mjs
# ...and the module it imports for crash-proof logging.
COPY --from=builder /app/scripts/lib/console-log.mjs ./scripts/lib/console-log.mjs

# Data directory for database, cookies, logs
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://localhost:3000/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
