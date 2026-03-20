// ============================================================
// Gmail API Client
// Wraps Google Gmail REST API v1.
//
// Auth: OAuth2 with automatic token refresh via refresh_token.
// Encrypted tokens are decrypted on load from DB.
//
// Operations:
//   listThreads()      — incremental sync via historyId
//   getThread()        — full thread with all messages
//   getMessage()       — single message with headers + body
//   sendMessage()      — send as user (with reply threading)
//   markAsRead()       — mark message read
//   getProfile()       — get account email address
//   watchInbox()       — Gmail push notification setup
// ============================================================

import type { RawEmail } from '../types/emailTypes.js';
import { logger } from '../utils/logger.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_URL  = 'https://oauth2.googleapis.com/token';

export interface GmailTokens {
  accessToken:  string;
  refreshToken: string;
  expiresAt:    number;    // Unix ms
}

export interface GmailListResult {
  threads:       Array<{ id: string; historyId: string }>;
  nextPageToken: string | null;
  nextHistoryId: string | null;
}

// ─────────────────────────────────────────────────────────────
// TOKEN MANAGEMENT
// ─────────────────────────────────────────────────────────────
export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresAt:   number;
}> {
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env['GOOGLE_CLIENT_ID']!,
      client_secret: process.env['GOOGLE_CLIENT_SECRET']!,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${err}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    expiresAt:   Date.now() + data.expires_in * 1000,
  };
}

async function getValidToken(tokens: GmailTokens): Promise<string> {
  if (tokens.expiresAt - Date.now() > 60_000) {
    return tokens.accessToken; // Still valid for > 1 min
  }
  logger.debug('Gmail token expired — refreshing');
  const refreshed = await refreshAccessToken(tokens.refreshToken);
  tokens.accessToken = refreshed.accessToken;
  tokens.expiresAt   = refreshed.expiresAt;
  return tokens.accessToken;
}

