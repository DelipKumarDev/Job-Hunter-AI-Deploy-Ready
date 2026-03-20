# ============================================================
# API Service — Dockerfile (Multi-stage)
# ============================================================

# ─── Base ───────────────────────────────────────────────────
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat curl
WORKDIR /app
ENV NODE_OPTIONS="--max-old-space-size=512"

# ─── Dependencies ───────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
# Copy workspace packages
COPY packages/database/package.json ./packages/database/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci --workspace=services/api --workspace=packages/database --workspace=packages/shared

# ─── Development ────────────────────────────────────────────
FROM base AS development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 4000
CMD ["npm", "run", "dev"]

# ─── Build ──────────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/database
RUN npm run build --workspace=services/api

# ─── Production ─────────────────────────────────────────────
FROM base AS production
ENV NODE_ENV=production
# Add non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 apiuser

COPY --from=builder --chown=apiuser:nodejs /app/services/api/dist ./dist
COPY --from=builder --chown=apiuser:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=apiuser:nodejs /app/packages ./packages

USER apiuser
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1

CMD ["node", "dist/index.js"]
