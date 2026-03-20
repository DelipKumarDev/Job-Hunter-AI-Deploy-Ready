// ============================================================
// Follow-Up Email Composer
// Generates personalised, professional follow-up emails using
// Claude claude-sonnet-4-6. Each follow-up is contextually
// different — not just a copy of the previous.
//
// Follow-up cadence:
//   #1 (day 3):  Short, warm check-in. Express continued interest.
//   #2 (day 7):  Acknowledge delay, add brief value statement.
//   #3 (day 14): Final polite follow-up, explicit call to action.
//
// Tone: professional, concise, never desperate or pushy.
// Subject: auto-generated RE: original or custom per number.
// Each email references prior context for continuity.
// ============================================================

import type { FollowUpContext, GeneratedFollowUp } from '../types/emailTypes.js';
import { logger } from '../utils/logger.js';

// ── System prompt for all follow-ups ─────────────────────────
const SYSTEM_PROMPT = `You are a career coach helping job seekers write professional, concise follow-up emails to recruiters.

Rules:
- Be warm but professional. Never sound desperate or needy.
- Keep emails SHORT: 3-5 sentences max for #1, 4-6 for #2, 5-7 for #3.
- Always reference the specific role and company name.
- Never use hollow phrases: "circle back", "touch base", "ping", "synergy".
- Never use ALL CAPS or excessive exclamation marks.
- End with a clear, low-pressure ask (1 question max).
- Sign with the candidate's first name only.
- Return ONLY valid JSON — no markdown, no preamble.`;

// ── Per-number prompts ────────────────────────────────────────
function buildPrompt(ctx: FollowUpContext): string {
  const daysMap: Record<1 | 2 | 3, string> = {
    1: '3 days',
    2: '7 days',
    3: '14 days',
  };
  const days = daysMap[ctx.followUpNumber];

  const recruiterGreeting = ctx.recruiterName
    ? `Hi ${ctx.recruiterName.split(' ')[0]}`
    : 'Hi';

  const prevContext = ctx.previousEmails.length > 0
    ? `Previous emails in thread:\n${ctx.previousEmails
        .slice(-3)
        .map(e => `[${e.role === 'sent' ? 'Candidate' : 'Recruiter'} on ${e.date.toDateString()}]: ${e.content.slice(0, 150)}`)
        .join('\n')}`
    : 'This is the first follow-up (no prior reply from recruiter).';

  const toneGuide = {
    1: 'Warm, curious check-in. Very brief. Show continued interest. Assume the recruiter is just busy.',
    2: 'Politely acknowledge time has passed. Add one genuine sentence about why you\'re excited about the role/company specifically.',
    3: 'Final follow-up. Acknowledge this is your last message. Explicitly say you\'ll stop if not the right time. Keep a door open.',
  }[ctx.followUpNumber];

  return `Generate a follow-up email for the job application below. ${days} have passed since application.

Context:
- Candidate: ${ctx.candidateName} (${ctx.candidateEmail})
- Role: ${ctx.jobTitle} at ${ctx.companyName}
- Applied: ${ctx.applicationDate.toDateString()}
- Follow-up number: ${ctx.followUpNumber} of 3
- Recruiter: ${recruiterGreeting} (${ctx.recruiterEmail})
- LinkedIn: ${ctx.linkedinUrl ?? 'not provided'}

${prevContext}

Tone guide: ${toneGuide}

Reply ONLY with valid JSON:
{
  "subject": "string (RE: [job title] - [company] if replying, or fresh subject)",
  "bodyText": "string (plain text, \\n for newlines)",
  "bodyHtml": "string (HTML version with <p> tags, no full HTML document)",
  "tone": "warm" | "professional" | "brief"
}`;
}

