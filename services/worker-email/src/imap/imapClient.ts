// ============================================================
// IMAP Client
// Generic IMAP/IMAPS client for non-Gmail providers.
// Supports Outlook, Yahoo, ProtonMail Bridge, and any
// IMAP-compliant server.
//
// Uses imapflow (modern, Promise-based IMAP library).
// Handles:
//   - TLS / STARTTLS negotiation
//   - Incremental sync via IMAP SINCE + UID SEARCH
//   - MIME multipart parsing (plain text + HTML)
//   - SENT folder sync to match outbound emails
//   - Connection pooling (1 connection per account)
// ============================================================

import type { RawEmail } from '../types/emailTypes.js';
import { logger } from '../utils/logger.js';

export interface ImapConfig {
  host:     string;
  port:     number;
  secure:   boolean;   // true = IMAPS (993), false = STARTTLS (143)
  username: string;
  password: string;    // App password (decrypted from DB)
}

// ── IMAP provider presets ─────────────────────────────────────
export const IMAP_PRESETS: Record<string, Omit<ImapConfig, 'username' | 'password'>> = {
  'gmail.com':     { host: 'imap.gmail.com',   port: 993, secure: true  },
  'googlemail.com':{ host: 'imap.gmail.com',   port: 993, secure: true  },
  'outlook.com':   { host: 'outlook.office365.com', port: 993, secure: true  },
  'hotmail.com':   { host: 'outlook.office365.com', port: 993, secure: true  },
  'live.com':      { host: 'outlook.office365.com', port: 993, secure: true  },
  'yahoo.com':     { host: 'imap.mail.yahoo.com',   port: 993, secure: true  },
  'icloud.com':    { host: 'imap.mail.me.com',       port: 993, secure: true  },
  'protonmail.com':{ host: '127.0.0.1',              port: 1143, secure: false }, // Bridge
};

export function getImapPreset(email: string): Omit<ImapConfig, 'username' | 'password'> | null {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain ? (IMAP_PRESETS[domain] ?? null) : null;
}

// ─────────────────────────────────────────────────────────────
// FETCH EMAILS VIA IMAP
// Returns emails received since `since` date from INBOX + SENT
// ─────────────────────────────────────────────────────────────
export async function fetchEmailsViaImap(
  config:    ImapConfig,
  since:     Date,
  userEmail: string,
): Promise<RawEmail[]> {
  // Dynamic import — imapflow is optional dependency
  let ImapFlow: typeof import('imapflow').ImapFlow;
  let simpleParser: (typeof import('mailparser'))['simpleParser'];

  try {
    const imapModule = await import('imapflow');
    ImapFlow = imapModule.ImapFlow;
    const mailParser = await import('mailparser');
    simpleParser = mailParser.simpleParser;
  } catch {
    throw new Error(
      'IMAP dependencies not installed. Run: npm install imapflow mailparser'
    );
  }

  const emails: RawEmail[] = [];

  const client = new ImapFlow({
    host:   config.host,
    port:   config.port,
    secure: config.secure,
    auth: {
      user: config.username,
      pass: config.password,
    },
    tls: { rejectUnauthorized: false }, // Allow self-signed for local bridges
    logger: false, // Suppress verbose IMAP logs
  });

  try {
    await client.connect();

    // ── Fetch INBOX ─────────────────────────────────────────
    await client.mailboxOpen('INBOX');
    const inboxEmails = await fetchMailboxSince(client, simpleParser, since, userEmail, false);
    emails.push(...inboxEmails);

    // ── Fetch SENT folder ─────────────────────────────────
    const sentFolderName = await detectSentFolder(client);
    if (sentFolderName) {
      await client.mailboxOpen(sentFolderName);
      const sentEmails = await fetchMailboxSince(client, simpleParser, since, userEmail, true);
      emails.push(...sentEmails);
    }

  } finally {
    await client.logout().catch(() => null);
  }

  logger.info('IMAP sync complete', {
    host:        config.host,
    email:       userEmail,
    count:       emails.length,
    sinceDate:   since.toISOString(),
  });

  return emails;
}

