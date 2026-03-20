import { Router } from 'express';
export const webhooksRouter = Router();
// TODO: Implement webhooks routes
webhooksRouter.get('/health', (_req, res) => res.json({ status: 'ok', route: 'webhooks' }));