// ─────────────────────────────────────────────────────────────
// MAIN COMPOSER FUNCTION
// ─────────────────────────────────────────────────────────────
export async function composeFollowUp(
  ctx: FollowUpContext,
): Promise<GeneratedFollowUp> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  logger.info('Composing follow-up email', {
    followUpNumber: ctx.followUpNumber,
    company:        ctx.companyName,
    job:            ctx.jobTitle,
    candidate:      ctx.candidateName,
  });

  const startMs = Date.now();

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 600,
      temperature: 0.7,    // Slight variation so emails feel unique
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: buildPrompt(ctx) }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json() as {
    content: Array<{ type: string; text: string }>;
    usage:   { input_tokens: number; output_tokens: number };
  };

  const raw  = data.content.find(c => c.type === 'text')?.text ?? '{}';
  const json = JSON.parse(raw.replace(/```json|```/g, '').trim()) as {
    subject:  string;
    bodyText: string;
    bodyHtml: string;
    tone:     'warm' | 'professional' | 'brief';
  };

  const wordCount = (json.bodyText ?? '').split(/\s+/).filter(Boolean).length;
  const tokensUsed = (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0);

  logger.info('Follow-up composed', {
    followUpNumber: ctx.followUpNumber,
    words:      wordCount,
    tokens:     tokensUsed,
    durationMs: Date.now() - startMs,
  });

  return {
    subject:    json.subject   ?? fallbackSubject(ctx),
    bodyText:   json.bodyText  ?? fallbackBodyText(ctx),
    bodyHtml:   json.bodyHtml  ?? textToHtml(json.bodyText ?? fallbackBodyText(ctx)),
    tone:       json.tone      ?? 'professional',
    wordCount,
    tokensUsed,
  };
}

// ─────────────────────────────────────────────────────────────
// FALLBACK TEMPLATES (if Claude fails)
// ─────────────────────────────────────────────────────────────
function fallbackSubject(ctx: FollowUpContext): string {
  return `Following up: ${ctx.jobTitle} at ${ctx.companyName}`;
}

export function fallbackBodyText(ctx: FollowUpContext): string {
  const greeting = ctx.recruiterName
    ? `Hi ${ctx.recruiterName.split(' ')[0]},`
    : 'Hi,';

  const templates: Record<1 | 2 | 3, string> = {
    1: `${greeting}

I wanted to follow up on my application for the ${ctx.jobTitle} role at ${ctx.companyName}, which I submitted on ${ctx.applicationDate.toDateString()}.

I remain very interested in the opportunity and would love to learn more about next steps when it's convenient for you.

Thank you for your time.
${ctx.candidateName.split(' ')[0]}`,

    2: `${greeting}

I hope you're doing well. I'm reaching out to follow up on my application for the ${ctx.jobTitle} position at ${ctx.companyName}.

I continue to be excited about this opportunity — the work your team is doing is genuinely compelling, and I believe my background is a strong fit.

Would you have a few minutes this week for a quick call? Happy to work around your schedule.

Best,
${ctx.candidateName.split(' ')[0]}`,

    3: `${greeting}

I wanted to send one final follow-up on my application for the ${ctx.jobTitle} role at ${ctx.companyName}.

I understand you're likely managing many applications, and I completely respect if the timing isn't right or the role is moving in a different direction. If you're still evaluating candidates, I'd love to stay in consideration.

Either way, thank you for your time, and I wish you and the team well.

Best,
${ctx.candidateName.split(' ')[0]}`,
  };

  return templates[ctx.followUpNumber];
}

function textToHtml(text: string): string {
  const paragraphs = text
    .split(/\n\n+/)
    .map(p => `<p style="margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#333">${p.replace(/\n/g, '<br/>')}</p>`)
    .join('');
  return `<div style="max-width:600px;margin:0 auto;padding:24px">${paragraphs}</div>`;
}

// ─────────────────────────────────────────────────────────────
// COMPUTE FOLLOW-UP SEND DATES
// ─────────────────────────────────────────────────────────────
export function computeFollowUpDates(applicationDate: Date): {
  followUp1: Date;   // +3 business days
  followUp2: Date;   // +7 business days
  followUp3: Date;   // +14 business days
} {
  return {
    followUp1: addBusinessDays(applicationDate, 3),
    followUp2: addBusinessDays(applicationDate, 7),
    followUp3: addBusinessDays(applicationDate, 14),
  };
}

function addBusinessDays(date: Date, days: number): Date {
  let result = new Date(date);
  let added  = 0;

  while (added < days) {
    result = new Date(result.getTime() + 86400 * 1000);
    const dow = result.getDay();
    if (dow !== 0 && dow !== 6) added++; // Skip weekends
  }

  // Send at 9am in user's local time (not 3am UTC)
  result.setHours(9, 0, 0, 0);
  return result;
}
