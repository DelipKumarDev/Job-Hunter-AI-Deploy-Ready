import { Router } from 'express';
export const notificationsRouter = Router();
// TODO: Implement notifications routes
notificationsRouter.get('/health', (_req, res) => res.json({ status: 'ok', route: 'notifications' }));
