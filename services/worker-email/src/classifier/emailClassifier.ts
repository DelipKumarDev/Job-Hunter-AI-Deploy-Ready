// ============================================================
// Email Classifier
// Classifies recruiter emails into structured categories.
//
// 3-layer classification:
//  Layer 1: Regex patterns (fast, high precision)
//             → definitive results skip Claude
//  Layer 2: Keyword scoring matrix
//             → medium confidence results
//  Layer 3: Claude Haiku (authoritative)
//             → for ambiguous emails only
//
// Output: EmailClassification + confidence 0–1
// Matches emails to applications via company/job title lookup
// ============================================================

import type { RawEmail, EmailClassification } from '../types/emailTypes.js';
import { logger } from '../utils/logger.js';

// ── Classification result ─────────────────────────────────────
export interface ClassificationResult {
  classification:       EmailClassification;
  confidence:           number;           // 0–1
  companyName:          string | null;
  jobTitle:             string | null;
  recruiterName:        string | null;
  isAutoReply:          boolean;
  requiresAction:       boolean;          // interview invite, offer
  shouldStopFollowUps:  boolean;          // rejection, reply, offer
  sentiment:            'positive' | 'negative' | 'neutral';
  extractedDate:        Date | null;      // Interview date if mentioned
  method:               'regex' | 'keyword' | 'claude';
}

// ── Auto-reply detection patterns ────────────────────────────
const AUTO_REPLY_PATTERNS = [
  /out of office/i,
  /auto.?reply/i,
  /automatic reply/i,
  /i am (currently )?out/i,
  /i'm (currently )?out/i,
  /away from (the )?office/i,
  /on (vacation|leave|holiday)/i,
  /will (be )?back (on|in)/i,
  /do not reply to this email/i,
  /this is an automated/i,
  /this message was sent automatically/i,
  /noreply|no-reply|donotreply/i,
];

