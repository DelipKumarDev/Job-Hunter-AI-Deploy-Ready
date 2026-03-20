// ============================================================
// Validate Middleware — Zod schema validation for requests
// ============================================================

import type { Request, Response, NextFunction } from 'express';
import { type ZodSchema, ZodError } from 'zod';
import { AppError } from './errorHandler.js';

interface RequestSchema {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

export function validate(schema: RequestSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schema.body) {
        req.body = schema.body.parse(req.body);
      }
      if (schema.query) {
        req.query = schema.query.parse(req.query);
      }
      if (schema.params) {
        req.params = schema.params.parse(req.params);
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(new AppError(
          'Validation failed: ' + error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
          400,
          'VALIDATION_ERROR',
        ));
      } else {
        next(error);
      }
    }
  };
}
