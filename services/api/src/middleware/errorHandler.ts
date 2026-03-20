// ============================================================
// Error Handler — Global Express error middleware
// ============================================================

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

// Custom application error
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = 'INTERNAL_ERROR',
    isOperational: boolean = true,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = req.headers['x-request-id'] as string | undefined;

  // ── AppError (expected errors) ────────────────────────────
  if (err instanceof AppError) {
    const response: ErrorResponse = {
      success: false,
      error: {
        code: err.code,
        message: err.message,
        requestId,
      },
    };

    if (err.statusCode >= 500) {
      logger.error('Application error', {
        code: err.code,
        message: err.message,
        requestId,
        stack: err.stack,
      });
    }

    res.status(err.statusCode).json(response);
    return;
  }

  // ── Zod Validation Error ──────────────────────────────────
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.flatten().fieldErrors,
        requestId,
      },
    });
    return;
  }

  // ── Prisma Errors ─────────────────────────────────────────
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      // Unique constraint violation
      const field = (err.meta?.['target'] as string[])?.join(', ');
      res.status(409).json({
        success: false,
        error: {
          code: 'DUPLICATE_ENTRY',
          message: `A record with this ${field} already exists`,
          requestId,
        },
      });
      return;
    }

    if (err.code === 'P2025') {
      // Record not found
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Record not found',
          requestId,
        },
      });
      return;
    }
  }

  // ── Unknown / Programming Errors ──────────────────────────
  logger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
    requestId,
    url: req.url,
    method: req.method,
  });

  const isDev = process.env['NODE_ENV'] === 'development';
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: isDev ? err.message : 'An internal server error occurred',
      details: isDev ? err.stack : undefined,
      requestId,
    },
  });
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(`Route ${req.method} ${req.path} not found`, 404, 'NOT_FOUND'));
}
