import { Router } from 'express';
export const userRouter = Router();
// TODO: Implement user routes
userRouter.get('/health', (_req, res) => res.json({ status: 'ok', route: 'user' }));
