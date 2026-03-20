import { Router } from 'express';
export const subscriptionRouter = Router();
// TODO: Implement subscription routes
subscriptionRouter.get('/health', (_req, res) => res.json({ status: 'ok', route: 'subscription' }));
