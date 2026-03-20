# Integration Fixes — Job Hunter AI

All fixes applied during system integration phase. Listed by severity.

---

## 🔴 CRITICAL — Queue Name Mismatches (Jobs Never Consumed)

### Root Cause
BullMQ namespaces queues as `{prefix}:{queueName}` in Redis. Four workers were
manually prepending `${PREFIX}:` to their queue names, resulting in double-prefix
keys that no producer ever wrote to. Jobs enqueued by the API silently accumulated
in dead queues while workers listened to empty ones.

| Worker | Consumer listened on | Producer wrote to | Fix |
|--------|---------------------|-------------------|-----|
| worker-ai | `jhq:ai-match` | `jhq:ai-match-queue` | Remove manual prefix |
| worker-notification | `jhq:notification` | `jhq:notification-queue` | Remove manual prefix |
| worker-resume | `jhq:resume-tailor` | `jhq:resume-tailor-queue` | Remove manual prefix |
| worker-prep | `jhq:interview-prep` | `jhq:interview-prep-queue` | Remove manual prefix |

**Fix:** All workers now use the bare queue name and rely on the `prefix:` Worker
option in the BullMQ constructor, consistent with worker-scraper/bot/email.

### Additional Queue Bug
- `API QUEUES.JOB_SEARCH = 'job-search-queue'` but scraper consumes
  `'job-discovery-queue'` — renamed to `JOB_DISCOVERY`.

---

## 🔴 CRITICAL — Wrong Processor APIs Called

Four worker index files called exported functions that didn't exist:

| Worker | Called | Actual Export | Fix |
|--------|--------|---------------|-----|
| worker-ai | `matchWorkerProcessor(job, secrets)` | `startMatchWorker(prisma, redis)` | Rewrote index.ts |
| worker-notification | `notificationWorkerProcessor(job, secrets)` | `startNotificationWorker(prisma)` | Rewrote index.ts |
| worker-resume | `resumeWorkerProcessor(job, secrets)` | `startResumeWorker(prisma)` | Rewrote index.ts |
| worker-prep | `prepOrchestratorProcessor(job, secrets)` | `startPrepWorker(prisma)` | Rewrote index.ts |

---

## 🔴 BUILD — Missing tsconfig.json (TypeScript Compilation Fails)

All 8 services were missing `tsconfig.json`. Builds would fail at CI.

**Fix:** Created `tsconfig.json` in:
- Root (base config: ES2022, Node16 modules, strict mode)
- `packages/shared/`, `packages/database/`
- `services/api/`, all 7 `services/worker-*/`

Each extends the root config and adds `paths` aliases for workspace packages.

---

## 🔴 BUILD — Missing Dependencies in worker package.json Files

| Worker | Problem | Fix |
|--------|---------|-----|
| worker-ai | Missing `@job-hunter/shared` | Added |
| worker-notification | **Zero dependencies** (empty package.json) | Rebuilt from scratch |
| worker-resume | Missing `@job-hunter/shared`, `@prisma/client` | Added |
| worker-prep | Missing `@job-hunter/shared`, `pino`, `prom-client` | Added |

---

## 🔴 BUILD — Missing Source Files

| File | Problem | Fix |
|------|---------|-----|
| `packages/database/src/index.ts` | Missing; Dockerfiles copy `./packages/database/dist` | Created |
| `packages/shared/src/types/queue.ts` | Referenced in `index.ts` exports | Created with all payload types |
| `services/api/src/middleware/notFoundHandler.ts` | Imported in `app.ts` | Created |
| `services/api/src/lib/bullBoard.ts` | Imported in `app.ts` | Created |
| `services/api/src/routes/{user,notifications,subscription,webhooks}.ts` | Imported in `app.ts` | Created stubs |
| `services/worker-*/src/health.ts` | Dockerfile HEALTHCHECK: `node -e "require('./dist/health.js')"` | Created for all 7 workers |

---

## 🔴 BUILD — Function Signature Mismatches

