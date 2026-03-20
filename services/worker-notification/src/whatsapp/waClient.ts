/**
 * ============================================================
 * WhatsApp Cloud API Client
 *
 * All tokens are supplied via the secrets object, never via
 * process.env.  Token values are NEVER included in log output.
 * ============================================================
 */

import { createHmac } from 'node:crypto';
import { logger }     from '../utils/logger.js';
import type { NotificationWorkerSecrets } from '@job-hunter/shared/secrets';

const WA_API_VERSION = 'v19.0';
const WA_BASE_URL    = 'https://graph.facebook.com';
const PHONE_ID       = process.env['WHATSAPP_PHONE_NUMBER_ID'] ?? '';

export interface WaTextMessage {
  to:   string;
  body: string;
}

export interface WaTemplateMessage {
  to:           string;
  templateName: string;
  languageCode: string;
  components?:  unknown[];
}

/** Send a plain-text WhatsApp message */
export async function sendTextMessage(
  msg: WaTextMessage,
  secrets: Pick<NotificationWorkerSecrets, 'WHATSAPP_ACCESS_TOKEN'>,
): Promise<void> {
  await waPost(`/${PHONE_ID}/messages`, {
    messaging_product: 'whatsapp',
    to: msg.to,
    type: 'text',
    text: { body: msg.body },
  }, secrets.WHATSAPP_ACCESS_TOKEN);
}

/** Send a template-based WhatsApp message */
export async function sendTemplateMessage(
  msg: WaTemplateMessage,
  secrets: Pick<NotificationWorkerSecrets, 'WHATSAPP_ACCESS_TOKEN'>,
): Promise<void> {
  await waPost(`/${PHONE_ID}/messages`, {
    messaging_product: 'whatsapp',
    to: msg.to,
    type: 'template',
    template: {
      name:     msg.templateName,
      language: { code: msg.languageCode },
      components: msg.components ?? [],
    },
  }, secrets.WHATSAPP_ACCESS_TOKEN);
}

/** Verify webhook signature — uses WHATSAPP_APP_SECRET */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  appSecret: string,
): boolean {
  if (!appSecret) {
    logger.warn('WHATSAPP_APP_SECRET not configured — skipping signature check');
    return false;
  }
  const expected = `sha256=${createHmac('sha256', appSecret).update(payload).digest('hex')}`;
  return expected === signature;
}

/** Verify webhook challenge — uses WHATSAPP_VERIFY_TOKEN */
export function verifyWebhookChallenge(
  mode:        string,
  token:       string,
  challenge:   string,
  verifyToken: string,
): string | null {
  if (mode === 'subscribe' && token === verifyToken) return challenge;
  return null;
}

// ── Internal ─────────────────────────────────────────────────

async function waPost(path: string, body: unknown, accessToken: string): Promise<void> {
  const url = `${WA_BASE_URL}/${WA_API_VERSION}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Token in Authorization header — never logged
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // Log status + error type; never log the access token or response body
    // that might echo it back
    const errText = await res.text().catch(() => '');
    logger.error('WhatsApp API error', {
      status: res.status,
      path,
      // Truncate error to avoid leaking token from mirrored error bodies
      error: errText.substring(0, 200),
    });
    throw new Error(`WhatsApp API returned ${res.status}`);
  }
}
