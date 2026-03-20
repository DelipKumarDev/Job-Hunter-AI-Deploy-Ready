# Job Hunter AI Agent

Autonomous job search platform. Finds jobs, applies, follows up with recruiters, and preps you for interviews.

## Architecture

```
job-hunter-ai/
├── apps/
│   ├── web/          Next.js 14 dashboard
│   └── mobile/       React Native (Expo) app
├── services/
│   ├── api/          Node.js / Express REST API
│   ├── worker-scraper/     Job discovery (LinkedIn, Indeed, Wellfound, Naukri…)
│   ├── worker-ai/          AI match scoring (Claude Sonnet + Haiku)
│   ├── worker-bot/         Application automation (Playwright + stealth)
│   ├── worker-email/       Email follow-up + Gmail sync + AI analyzer
│   ├── worker-notification/ WhatsApp notifications (Meta Cloud API)
│   ├── worker-resume/      Resume parsing + embeddings (Voyage AI)
│   └── worker-prep/        Interview prep + resume tailoring + PDF export
├── packages/
│   ├── database/     Prisma schema + client (PostgreSQL)
│   └── shared/       Types, utils, constants
└── infrastructure/
    ├── docker/       Dockerfiles (api, web, worker, bot)
    ├── nginx/        Nginx production config
    ├── scripts/      Bootstrap + DB init scripts
    └── monitoring/   Prometheus config
```

## Quick Start (Development)

```bash
# 1. Start infrastructure only
docker compose -f docker-compose.dev.yml up -d

# 2. Install dependencies
npm install

# 3. Setup environment
cp .env.example .env
# Fill in your keys

# 4. Run migrations
npx prisma migrate dev --schema=packages/database/prisma/schema.prisma

# 5. Start all services
npm run dev
```

## Production Deployment

See `infrastructure/scripts/bootstrap.sh` and the deployment guide.

```bash
# Bootstrap a fresh EC2 instance
export DOMAIN=jobhunter.ai AWS_ACCOUNT_ID=123456789012
sudo -E bash infrastructure/scripts/bootstrap.sh

# Deploy full stack
docker compose -f docker-compose.prod.yml up -d
```

## Modules Built

| Module | Description | Files | Lines |
|--------|-------------|-------|-------|
| M1 | Project scaffold (Turborepo monorepo) | 30+ | ~1,200 |
| M4 | Job Discovery Engine | 17 | 3,098 |
| M5 | AI Job Matching Engine | 14 | 2,224 |
| M6 | Application Automation Bot | 16 | 3,636 |
| M7 | Resume Intelligence Engine | 13 | 2,571 |
| M8 | Email Follow-Up System | 13 | 2,514 |
| M8b | AI Email Analyzer | 8 | 2,161 |
| M9 | WhatsApp Notification System | 10 | 2,185 |
| M10/M11 | Interview Prep + Resume Tailor | 10 | 2,744 |
| M12 | Web Dashboard (Next.js) | 1 | 1,618 |
| M13 | Mobile App (React Native) | 1 | 1,618 |
| M14 | Production Deployment | 7 | ~1,800 |

**Total: ~148 source files · ~27,000+ lines of production TypeScript/JSX**
