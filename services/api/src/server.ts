// ============================================================
// HTTP + WebSocket Server Factory
// ============================================================

import { createServer as createHttpServer, type Server } from 'http';
import { Server as SocketIO } from 'socket.io';
import type { Application } from 'express';
import { logger } from './lib/logger.js';
import jwt from 'jsonwebtoken';

let io: SocketIO | null = null;

export function getSocketIO(): SocketIO {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

export function createServer(app: Application, _secrets?: unknown): Server {  // secrets unused
  const httpServer = createHttpServer(app);

  io = new SocketIO(httpServer, {
    cors: {
      origin: [
        process.env['APP_URL'] ?? 'http://localhost:3000',
        process.env['ADMIN_URL'] ?? 'http://localhost:3001',
      ],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // Auth middleware for socket connections
  io.use((socket, next) => {
    const token = socket.handshake.auth['token'] as string | undefined
      ?? (socket.handshake.headers['authorization'] as string | undefined)?.slice(7);

    if (!token) {
      next(new Error('Authentication required'));
      return;
    }

    try {
      const secret = process.env['JWT_SECRET']!;
      const payload = jwt.verify(token, secret) as { sub: string; email: string };
      socket.data['userId'] = payload['sub'];
      socket.data['email'] = payload['email'];
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data['userId'] as string;
    logger.debug('WebSocket connected', { userId, socketId: socket.id });

    // Join user-specific room for targeted notifications
    void socket.join(`user:${userId}`);

    socket.on('disconnect', (reason) => {
      logger.debug('WebSocket disconnected', { userId, reason });
    });

    // Client can subscribe to specific application updates
    socket.on('subscribe:application', (applicationId: string) => {
      void socket.join(`application:${applicationId}`);
    });
  });

  return httpServer;
}

// ── Notification helpers ───────────────────────────────────

export function emitToUser(userId: string, event: string, data: unknown): void {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, data);
}

export function emitApplicationUpdate(
  applicationId: string,
  data: unknown,
): void {
  if (!io) return;
  io.to(`application:${applicationId}`).emit('application:updated', data);
}
