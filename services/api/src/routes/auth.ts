// ============================================================
// Auth Routes — /auth/*
// ============================================================

import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/database.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';

export const authRouter = Router();

// ── Schemas ────────────────────────────────────────────────

const RegisterSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    firstName: z.string().min(1).max(50),
    lastName: z.string().min(1).max(50),
    phone: z.string().optional(),
    whatsappNumber: z.string().optional(),
  }),
});

const LoginSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }),
});

// ── Token helpers ──────────────────────────────────────────

function generateTokens(userId: string, email: string, role: string) {
  const jwtSecret = process.env['JWT_SECRET']!;
  const refreshSecret = process.env['JWT_REFRESH_SECRET']!;

  const accessToken = jwt.sign(
    { sub: userId, email, role },
    jwtSecret,
    { expiresIn: process.env['JWT_EXPIRES_IN'] ?? '15m' },
  );

  const refreshToken = jwt.sign(
    { sub: userId },
    refreshSecret,
    { expiresIn: process.env['JWT_REFRESH_EXPIRES_IN'] ?? '30d' },
  );

  return { accessToken, refreshToken };
}

function setAuthCookies(res: Parameters<typeof authRouter.post>[2], accessToken: string, refreshToken: string) {
  const isProduction = process.env['NODE_ENV'] === 'production';

  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    maxAge: 15 * 60 * 1000, // 15 minutes
  });

  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: '/auth/refresh',
  });
}

// ── POST /auth/register ────────────────────────────────────

authRouter.post('/register', validate(RegisterSchema), async (req, res, next) => {
  try {
    const { email, password, firstName, lastName, phone, whatsappNumber } = req.body as {
      email: string; password: string; firstName: string; lastName: string;
      phone?: string; whatsappNumber?: string;
    };

    // Check if email already exists
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new AppError('Email already registered', 409, 'DUPLICATE_EMAIL');
    }

    // Hash password (cost factor 12)
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user + profile in a transaction
    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email,
          passwordHash,
          phone,
          whatsappNumber,
          profile: {
            create: { firstName, lastName },
          },
          subscription: {
            create: {
              plan: 'FREE',
              status: 'ACTIVE',
              monthlyApplyLimit: 10,
              aiCallsLimit: 50,
            },
          },
        },
        include: {
          profile: true,
          subscription: true,
        },
      });
      return newUser;
    });

    const { accessToken, refreshToken } = generateTokens(user.id, user.email, user.role);
    setAuthCookies(res, accessToken, refreshToken);

    res.status(201).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          profile: user.profile,
        },
        accessToken, // Also return for mobile clients
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── POST /auth/login ───────────────────────────────────────

authRouter.post('/login', validate(LoginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body as { email: string; password: string };

    const user = await prisma.user.findUnique({
      where: { email },
      include: { profile: true },
    });

    if (!user || !user.passwordHash) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    if (!user.isActive) {
      throw new AppError('Account is deactivated', 403, 'ACCOUNT_DEACTIVATED');
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const { accessToken, refreshToken } = generateTokens(user.id, user.email, user.role);
    setAuthCookies(res, accessToken, refreshToken);

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          profile: user.profile,
        },
        accessToken,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── POST /auth/refresh ─────────────────────────────────────

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const token =
      (req.cookies as Record<string, string> | undefined)?.['refresh_token'] ??
      (req.body as Record<string, string>)?.['refreshToken'];

    if (!token) {
      throw new AppError('Refresh token required', 401, 'UNAUTHORIZED');
    }

    const refreshSecret = process.env['JWT_REFRESH_SECRET']!;
    const payload = jwt.verify(token, refreshSecret) as { sub: string };

    const user = await prisma.user.findUnique({
      where: { id: payload['sub'], isActive: true },
      select: { id: true, email: true, role: true },
    });

    if (!user) throw new AppError('User not found', 401, 'UNAUTHORIZED');

    const { accessToken, refreshToken } = generateTokens(user.id, user.email, user.role);
    setAuthCookies(res, accessToken, refreshToken);

    res.json({ success: true, data: { accessToken } });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      next(new AppError('Refresh token expired, please login again', 401, 'REFRESH_EXPIRED'));
    } else {
      next(error);
    }
  }
});

// ── POST /auth/logout ──────────────────────────────────────

authRouter.post('/logout', (_req, res) => {
  res.clearCookie('access_token');
  res.clearCookie('refresh_token', { path: '/auth/refresh' });
  res.json({ success: true, message: 'Logged out successfully' });
});