| Call site | Declared signature | Fix |
|-----------|-------------------|-----|
| `createApp(secrets)` in `index.ts` | `createApp(): Application` | Added optional `_secrets` param |
| `createServer(app, secrets)` in `index.ts` | `createServer(app): Server` | Added optional `_secrets` param |
| `initQueues(secrets.REDIS_URL)` in `index.ts` | `initQueues(): Promise<void>` | Added optional `redisUrl` param |

---

## 🔴 BUILD — Cross-Service Import (Breaks in Docker)

`services/api/src/routes/discovery.ts` imported `ScraperConfig` directly from
`../../../services/worker-scraper/src/types/scraperTypes.js`. This path works
locally but breaks inside the API Docker image (which only copies its own service).

**Fix:** Inlined the `ScraperConfig` interface definition in `discovery.ts`.

---

## 🔴 BUILD — Missing Database Build Step in Dockerfiles

`Dockerfile.api` and `Dockerfile.bot` ran `npm run build --workspace=packages/shared`
but skipped `packages/database`. The Prisma client compiled output was never created.

**Fix:** Added `npm run build --workspace=packages/database` before shared/service builds
in all three Dockerfiles.

---

## 🟡 RUNTIME — All Workers Missing HEALTHCHECK Target

Dockerfile HEALTHCHECK: `CMD node -e "require('./dist/health.js')" || exit 1`

The `health.js` file didn't exist in any worker. Container orchestrators would
mark all workers unhealthy 90 seconds after startup and restart them in a loop.

**Fix:** Created `src/health.ts` in all 7 workers.

---

## 🟡 RUNTIME — No Database Migration Init Container

The API and all workers would crash on first deploy if the database schema wasn't
already migrated. No mechanism enforced migration ordering.

**Fix:** Added `migrate` service to `docker-compose.prod.yml`:
```yaml
migrate:
  command: ["sh", "-c", "npx prisma migrate deploy --schema=./prisma/schema.prisma"]
  restart: "no"
  depends_on:
    postgres: { condition: service_healthy }
```

All app services now have:
```yaml
depends_on:
  migrate: { condition: service_completed_successfully }
```

---

## 🟡 RUNTIME — nginx Missing /stub_status Endpoint

`nginx-exporter` was configured to scrape `http://nginx/stub_status` but nginx
had no `stub_status` location block. The exporter would return connection refused.

**Fix:** Added a dedicated server block on port 8080 with `/stub_status` accessible
only from Docker internal networks. Updated `nginx-exporter` command to scrape `:8080`.

---

## 🟡 RUNTIME — Inline Queue Creation in API Routes

`routes/resumes.ts` and `routes/discovery.ts` created new `Queue` instances
directly with `process.env.REDIS_HOST/PORT`. After the secrets loader wipes
managed env vars at startup, these would fail to connect.

**Fix:** Added `getQueueOrDirect(name)` helper to `queues.ts` and updated both
routes to use it.

---

## 🟡 DATA — Prisma Model Name Mismatch

Prisma model: `FollowUpLog` → generated accessor: `prisma.followUpLog` (capital U)

All code used: `prisma.followupLog` (lowercase u) — 14 call sites across 5 files.

**Fix:** Renamed schema model from `FollowUpLog` to `FollowupLog` to match
existing code pattern (1-character change, regenerated client is backward compatible).

---

## 🟡 DATA — Missing resume-tailor-queue Consumer

`QUEUES.RESUME_TAILOR` ('resume-tailor-queue') was produced by the API for
standalone re-tailoring requests but no worker consumed it.

**Fix:** Added `startResumeTailorWorker()` to `prepOrchestrator.ts`. The
`worker-prep` process now starts both `interview-prep-queue` and
`resume-tailor-queue` workers.

---

## Route Import Name Fixes

| `app.ts` imported | Actual export | Fix |
|-------------------|--------------|-----|
| `resumeRouter` from `./routes/resume.js` | `resumeRouter` from `resumes.ts` | Fixed path |
| `jobsRouter` from `./routes/jobs.js` | `matchRouter` from `matches.ts` | Fixed path + name |
| missing `discoveryRouter` | `discoveryRouter` from `discovery.ts` | Added import + mount |
