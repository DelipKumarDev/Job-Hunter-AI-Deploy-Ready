// ============================================================
// WhatsApp Notification API Routes
//
// Webhook
//   GET  /api/v1/whatsapp/webhook          — Meta verify challenge
//   POST /api/v1/whatsapp/webhook          — Inbound messages + status
//
// Management
//   GET  /api/v1/whatsapp/status           — Phone number + health
//   POST /api/v1/whatsapp/test             — Send test message
//   POST /api/v1/whatsapp/notify           — Manually trigger notification
//   GET  /api/v1/notifications             — List user notifications
//   PUT  /api/v1/notifications/:id/read    — Mark as read
//   POST /api/v1/notifications/read-all   — Mark all read
// ============================================================

import { Router }    from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import * as waClient from '../whatsapp/waClient.js';
import { enqueueNotification } from '../processors/notificationWorker.js';
import { logger } from '../utils/logger.js';

export const whatsappRouter = Router();
const prisma = new PrismaClient();

// ── GET /webhook — Meta hub verification ──────────────────────
whatsappRouter.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query as Record<string, string>;
  const result = waClient.verifyWebhook(mode ?? '', token ?? '', challenge ?? '');
  if (result) return res.status(200).send(result);
  return res.sendStatus(403);
});

// ── POST /webhook — Inbound messages + delivery status ────────
whatsappRouter.post('/webhook', async (req, res) => {
  // Always ACK immediately — WhatsApp retries on non-2xx
  res.sendStatus(200);

  try {
    const rawBody = JSON.stringify(req.body);

    // Verify signature
    const sig = req.headers['x-hub-signature-256'] as string ?? '';
    if (!waClient.validateSignature(rawBody, sig)) {
      logger.warn('WhatsApp webhook: invalid signature');
      return;
    }

    const { messages, statuses } = waClient.parseWebhookPayload(req.body);

    // ── Handle inbound messages (user replies) ────────────
    for (const msg of messages) {
      logger.info('WhatsApp inbound message', {
        from:    msg.from,
        type:    msg.type,
        text:    msg.text?.body?.slice(0, 100),
        buttonId: msg.interactive?.button_reply?.id ?? msg.button?.payload,
      });

      // Handle button replies from interactive messages
      if (msg.type === 'interactive' && msg.interactive?.button_reply) {
        await handleButtonReply(msg.from, msg.interactive.button_reply.id);
      }

      // Store inbound message for user (future: reply from WA)
      await prisma.notification.create({
        data: {
          userId:  await findUserByPhone(prisma, msg.from) ?? '',
          type:    'WHATSAPP_REPLY',
          channel: 'WHATSAPP',
          title:   'WhatsApp reply received',
          body:    msg.text?.body ?? msg.button?.text ?? '',
          data:    msg as unknown as import('@prisma/client').Prisma.JsonObject,
          isSent:  true,
          isRead:  false,
        },
      }).catch(() => null);
    }

    // ── Handle delivery status updates ─────────────────────
    for (const status of statuses) {
      logger.debug('WhatsApp delivery status', {
        id:     status.id,
        status: status.status,
        to:     status.recipient_id,
      });

      if (status.status === 'failed' && status.errors?.length) {
        logger.error('WhatsApp delivery failed', {
          id:     status.id,
          errors: status.errors,
        });
      }
    }

  } catch (err) {
    logger.error('WhatsApp webhook error', { error: String(err) });
  }
});

// ── GET /status — Phone number info ───────────────────────────
whatsappRouter.get('/status', async (req, res, next) => {
  try {
    const info = await waClient.getPhoneNumberInfo();
    res.json({ success: true, data: info ?? { error: 'Could not fetch phone info' } });
  } catch (err) { next(err); }
});

// ── POST /test — Send test message to current user ────────────
const TestSchema = z.object({
  message: z.string().max(500).optional(),
});

whatsappRouter.post('/test', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { message } = TestSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: { name: true, profile: { select: { whatsappNumber: true, phone: true } } },
    });

    const phone = user?.profile?.whatsappNumber ?? user?.profile?.phone;
    if (!phone) {
      return res.status(400).json({ success: false, error: 'No WhatsApp number on your profile' });
    }

    const testMsg = message ?? [
      `👋 *Job Hunter AI Test Message*`,
      ``,
      `Hello ${user?.name ?? 'there'}! Your WhatsApp notifications are working correctly.`,
      ``,
      `You'll receive updates here when:`,
      `  • You have an interview scheduled 🗓️`,
      `  • A recruiter replies to your application 📧`,
      `  • A follow-up email is sent on your behalf 📤`,
      `  • You receive a job offer 🎊`,
      ``,
      `_Reply STOP to pause notifications._`,
    ].join('\n');

    const result = await waClient.sendText(phone, testMsg);
    return res.json({ success: result.success, data: result });
  } catch (err) { next(err); }
});

// ── POST /notify — Manually trigger notification ──────────────
const NotifySchema = z.object({
  event:         z.string(),
  applicationId: z.string().uuid().optional(),
  rawData:       z.record(z.unknown()).optional(),
});

whatsappRouter.post('/notify', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const body   = NotifySchema.parse(req.body);

    await enqueueNotification({
      userId,
      event:         body.event as WhatsAppJobPayload['event'],
      applicationId: body.applicationId,
      rawData:       body.rawData,
    }, 1);

    return res.json({ success: true, data: { message: 'Notification queued' } });
  } catch (err) { next(err); }
});

// ── GET /notifications — List user notifications ──────────────
whatsappRouter.get('/notifications', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const page   = parseInt(req.query['page'] as string ?? '1', 10);
    const limit  = Math.min(parseInt(req.query['limit'] as string ?? '50', 10), 100);
    const skip   = (page - 1) * limit;

    const [total, notifications] = await Promise.all([
      prisma.notification.count({ where: { userId } }),
      prisma.notification.findMany({
        where:   { userId },
        orderBy: { createdAt: 'desc' },
        skip, take: limit,
        select: {
          id: true, type: true, channel: true, title: true,
          body: true, isRead: true, isSent: true, createdAt: true,
        },
      }),
    ]);

    const unreadCount = await prisma.notification.count({ where: { userId, isRead: false } });

    return res.json({
      success: true,
      data: {
        notifications,
        unreadCount,
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (err) { next(err); }
});

// ── PUT /notifications/:id/read ───────────────────────────────
whatsappRouter.put('/notifications/:id/read', async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { id: req.params!['id'], userId: req.user!.id },
      data:  { isRead: true },
    });
    return res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /notifications/read-all ──────────────────────────────
whatsappRouter.post('/notifications/read-all', async (req, res, next) => {
  try {
    const { count } = await prisma.notification.updateMany({
      where: { userId: req.user!.id, isRead: false },
      data:  { isRead: true },
    });
    return res.json({ success: true, data: { marked: count } });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
async function findUserByPhone(prisma: PrismaClient, phone: string): Promise<string | null> {
  const profile = await prisma.profile.findFirst({
    where: {
      OR: [
        { whatsappNumber: { contains: phone } },
        { phone:          { contains: phone } },
      ],
    },
    select: { userId: true },
  });
  return profile?.userId ?? null;
}

async function handleButtonReply(fromPhone: string, buttonId: string): Promise<void> {
  // Future: handle "View Application" / "Open Email" button taps
  // For now, just log
  logger.info('WhatsApp button tap', { fromPhone, buttonId });
}

// Re-export types needed by routes file
type WhatsAppJobPayload = import('../types/notificationTypes.js').WhatsAppJobPayload;
