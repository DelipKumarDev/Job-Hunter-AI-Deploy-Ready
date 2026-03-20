/**
 * ============================================================
 * Auth Middleware — JWT verification
 *
 * Reads JWT_SECRET from the resolved secrets singleton, never
 * from process.env directly.
 * ============================================================
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma }    from '../lib/database.js';
import { getSecrets } from '@job-hunter/shared/secrets';
import { AppError }  from './errorHandler.js';

interface JwtPayload {
  sub:   string;
  email: string;
  role:  string;
  iat:   number;
  exp:   number;
}

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string; role: string };
    }
  }
}

export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token =
      extractBearerToken(req.headers['authorization']) ??
      (req.cookies as Record<string, string> | undefined)?.['access_token'];

    if (!token) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');

    // Read from the secrets singleton — not process.env
    const { JWT_SECRET } = getSecrets();

    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;

    const user = await prisma.user.findUnique({
      where:  { id: payload['sub'], isActive: true },
      select: { id: true, email: true, role: true, isActive: true },
    });

    if (!user) throw new AppError('User not found or deactivated', 401, 'UNAUTHORIZED');

    req.user = { id: user.id, email: user.email, role: user.role };
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      next(new AppError('Token expired',  401, 'TOKEN_EXPIRED'));
    } else if (error instanceof jwt.JsonWebTokenError) {
      next(new AppError('Invalid token',  401, 'INVALID_TOKEN'));
    } else {
      next(error);
    }
  }
}

export async function optionalAuthMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await authMiddleware(req, _res, next);
  } catch {
    next();
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'ADMIN') {
    next(new AppError('Admin access required', 403, 'FORBIDDEN'));
    return;
  }
  next();
}

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}