// ── Regex patterns (Layer 1) ──────────────────────────────────
const REGEX_RULES: Array<{
  pattern: RegExp;
  classification: EmailClassification;
  confidence: number;
}> = [
  // Rejection (most important to detect early)
  { pattern: /we('ve| have) decided (not to|to move forward with other|to pursue other)/i, classification: 'rejection', confidence: 0.97 },
  { pattern: /not (be moving forward|moving forward|selected|proceeding|advancing)/i,      classification: 'rejection', confidence: 0.95 },
  { pattern: /position has been filled/i,                                                   classification: 'rejection', confidence: 0.99 },
  { pattern: /we regret to inform|we('re| are) sorry to (say|inform|let you know)/i,        classification: 'rejection', confidence: 0.95 },
  { pattern: /thank you for your (interest|application|time).{0,100}(unfortunately|however)/is, classification: 'rejection', confidence: 0.93 },
  { pattern: /unfortunately.{0,50}(we|our team|the hiring team)/i,                         classification: 'rejection', confidence: 0.90 },
  { pattern: /decided to (move forward|proceed|go) with (other|another|different)/i,       classification: 'rejection', confidence: 0.95 },

  // Interview invite
  { pattern: /would (you |like to )?schedule (an |a )?interview/i,                         classification: 'interview_invite', confidence: 0.97 },
  { pattern: /invite you (to|for) (an |a )?(interview|chat|call|meeting)/i,                classification: 'interview_invite', confidence: 0.97 },
  { pattern: /(phone|video|technical|onsite|virtual) (screen|interview|call)/i,            classification: 'interview_invite', confidence: 0.90 },
  { pattern: /let('s| us) (schedule|set up|find) (a |an )?(time|slot)/i,                   classification: 'interview_invite', confidence: 0.88 },
  { pattern: /are you available (for|to).{0,50}(interview|call|chat|meet)/i,               classification: 'interview_invite', confidence: 0.92 },
  { pattern: /calendly\.com|cal\.com|savvycal\.com|hubspot.*meeting/i,                     classification: 'interview_invite', confidence: 0.88 },

  // Offer
  { pattern: /pleased to (offer|extend|present).{0,30}(offer|position)/i,                 classification: 'offer', confidence: 0.98 },
  { pattern: /formal (job |employment )?offer/i,                                           classification: 'offer', confidence: 0.97 },
  { pattern: /offer letter.{0,50}(attached|enclosed|please find)/i,                       classification: 'offer', confidence: 0.98 },
  { pattern: /starting salary|base compensation|total compensation.{0,50}(\$|USD|GBP)/i,  classification: 'offer', confidence: 0.93 },

  // Application received
  { pattern: /we (have |'ve )?(received|got) your (application|resume)/i,                  classification: 'application_received', confidence: 0.95 },
  { pattern: /thank you for applying (to|for)/i,                                           classification: 'application_received', confidence: 0.92 },
  { pattern: /your application (has been |is )(received|submitted|under review)/i,         classification: 'application_received', confidence: 0.95 },
  { pattern: /application (confirmation|reference) (number|id|#)/i,                       classification: 'application_received', confidence: 0.90 },
];

// ── Keyword scoring (Layer 2) ─────────────────────────────────
const KEYWORD_SCORES: Record<EmailClassification, { keywords: string[]; weight: number }[]> = {
  rejection: [
    { keywords: ['unfortunately', 'regret', 'unable', 'not selected'], weight: 3 },
    { keywords: ['other candidates', 'other applicants', 'not a fit', 'not moving forward'], weight: 4 },
    { keywords: ['best of luck', 'future endeavors', 'keep your resume'], weight: 2 },
  ],
  interview_invite: [
    { keywords: ['interview', 'call', 'meet', 'chat'], weight: 2 },
    { keywords: ['schedule', 'availability', 'time slot', 'calendar'], weight: 3 },
    { keywords: ['next step', 'next steps', 'move forward', 'progress'], weight: 2 },
    { keywords: ['zoom', 'google meet', 'teams', 'webex'], weight: 3 },
  ],
  offer: [
    { keywords: ['offer', 'congratulations', 'pleased', 'excited'], weight: 3 },
    { keywords: ['salary', 'compensation', 'benefits', 'start date'], weight: 2 },
    { keywords: ['welcome aboard', 'join the team', 'joining us'], weight: 4 },
  ],
  recruiter_reply: [
    { keywords: ['thanks for reaching out', 'great to hear', 'following up'], weight: 2 },
    { keywords: ['currently reviewing', 'will be in touch', 'keep you posted'], weight: 2 },
  ],
  application_received: [
    { keywords: ['received your application', 'under review', 'reviewing'], weight: 3 },
    { keywords: ['confirmation', 'reference number', 'thank you for applying'], weight: 3 },
  ],
  auto_reply:           [{ keywords: [], weight: 0 }],
  follow_up_sent:       [{ keywords: [], weight: 0 }],
  unrelated:            [{ keywords: [], weight: 0 }],
  unknown:              [{ keywords: [], weight: 0 }],
};

// ─────────────────────────────────────────────────────────────
// MAIN CLASSIFIER
// ─────────────────────────────────────────────────────────────
export async function classifyEmail(email: RawEmail): Promise<ClassificationResult> {
  const combined = `${email.subject}\n\n${email.bodyText}`.toLowerCase();
  const isAutoReply = AUTO_REPLY_PATTERNS.some(p => p.test(combined));

  if (isAutoReply) {
    return buildResult('auto_reply', 0.98, email, 'regex', isAutoReply);
  }

  // Layer 1: Regex (fast, high precision)
  for (const rule of REGEX_RULES) {
    if (rule.pattern.test(email.bodyText) || rule.pattern.test(email.subject)) {
      logger.debug('Email classified via regex', {
        classification: rule.classification,
        confidence:     rule.confidence,
        subject:        email.subject,
      });
      return buildResult(rule.classification, rule.confidence, email, 'regex', isAutoReply);
    }
  }

  // Layer 2: Keyword scoring
  const scores: Partial<Record<EmailClassification, number>> = {};
  for (const [cls, groups] of Object.entries(KEYWORD_SCORES)) {
    let total = 0;
    for (const group of groups) {
      const hits = group.keywords.filter(k => combined.includes(k.toLowerCase())).length;
      total += hits * group.weight;
    }
    if (total > 0) scores[cls as EmailClassification] = total;
  }

  const topEntry = Object.entries(scores).sort(([, a], [, b]) => b - a)[0];
  if (topEntry && topEntry[1] >= 6) {
    const [cls, score] = topEntry;
    const confidence = Math.min(0.85, 0.5 + score * 0.04);
    logger.debug('Email classified via keyword scoring', {
      classification: cls,
      score,
      confidence,
    });
    return buildResult(cls as EmailClassification, confidence, email, 'keyword', isAutoReply);
  }

  // Layer 3: Claude Haiku for ambiguous emails
  return classifyWithClaude(email, isAutoReply);
}

// ─────────────────────────────────────────────────────────────
// CLAUDE HAIKU CLASSIFICATION
// ─────────────────────────────────────────────────────────────
async function classifyWithClaude(
  email:       RawEmail,
  isAutoReply: boolean,
): Promise<ClassificationResult> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    logger.warn('No ANTHROPIC_API_KEY — defaulting email to unknown');
    return buildResult('unknown', 0.5, email, 'keyword', isAutoReply);
  }

  const prompt = `Classify this recruiter/job-application email. Reply ONLY with valid JSON.

Subject: ${email.subject}
From: ${email.fromEmail}
Body (first 600 chars): ${email.bodyText.slice(0, 600)}

JSON schema:
{
  "classification": "interview_invite"|"offer"|"rejection"|"recruiter_reply"|"auto_reply"|"application_received"|"unrelated",
  "confidence": 0.0-1.0,
  "company_name": string|null,
  "job_title": string|null,
  "recruiter_name": string|null,
  "sentiment": "positive"|"negative"|"neutral",
  "requires_action": boolean,
  "interview_date": "YYYY-MM-DD"|null
}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system:     'You are an email classifier for a job application tracker. Return only valid JSON.',
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    const data = await res.json() as { content: Array<{ type: string; text: string }> };
    const text = data.content.find(c => c.type === 'text')?.text ?? '{}';
    const json = JSON.parse(text.replace(/```json|```/g, '').trim()) as {
      classification: EmailClassification;
      confidence: number;
      company_name: string | null;
      job_title: string | null;
      recruiter_name: string | null;
      sentiment: 'positive' | 'negative' | 'neutral';
      requires_action: boolean;
      interview_date: string | null;
    };

    const extracted = json.interview_date ? new Date(json.interview_date) : null;

    logger.debug('Email classified via Claude', {
      classification: json.classification,
      confidence:     json.confidence,
    });

    return {
      classification:      json.classification ?? 'unknown',
      confidence:          json.confidence      ?? 0.7,
      companyName:         json.company_name    ?? extractCompany(email),
      jobTitle:            json.job_title       ?? extractJobTitle(email),
      recruiterName:       json.recruiter_name  ?? email.fromName,
      isAutoReply,
      requiresAction:      json.requires_action ?? false,
      shouldStopFollowUps: shouldStopFollowUps(json.classification ?? 'unknown'),
      sentiment:           json.sentiment        ?? 'neutral',
      extractedDate:       extracted,
      method:              'claude',
    };
  } catch (err) {
    logger.warn('Claude classification failed', { error: String(err) });
    return buildResult('unknown', 0.4, email, 'keyword', isAutoReply);
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function buildResult(
  classification: EmailClassification,
  confidence:     number,
  email:          RawEmail,
  method:         ClassificationResult['method'],
  isAutoReply:    boolean,
): ClassificationResult {
  return {
    classification,
    confidence,
    companyName:         extractCompany(email),
    jobTitle:            extractJobTitle(email),
    recruiterName:       email.fromName,
    isAutoReply,
    requiresAction:      ['interview_invite', 'offer'].includes(classification),
    shouldStopFollowUps: shouldStopFollowUps(classification),
    sentiment:           getSentiment(classification),
    extractedDate:       null,
    method,
  };
}

function shouldStopFollowUps(cls: EmailClassification): boolean {
  return ['rejection', 'interview_invite', 'offer', 'recruiter_reply'].includes(cls);
}

function getSentiment(cls: EmailClassification): 'positive' | 'negative' | 'neutral' {
  if (['offer', 'interview_invite', 'recruiter_reply'].includes(cls)) return 'positive';
  if (['rejection'].includes(cls)) return 'negative';
  return 'neutral';
}

function extractCompany(email: RawEmail): string | null {
  // From email domain → company name heuristic
  const domain = email.fromEmail.split('@')[1];
  if (!domain) return null;
  const parts = domain.split('.');
  if (parts.length < 2) return null;
  const tld = parts[parts.length - 1];
  const company = parts[parts.length - 2];
  if (!company || ['gmail', 'yahoo', 'outlook', 'hotmail', 'icloud'].includes(company)) return null;
  // Capitalise
  return company.charAt(0).toUpperCase() + company.slice(1);
}

function extractJobTitle(email: RawEmail): string | null {
  const text = `${email.subject} ${email.bodyText}`;
  const patterns = [
    /(?:position|role|job|opening|opportunity)[:\s]+([A-Z][A-Za-z\s/-]{5,60})/,
    /applying (?:to|for) (?:the )?([A-Z][A-Za-z\s/-]{5,60})(?:\s+role|\s+position|\s+at)/,
    /re:\s+([A-Z][A-Za-z\s/-]{5,60})\s+(?:at|@|–|-)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) return m[1].trim().slice(0, 80);
  }
  return null;
}
