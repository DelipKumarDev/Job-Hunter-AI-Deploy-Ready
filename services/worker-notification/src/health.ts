/**
 * Health check module — loaded by Dockerfile HEALTHCHECK
 * node -e "require('./dist/health.js')"
 * Exits 0 (healthy) simply by loading successfully.
 * For richer checks, throw an error to exit 1 (unhealthy).
 */

// If this module loads, the Node.js runtime is alive.
// Process-level health is sufficient for container orchestration.
// Queue-depth and Redis checks belong in the /metrics endpoint.
export const healthy = true;