// ─────────────────────────────────────────────────────────────
// BASE REQUEST
// ─────────────────────────────────────────────────────────────
async function gmailRequest<T>(
  tokens:   GmailTokens,
  path:     string,
  opts?:    RequestInit,
): Promise<T> {
  const token = await getValidToken(tokens);

  const res = await fetch(`${GMAIL_BASE}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      ...(opts?.headers ?? {}),
    },
  });

  if (res.status === 401) {
    // Token truly invalid — clear and throw
    throw new Error('Gmail 401: token invalid. User must re-authenticate.');
  }
  if (res.status === 429) {
    // Rate limited — back off
    const retryAfter = parseInt(res.headers.get('Retry-After') ?? '30', 10);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return gmailRequest(tokens, path, opts);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────────────
// LIST THREADS (incremental sync)
// ─────────────────────────────────────────────────────────────
export async function listThreads(
  tokens:    GmailTokens,
  userId:    string = 'me',
  opts?: {
    maxResults?:   number;
    pageToken?:    string;
    query?:        string;   // Gmail search query
    after?:        Date;
  },
): Promise<GmailListResult> {
  const params = new URLSearchParams({
    maxResults: String(opts?.maxResults ?? 100),
  });

  // Build search query: only inbox + sent, exclude promotions/spam
  let q = 'in:anywhere -in:spam -in:trash -in:promotions -in:social ';
  if (opts?.after) {
    const unixSec = Math.floor(opts.after.getTime() / 1000);
    q += `after:${unixSec} `;
  }
  if (opts?.query) q += opts.query;
  params.set('q', q.trim());

  if (opts?.pageToken) params.set('pageToken', opts.pageToken);

  const data = await gmailRequest<{
    threads?: Array<{ id: string; snippet: string }>;
    nextPageToken?: string;
    resultSizeEstimate?: number;
  }>(tokens, `/users/${userId}/threads?${params}`);

  return {
    threads:       (data.threads ?? []).map(t => ({ id: t.id, historyId: '' })),
    nextPageToken: data.nextPageToken ?? null,
    nextHistoryId: null,
  };
}

// ─────────────────────────────────────────────────────────────
// GET THREAD (all messages in conversation)
// ─────────────────────────────────────────────────────────────
export async function getThread(
  tokens:   GmailTokens,
  threadId: string,
  userEmail: string,
  userId:   string = 'me',
): Promise<RawEmail[]> {
  const data = await gmailRequest<{
    messages: GmailMessage[];
  }>(tokens, `/users/${userId}/threads/${threadId}?format=full`);

  return (data.messages ?? []).map(msg => parseGmailMessage(msg, userEmail));
}

// ─────────────────────────────────────────────────────────────
// GET SINGLE MESSAGE
// ─────────────────────────────────────────────────────────────
export async function getMessage(
  tokens:    GmailTokens,
  messageId: string,
  userEmail: string,
  userId:    string = 'me',
): Promise<RawEmail | null> {
  try {
    const msg = await gmailRequest<GmailMessage>(
      tokens,
      `/users/${userId}/messages/${messageId}?format=full`
    );
    return parseGmailMessage(msg, userEmail);
  } catch (err) {
    logger.warn('getMessage failed', { messageId, error: String(err) });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// SEND MESSAGE
// ─────────────────────────────────────────────────────────────
export async function sendMessage(
  tokens:      GmailTokens,
  opts: {
    to:          string;
    toName?:     string;
    from:        string;
    fromName?:   string;
    subject:     string;
    bodyText:    string;
    bodyHtml:    string;
    inReplyTo?:  string;   // Message-ID header of original
    threadId?:   string;   // Gmail thread ID for threading
    references?: string;   // References header chain
  },
  userId: string = 'me',
): Promise<{ messageId: string; threadId: string }> {

  const toFmt   = opts.toName   ? `"${opts.toName}" <${opts.to}>`   : opts.to;
  const fromFmt = opts.fromName ? `"${opts.fromName}" <${opts.from}>` : opts.from;

  // Build RFC 2822 MIME message
  const boundary   = `boundary_${Date.now().toString(36)}`;
  const messageId  = `<${Date.now()}.${Math.random().toString(36).slice(2)}@jobhunterai.app>`;

  let raw = [
    `From: ${fromFmt}`,
    `To: ${toFmt}`,
    `Subject: ${opts.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  if (opts.inReplyTo) {
    raw.push(`In-Reply-To: ${opts.inReplyTo}`);
    raw.push(`References: ${opts.references ?? opts.inReplyTo}`);
  }

  raw = [
    ...raw,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    opts.bodyText,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    opts.bodyHtml,
    '',
    `--${boundary}--`,
  ];

  const rawMsg = raw.join('\r\n');
  const encoded = Buffer.from(rawMsg).toString('base64url');

  const body: Record<string, unknown> = { raw: encoded };
  if (opts.threadId) body['threadId'] = opts.threadId;

  const result = await gmailRequest<{ id: string; threadId: string }>(
    tokens,
    `/users/${userId}/messages/send`,
    { method: 'POST', body: JSON.stringify(body) },
  );

  logger.info('Gmail message sent', { to: opts.to, subject: opts.subject, messageId: result.id });
  return { messageId: result.id, threadId: result.threadId };
}

// ─────────────────────────────────────────────────────────────
// MARK AS READ
// ─────────────────────────────────────────────────────────────
export async function markAsRead(
  tokens:    GmailTokens,
  messageId: string,
  userId:    string = 'me',
): Promise<void> {
  await gmailRequest(tokens, `/users/${userId}/messages/${messageId}/modify`, {
    method: 'POST',
    body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
  });
}

// ─────────────────────────────────────────────────────────────
// GET PROFILE
// ─────────────────────────────────────────────────────────────
export async function getProfile(
  tokens: GmailTokens,
  userId: string = 'me',
): Promise<{ email: string; messagesTotal: number; historyId: string }> {
  return gmailRequest(tokens, `/users/${userId}/profile`);
}

// ─────────────────────────────────────────────────────────────
// SETUP PUSH NOTIFICATIONS (Gmail Watch)
// ─────────────────────────────────────────────────────────────
export async function setupWatch(
  tokens:    GmailTokens,
  topicName: string,   // GCP Pub/Sub topic
  userId:    string = 'me',
): Promise<{ historyId: string; expiration: string }> {
  return gmailRequest(tokens, `/users/${userId}/watch`, {
    method: 'POST',
    body: JSON.stringify({
      labelIds:  ['INBOX', 'SENT'],
      topicName,
    }),
  });
}

// ─────────────────────────────────────────────────────────────
// INTERNAL: Parse Gmail API message to RawEmail
// ─────────────────────────────────────────────────────────────
interface GmailMessage {
  id:        string;
  threadId:  string;
  payload:   { headers: Array<{ name: string; value: string }>; parts?: GmailPart[]; body?: { data?: string } };
  internalDate: string;
  labelIds:  string[];
}
interface GmailPart {
  mimeType: string;
  body:     { data?: string; size: number };
  parts?:   GmailPart[];
}

function getHeader(msg: GmailMessage, name: string): string {
  return msg.payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decodeBase64(data: string): string {
  try { return Buffer.from(data, 'base64url').toString('utf-8'); } catch { return ''; }
}

function extractBody(part: GmailPart | GmailMessage['payload'], mime: string): string {
  if ('mimeType' in part && (part as GmailPart).mimeType === mime) {
    return decodeBase64((part as GmailPart).body?.data ?? '');
  }
  const parts = (part as GmailPart).parts ?? [];
  for (const p of parts) {
    const found = extractBody(p, mime);
    if (found) return found;
  }
  // Root level body
  if ('body' in part && (part as { body?: { data?: string } }).body?.data) {
    return decodeBase64((part as { body: { data: string } }).body.data);
  }
  return '';
}

function parseEmailAddress(raw: string): { email: string; name: string | null } {
  const m = raw.match(/^"?([^"<]+)"?\s*<([^>]+)>$/);
  if (m) return { email: m[2]!.trim(), name: m[1]!.trim() || null };
  return { email: raw.trim(), name: null };
}

function parseGmailMessage(msg: GmailMessage, userEmail: string): RawEmail {
  const from    = parseEmailAddress(getHeader(msg, 'From'));
  const to      = parseEmailAddress(getHeader(msg, 'To'));
  const subject = getHeader(msg, 'Subject');
  const msgId   = getHeader(msg, 'Message-ID');
  const inReplyTo = getHeader(msg, 'In-Reply-To') || null;

  const bodyText = extractBody(msg.payload, 'text/plain');
  const bodyHtml = extractBody(msg.payload, 'text/html');

  return {
    messageId:   msgId || msg.id,
    threadId:    msg.threadId,
    externalId:  msg.id,
    subject:     subject || '(no subject)',
    fromEmail:   from.email,
    fromName:    from.name,
    toEmail:     to.email,
    toName:      to.name,
    bodyText:    bodyText || stripHtml(bodyHtml),
    bodyHtml:    bodyHtml || null,
    receivedAt:  new Date(parseInt(msg.internalDate)),
    isFromUser:  from.email.toLowerCase() === userEmail.toLowerCase(),
    inReplyTo,
    labels:      msg.labelIds ?? [],
  };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
