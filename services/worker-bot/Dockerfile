# ============================================================
# Worker Bot — Dockerfile (Playwright + Stealth)
# Includes all Chromium dependencies for browser automation
# ============================================================

FROM mcr.microsoft.com/playwright:v1.44.0-jammy AS base
WORKDIR /app
ENV NODE_OPTIONS="--max-old-space-size=1024"
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# ─── Dependencies ───────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/database/package.json ./packages/database/
COPY packages/shared/package.json ./packages/shared/
COPY services/worker-bot/package.json ./services/worker-bot/
RUN npm ci --workspace=services/worker-bot --workspace=packages/database --workspace=packages/shared

# ─── Development ────────────────────────────────────────────
FROM base AS development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
CMD ["npm", "run", "dev", "--workspace=services/worker-bot"]

# ─── Production ─────────────────────────────────────────────
FROM base AS production
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs botuser

COPY --from=deps --chown=botuser:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=botuser:nodejs /app/packages ./packages
COPY --chown=botuser:nodejs services/worker-bot/dist ./dist

USER botuser
CMD ["node", "dist/index.js"]