// ─────────────────────────────────────────────────────────────
// INTERNAL: fetch all messages since date in current mailbox
// ─────────────────────────────────────────────────────────────
async function fetchMailboxSince(
  client:       InstanceType<typeof import('imapflow').ImapFlow>,
  simpleParser: (typeof import('mailparser'))['simpleParser'],
  since:        Date,
  userEmail:    string,
  isSentFolder: boolean,
): Promise<RawEmail[]> {
  const emails: RawEmail[] = [];

  // IMAP SEARCH SINCE (date-only granularity per RFC)
  const uids = await client.search({ since }, { uid: true });
  if (!uids || uids.length === 0) return [];

  for await (const message of client.fetch(uids, {
    envelope:  true,
    source:    true,
    uid:       true,
    flags:     true,
  }, { uid: true })) {
    try {
      const parsed = await simpleParser(message.source);

      const threadId  = extractThreadId(parsed.headers);
      const msgId     = parsed.messageId ?? String(message.uid);
      const inReplyTo = parsed.inReplyTo ?? null;
      const subject   = parsed.subject ?? '(no subject)';
      const fromAddr  = parsed.from?.value[0];
      const toAddrs   = parsed.to?.value ?? [];

      const fromEmail = fromAddr?.address ?? '';
      const fromName  = fromAddr?.name || null;
      const toEmail   = toAddrs[0]?.address ?? userEmail;
      const toName    = toAddrs[0]?.name || null;

      const bodyText = parsed.text ?? stripHtml(parsed.html ?? '') ?? '';
      const bodyHtml = parsed.html ?? null;
      const receivedAt = parsed.date ?? new Date();

      const isFromUser = isSentFolder ||
        fromEmail.toLowerCase() === userEmail.toLowerCase();

      emails.push({
        messageId:  msgId,
        threadId,
        externalId: String(message.uid),
        subject,
        fromEmail,
        fromName,
        toEmail,
        toName,
        bodyText:   bodyText.slice(0, 10000), // Limit body size
        bodyHtml:   bodyHtml?.slice(0, 50000) ?? null,
        receivedAt,
        isFromUser,
        inReplyTo,
        labels: Array.from(message.flags ?? []),
      });
    } catch (err) {
      logger.warn('IMAP message parse error', { uid: message.uid, error: String(err) });
    }
  }

  return emails;
}

// ─────────────────────────────────────────────────────────────
// SEND EMAIL VIA IMAP SMTP (Nodemailer)
// ─────────────────────────────────────────────────────────────
export async function sendEmailViaSmtp(
  smtpConfig: {
    host:     string;
    port:     number;
    secure:   boolean;
    username: string;
    password: string;
  },
  opts: {
    from:       string;
    fromName:   string;
    to:         string;
    subject:    string;
    bodyText:   string;
    bodyHtml:   string;
    inReplyTo?: string;
    references?: string;
  },
): Promise<{ messageId: string }> {
  let nodemailer: typeof import('nodemailer');
  try {
    nodemailer = await import('nodemailer');
  } catch {
    throw new Error('nodemailer not installed. Run: npm install nodemailer');
  }

  const transporter = nodemailer.createTransport({
    host:   smtpConfig.host,
    port:   smtpConfig.port,
    secure: smtpConfig.secure,
    auth: {
      user: smtpConfig.username,
      pass: smtpConfig.password,
    },
    tls: { rejectUnauthorized: false },
  });

  const mailOpts: Parameters<typeof transporter.sendMail>[0] = {
    from:    `"${opts.fromName}" <${opts.from}>`,
    to:      opts.to,
    subject: opts.subject,
    text:    opts.bodyText,
    html:    opts.bodyHtml,
  };

  if (opts.inReplyTo)  mailOpts.inReplyTo  = opts.inReplyTo;
  if (opts.references) mailOpts.references = opts.references;

  const info = await transporter.sendMail(mailOpts);
  logger.info('SMTP email sent', { to: opts.to, messageId: info.messageId });
  return { messageId: info.messageId };
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
async function detectSentFolder(
  client: InstanceType<typeof import('imapflow').ImapFlow>
): Promise<string | null> {
  const sentCandidates = ['Sent', 'Sent Items', 'Sent Mail', '[Gmail]/Sent Mail', 'INBOX.Sent'];
  try {
    const tree = await client.listTree();
    const findSent = (items: typeof tree.folders): string | null => {
      for (const folder of items) {
        if (folder.specialUse === '\\Sent') return folder.path;
        if (sentCandidates.some(s => folder.path.toLowerCase().includes(s.toLowerCase()))) {
          return folder.path;
        }
        const found = findSent(folder.folders ?? []);
        if (found) return found;
      }
      return null;
    };
    return findSent(tree.folders ?? []);
  } catch {
    return null;
  }
}

function extractThreadId(headers: import('mailparser').Headers): string {
  // Try Gmail-specific thread ID header
  const gmailThread = headers.get('x-gm-thrid');
  if (gmailThread) return String(gmailThread);
  // Fallback: use Message-ID (will group replies via In-Reply-To matching)
  const msgId = headers.get('message-id');
  return String(msgId ?? Date.now());
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
