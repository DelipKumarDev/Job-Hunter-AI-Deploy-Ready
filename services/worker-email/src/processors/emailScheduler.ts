// ============================================================
// Email Sync Scheduler
// Cron-driven periodic email sync and follow-up checks.
//
// Schedules:
//   Inbox sync:    every 30 minutes  → */30 * * * *
//   Follow-up check: every hour     → 0 * * * *
//   Stale cleanup:   daily 2am      → 0 2 * * *
// ============================================================

import { CronJob } from 'cron';
import { Queue }   from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { EmailSyncPayload } from '../types/emailTypes.js';
import { logger } from '../utils/logger.js';

export class EmailSyncScheduler {
  private readonly syncQueue: Queue<EmailSyncPayload>;
  private readonly cronJobs:  CronJob[] = [];

  constructor(private readonly prisma: PrismaClient) {
    this.syncQueue = new Queue<EmailSyncPayload>('email-monitor-queue', {
      connection: {
        host: process.env['REDIS_HOST'] ?? 'localhost',
        port: parseInt(process.env['REDIS_PORT'] ?? '6379'),
      },
      prefix: process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
    });
  }

  start(): void {
    // Every 30 min: sync all active accounts
    this.cronJobs.push(new CronJob(
      process.env['EMAIL_SYNC_CRON'] ?? '*/30 * * * *',
      () => this.enqueueSyncForAllUsers().catch(e => logger.error('Sync cron error', { error: String(e) })),
      null, true, 'UTC',
    ));

    // Every hour: ensure overdue follow-ups are queued
    this.cronJobs.push(new CronJob(
      '0 * * * *',
      () => this.checkOverdueFollowUps().catch(e => logger.error('Follow-up cron error', { error: String(e) })),
      null, true, 'UTC',
    ));

    // Daily 2am: cleanup old processed emails
    this.cronJobs.push(new CronJob(
      '0 2 * * *',
      () => this.cleanupOldData().catch(e => logger.error('Cleanup cron error', { error: String(e) })),
      null, true, 'UTC',
    ));

    logger.info('Email sync scheduler started', {
      syncCron:     process.env['EMAIL_SYNC_CRON'] ?? '*/30 * * * *',
      followUpCron: '0 * * * *',
      cleanupCron:  '0 2 * * *',
    });
  }

  // ── Enqueue sync for ALL active email accounts ────────────
  async enqueueSyncForAllUsers(): Promise<void> {
    const accounts = await this.prisma.userEmailAccount.findMany({
      where:  { isActive: true },
      select: { id: true, userId: true, email: true },
    });

    logger.info(`Enqueueing email sync for ${accounts.length} accounts`);

    // Stagger: 2s between each to avoid thundering herd
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i]!;
      await this.syncQueue.add(
        'sync',
        { userId: acc.userId, emailAccountId: acc.id, fullSync: false },
        {
          delay:            i * 2000,
          attempts:         2,
          jobId:            `sync-${acc.id}-${Math.floor(Date.now() / (30 * 60 * 1000))}`, // Idempotent per 30m window
          removeOnComplete: { count: 100 },
          removeOnFail:     { count: 50 },
        },
      );
    }
  }

  // ── Immediately sync a single user (after OAuth connect) ──
  async enqueueSyncForUser(userId: string, emailAccountId: string, fullSync = false): Promise<void> {
    await this.syncQueue.add(
      'sync',
      { userId, emailAccountId, fullSync },
      { priority: 1, attempts: 2, removeOnComplete: { count: 50 } },
    );
    logger.info('Immediate email sync queued', { userId, emailAccountId, fullSync });
  }

  // ── Check for overdue follow-ups ──────────────────────────
  async checkOverdueFollowUps(): Promise<void> {
    const overdue = await this.prisma.followupLog.findMany({
      where: {
        status:      'PENDING',
        scheduledAt: { lte: new Date() },
      },
      include: { application: { select: { status: true, userId: true } } },
      take: 50,
    });

    if (overdue.length === 0) return;
    logger.info(`Found ${overdue.length} overdue follow-ups`);

    const followUpQueue = new Queue('followup-queue', {
      connection: {
        host: process.env['REDIS_HOST'] ?? 'localhost',
        port: parseInt(process.env['REDIS_PORT'] ?? '6379'),
      },
      prefix: process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
    });

    for (const fu of overdue) {
      const terminalStatuses = ['REJECTED', 'OFFER_RECEIVED', 'WITHDRAWN'];
      if (terminalStatuses.includes(fu.application?.status ?? '')) {
        await this.prisma.followupLog.update({
          where: { id: fu.id },
          data:  { status: 'CANCELLED', cancelledReason: 'Terminal application status' },
        });
        continue;
      }

      // Check if job already in queue
      const existing = await followUpQueue.getJob(`followup-${fu.applicationId}-${fu.followUpNumber}`);
      if (existing) continue;

      await followUpQueue.add('send-followup', {
        userId:        fu.userId,
        applicationId: fu.applicationId,
        followUpId:    fu.id,
        followUpNumber: fu.followUpNumber as 1 | 2 | 3,
      }, {
        attempts:  3,
        priority:  2,
        jobId:     `followup-${fu.applicationId}-${fu.followUpNumber}`,
      });
    }

    await followUpQueue.close();
  }

  // ── Cleanup old email data ────────────────────────────────
  async cleanupOldData(): Promise<void> {
    const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000); // 180 days

    const { count } = await this.prisma.emailThread.updateMany({
      where: {
        lastMessageAt: { lt: cutoff },
        status:        { in: ['rejected', 'closed'] },
      },
      data: { rawContent: null }, // Clear body content, keep metadata
    });

    logger.info('Email cleanup complete', { cleared: count });
  }

  stop(): void {
    this.cronJobs.forEach(j => j.stop());
    logger.info('Email sync scheduler stopped');
  }

  async close(): Promise<void> {
    this.stop();
    await this.syncQueue.close();
  }
}
