// ============================================================
// Express App Factory
// ============================================================

import express, { type Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import { rateLimit } from 'express-rate-limit';

import { requestLogger } from './middleware/requestLogger.js';
import { metricsHandler } from './lib/apiMetrics.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFoundHandler } from './middleware/notFoundHandler.js';
import { authMiddleware } from './middleware/auth.js';
import { bullBoardRouter } from './lib/bullBoard.js';

// Routes
import { authRouter } from './routes/auth.js';
import { userRouter } from './routes/user.js';
import { resumeRouter } from './routes/resumes.js';
import { matchRouter } from './routes/matches.js';
import { applicationsRouter } from './routes/applications.js';
import { emailRouter } from './routes/email.js';
import { notificationsRouter } from './routes/notifications.js';
import { subscriptionRouter } from './routes/subscription.js';
import { webhooksRouter }    from './routes/webhooks.js';
import { discoveryRouter }   from './routes/discovery.js';

export function createApp(_secrets?: unknown): Application {  // secrets unused - resolved at startup
  const app = express();

  // ── Trust proxy (for rate limiting behind nginx) ──────────
  app.set('trust proxy', 1);

  // ── Security ──────────────────────────────────────────────
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
  }));

  // ── CORS ──────────────────────────────────────────────────
  const allowedOrigins = [
    process.env['APP_URL'] ?? 'http://localhost:3000',
    process.env['ADMIN_URL'] ?? 'http://localhost:3001',
  ];
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  }));

  // ── Body parsing ──────────────────────────────────────────
  // Webhooks need raw body — must be before express.json()
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
  app.use('/webhooks/whatsapp', express.raw({ type: 'application/json' }));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser(process.env['COOKIE_SECRET']));
  app.use(compression());

  // ── Rate Limiting ─────────────────────────────────────────
  const globalLimiter = rateLimit({
    windowMs: parseInt(process.env['RATE_LIMIT_WINDOW_MS'] ?? '60000', 10),
    max: parseInt(process.env['RATE_LIMIT_MAX_REQUESTS'] ?? '100', 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
    skip: (req) => req.path === '/health',
  });
  app.use(globalLimiter);

  // Stricter limiter for auth endpoints
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    message: { error: 'Too many auth attempts.' },
  });

  // ── Logging ───────────────────────────────────────────────
  if (process.env['NODE_ENV'] !== 'test') {
    app.use(morgan('combined'));
  }
  app.use(requestLogger);

  // ── Health Check ──────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'job-hunter-api',
      version: process.env['npm_package_version'] ?? '1.0.0',
    });
  });

  // ── Prometheus Metrics ────────────────────────────────────
  // Scraped by Prometheus every 15s. Not behind auth — scraping
  // happens on the internal Docker network only.
  app.get('/metrics', (req, res) => void metricsHandler(req, res));

  // ── Bull Board (Queue Monitor) ────────────────────────────
  app.use('/queues', bullBoardRouter);

  // ── Public Routes ─────────────────────────────────────────
  app.use('/auth', authLimiter, authRouter);
  app.use('/webhooks', webhooksRouter);

  // ── Protected Routes (require JWT) ───────────────────────
  app.use('/api/v1/user', authMiddleware, userRouter);
  app.use('/api/v1/resume', authMiddleware, resumeRouter);
  app.use('/api/v1/jobs', authMiddleware, matchRouter);
  app.use('/api/v1/applications', authMiddleware, applicationsRouter);
  app.use('/api/v1/email',     authMiddleware, emailRouter);
  app.use('/api/v1/discovery', authMiddleware, discoveryRouter);
  app.use('/api/v1/notifications', authMiddleware, notificationsRouter);
  app.use('/api/v1/subscription', authMiddleware, subscriptionRouter);

  // ── Error Handling (must be last) ────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
