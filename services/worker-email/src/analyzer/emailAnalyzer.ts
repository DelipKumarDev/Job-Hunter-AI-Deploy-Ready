// ============================================================
// Email Analyzer — Main Orchestrator
// Full pipeline for deep recruiter email analysis.
//
// Pipeline:
//  Step 1: Auto-reply pre-pass  → skip if OOO
//  Step 2: Intent detection     → heuristic (fast, ~0ms)
//  Step 3: Entity extraction    → regex-based (~1ms)
//  Step 4: Datetime parsing     → pattern matcher (~1ms)
//  Step 5: Meeting details      → link + format detector
//  Step 6: Claude Sonnet        → only if needed or to enrich
//  Step 7: Merge + validate     → reconcile heuristic + Claude
//  Step 8: Apply DB actions     → state machine writes
//  Step 9: Cache result         → Redis 24h TTL
//
// Claude runs in two modes:
//   FULL   — uncertain intent, needs structured extraction
//   ENRICH — intent confirmed, Claude only extracts entities
// ============================================================

import type { PrismaClient } from '@prisma/client';
import type {
  AnalyzeEmailPayload,
  EmailAnalysisResult,
  ResponseIntent,
  ExtractedEntities,
} from './analyzerTypes.js';
import { detectIntent }       from './intentDetector.js';
import { parseDatetimes, bestDatetime } from './datetimeParser.js';
import { extractEntities, extractMeetingDetails } from './entityExtractor.js';
import { applyAnalysisActions } from './applicationUpdater.js';
import { logger } from '../utils/logger.js';

// ── Confidence below this → call Claude ────────────────────────
const CLAUDE_CONFIDENCE_THRESHOLD = 0.72;

// ── Claude enrichment: even when intent is certain, Claude
//    can extract interview date/entities more reliably ─────────
const ENRICH_INTENTS: ResponseIntent[] = [
  'interview_scheduled', 'offer_extended', 'request_for_information', 'assessment_sent',
];

// ─────────────────────────────────────────────────────────────
// MAIN ANALYZE FUNCTION
// ─────────────────────────────────────────────────────────────
export async function analyzeEmail(
  prisma:  PrismaClient,
  payload: AnalyzeEmailPayload,
): Promise<EmailAnalysisResult> {

  const startMs = Date.now();
  const { emailId, threadId, rawBody, subject, fromEmail, fromName, applicationId, userId } = payload;

  logger.info('Analyzing email', { emailId, subject: subject.slice(0, 60), from: fromEmail });

  // ── Step 1: Auto-reply pre-pass ───────────────────────────
  if (isAutoReply(rawBody, subject, fromEmail)) {
    const result = buildResult(emailId, threadId, 'auto_reply', 0.99, 'heuristic', {});
    await persistResult(prisma, result, emailId);
    return result;
  }

  // ── Step 2: Heuristic intent detection ───────────────────
  const heuristic = detectIntent(`${subject}\n${rawBody}`);
  logger.debug('Heuristic intent', {
    intent:     heuristic.top.intent,
    score:      heuristic.top.score,
    confidence: heuristic.top.confidence,
    signals:    heuristic.top.signals,
  });

  // ── Step 3: Regex entity extraction ──────────────────────
  const entities = extractEntities(rawBody, subject, fromEmail, fromName);

  // ── Step 4: Datetime parsing ──────────────────────────────
  const datetimes = parseDatetimes(`${subject}\n${rawBody}`);
  const bestDt    = bestDatetime(datetimes);

  // ── Step 5: Meeting details ───────────────────────────────
  const meeting = extractMeetingDetails(rawBody);

  // ── Step 6: Claude ────────────────────────────────────────
  let intent:     ResponseIntent = heuristic.top.intent;
  let confidence: number         = heuristic.top.confidence;
  let method:     EmailAnalysisResult['method'] = 'heuristic';
  let rawExtraction: Record<string, unknown> | null = null;
  let tokensUsed = 0;

  const needsFullClaude  = heuristic.needsClaude || confidence < CLAUDE_CONFIDENCE_THRESHOLD;
  const needsEnrichment  = !needsFullClaude && ENRICH_INTENTS.includes(intent);

  if (needsFullClaude || needsEnrichment) {
    const claudeMode = needsFullClaude ? 'full' : 'enrich';
    logger.debug(`Calling Claude Sonnet (mode: ${claudeMode})`, { emailId });

    const claudeResult = await callClaude(rawBody, subject, fromEmail, claudeMode, entities, bestDt);
    tokensUsed = claudeResult.tokensUsed;
    rawExtraction = claudeResult.raw;

    if (claudeResult.intent && needsFullClaude) {
      intent     = claudeResult.intent;
      confidence = claudeResult.confidence;
      method     = 'claude';
    }

    // Merge Claude's entity extraction (Claude wins on ambiguous fields)
    mergeEntities(entities, claudeResult.entities);

    // Claude datetime is authoritative for interview_scheduled
    if (claudeResult.datetime && intent === 'interview_scheduled') {
      const merged = bestDatetime([...datetimes, claudeResult.datetime]);
      if (merged && merged.confidence > (bestDt?.confidence ?? 0)) {
        Object.assign(bestDt ?? {}, merged); // Replace in-place
      }
    }
  }

  // ── Step 7: Compute sentiment ─────────────────────────────
  const { sentiment, sentimentScore } = computeSentiment(intent, rawBody);
  const urgency = computeUrgency(intent, rawBody);

  // ── Step 8: Build result ──────────────────────────────────
  const result: EmailAnalysisResult = {
    emailId,
    threadId,
    analyzedAt:   new Date(),
    intent,
    confidence,
    method,
    sentiment,
    sentimentScore,
    urgency,
    datetime:     bestDt,
    meeting,
    entities,
    actionsApplied: [],
    rawExtraction,
    tokensUsed,
  };

  // ── Step 9: Apply DB actions ──────────────────────────────
  if (applicationId) {
    result.actionsApplied = await applyAnalysisActions(prisma, result, applicationId, userId);
  }

  // ── Step 10: Persist analysis result ─────────────────────
  await persistResult(prisma, result, emailId);

  logger.info('Email analysis complete', {
    emailId,
    intent,
    confidence:    Math.round(confidence * 100),
    method,
    actions:       result.actionsApplied.map(a => a.type),
    durationMs:    Date.now() - startMs,
    tokensUsed,
  });

  return result;
}

// ─────────────────────────────────────────────────────────────
// CLAUDE CALL
// ─────────────────────────────────────────────────────────────
interface ClaudeAnalysisOutput {
  intent:     ResponseIntent | null;
  confidence: number;
  entities:   Partial<ExtractedEntities>;
  datetime:   import('./analyzerTypes.js').ExtractedDatetime | null;
  tokensUsed: number;
  raw:        Record<string, unknown>;
}

async function callClaude(
  body:      string,
  subject:   string,
  fromEmail: string,
  mode:      'full' | 'enrich',
  knownEntities: ExtractedEntities,
  knownDt:   import('./analyzerTypes.js').ExtractedDatetime | null,
): Promise<ClaudeAnalysisOutput> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    return { intent: null, confidence: 0, entities: {}, datetime: null, tokensUsed: 0, raw: {} };
  }

  const systemPrompt = `You are an expert recruiter email analyzer. Extract structured information from job application emails.
Return ONLY valid JSON. No markdown, no preamble, no explanation.`;

  const fullPrompt = mode === 'full' ? `
Analyze this recruiter email and return structured JSON.

Subject: ${subject}
From: ${fromEmail}
Body:
${body.slice(0, 2000)}

Return this exact JSON structure:
{
  "intent": "interview_scheduled" | "interview_request" | "availability_request" | "calendar_link_sent" | "request_for_information" | "offer_extended" | "moved_to_next_stage" | "assessment_sent" | "rejection" | "rejection_soft" | "auto_reply" | "unclassified",
  "confidence": 0.0-1.0,
  "sentiment": "very_positive" | "positive" | "neutral" | "negative" | "very_negative",
  "sentiment_score": -1.0 to 1.0,
  "urgency": "high" | "medium" | "low",
  "company_name": string | null,
  "job_title": string | null,
  "recruiter_name": string | null,
  "recruiter_title": string | null,
  "hiring_manager": string | null,
  "interview_datetime_raw": string | null,
  "interview_datetime_iso": "YYYY-MM-DDTHH:MM:SS±HH:MM" | null,
  "interview_timezone": "IANA timezone string" | null,
  "interview_is_confirmed": boolean,
  "interview_format": "phone_screen" | "video_call" | "technical_interview" | "take_home_assessment" | "onsite" | "panel" | "informal_chat" | "unknown",
  "meeting_platform": string | null,
  "meeting_link": string | null,
  "calendar_link": string | null,
  "interview_duration_minutes": number | null,
  "requested_documents": string[],
  "deadline_text": string | null,
  "salary_mentioned": string | null,
  "location": string | null
}` : `
This recruiter email has been classified as: ${knownEntities.companyName ? `from ${knownEntities.companyName}` : ''}

Extract only the missing structured fields.
Subject: ${subject}
From: ${fromEmail}
Body:
${body.slice(0, 1500)}

${knownDt ? `Known datetime: ${knownDt.rawText}` : 'No datetime found yet.'}

Return JSON:
{
  "interview_datetime_raw": string | null,
  "interview_datetime_iso": "YYYY-MM-DDTHH:MM:SS±HH:MM" | null,
  "interview_timezone": string | null,
  "interview_is_confirmed": boolean,
  "interview_format": string | null,
  "meeting_platform": string | null,
  "meeting_link": string | null,
  "calendar_link": string | null,
  "interview_duration_minutes": number | null,
  "interviewers": string[],
  "hiring_manager": string | null,
  "requested_documents": string[],
  "deadline_text": string | null
}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:       'claude-sonnet-4-6',
        max_tokens:  800,
        temperature: 0,   // Deterministic extraction
        system:      systemPrompt,
        messages:    [{ role: 'user', content: fullPrompt }],
      }),
    });

    const data = await res.json() as {
      content: Array<{ type: string; text: string }>;
      usage:   { input_tokens: number; output_tokens: number };
    };

    const rawText = data.content.find(c => c.type === 'text')?.text ?? '{}';
    const json    = JSON.parse(rawText.replace(/```json|```/g, '').trim()) as Record<string, unknown>;

    const tokensUsed = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);

    // Build datetime from Claude output
    let datetime: import('./analyzerTypes.js').ExtractedDatetime | null = null;
    if (json['interview_datetime_iso']) {
      datetime = {
        rawText:     String(json['interview_datetime_raw'] ?? ''),
        isoDatetime: String(json['interview_datetime_iso']),
        timezone:    json['interview_timezone'] ? String(json['interview_timezone']) : null,
        isRange:     false,
        confidence:  0.93,
        isConfirmed: Boolean(json['interview_is_confirmed']),
      };
    }

    const entities: Partial<ExtractedEntities> = {
      companyName:         json['company_name']     ? String(json['company_name'])     : undefined,
      jobTitle:            json['job_title']         ? String(json['job_title'])         : undefined,
      recruiterName:       json['recruiter_name']   ? String(json['recruiter_name'])   : undefined,
      recruiterTitle:      json['recruiter_title']  ? String(json['recruiter_title'])  : undefined,
      hiringManager:       json['hiring_manager']   ? String(json['hiring_manager'])   : undefined,
      location:            json['location']         ? String(json['location'])         : undefined,
      requestedDocuments:  Array.isArray(json['requested_documents']) ? json['requested_documents'] as string[] : [],
      deadlineText:        json['deadline_text']    ? String(json['deadline_text'])    : undefined,
      salaryMentioned:     json['salary_mentioned'] ? String(json['salary_mentioned']) : undefined,
      assessmentLink:      json['meeting_link']     ? String(json['meeting_link'])     : undefined,
    };

    return {
      intent:     mode === 'full' ? (json['intent'] as ResponseIntent) : null,
      confidence: mode === 'full' ? Number(json['confidence'] ?? 0.8) : 0,
      entities,
      datetime,
      tokensUsed,
      raw:        json,
    };
  } catch (err) {
    logger.warn('Claude analysis failed', { error: String(err) });
    return { intent: null, confidence: 0, entities: {}, datetime: null, tokensUsed: 0, raw: {} };
  }
}

// ─────────────────────────────────────────────────────────────
// PERSIST RESULT TO DB
// ─────────────────────────────────────────────────────────────
async function persistResult(
  prisma:  PrismaClient,
  result:  EmailAnalysisResult,
  emailId: string,
): Promise<void> {
  try {
    // Store analysis on the email_threads record
    await prisma.emailThread.update({
      where: { id: emailId },
      data: {
        classification:      result.intent,
        classificationScore: result.confidence,
        analysisData: result as unknown as import('@prisma/client').Prisma.JsonObject,
        analysedAt:   result.analyzedAt,
      },
    }).catch(() => null); // Field might not exist in older schema — graceful
  } catch { /* non-fatal */ }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
const AUTO_REPLY_SIGNALS = [
  /out of (?:the )?office/i, /auto.?reply/i, /automatic reply/i,
  /away from (?:my )?(?:desk|office)/i, /will (?:be )?(?:back|return) on/i,
  /this (?:email|message) was sent automatically/i,
  /do not (?:reply|respond) to this/i,
];

function isAutoReply(body: string, subject: string, from: string): boolean {
  const combined = `${subject} ${body} ${from}`;
  return AUTO_REPLY_SIGNALS.some(p => p.test(combined))
      || /noreply@|no-reply@|donotreply@/i.test(from);
}

function buildResult(
  emailId:  string,
  threadId: string,
  intent:   ResponseIntent,
  confidence: number,
  method:   EmailAnalysisResult['method'],
  extras:   Partial<EmailAnalysisResult>,
): EmailAnalysisResult {
  return {
    emailId,
    threadId,
    analyzedAt:     new Date(),
    intent,
    confidence,
    method,
    sentiment:      'neutral',
    sentimentScore: 0,
    urgency:        'low',
    datetime:       null,
    meeting:        null,
    entities: {
      companyName:         null, jobTitle:           null,
      recruiterName:       null, recruiterTitle:     null,
      hiringManager:       null, location:           null,
      requestedDocuments:  [],   deadlineText:       null,
      assessmentLink:      null, assessmentDeadline: null,
      salaryMentioned:     null, startDateMentioned: null,
    },
    actionsApplied: [],
    rawExtraction:  null,
    tokensUsed:     0,
    ...extras,
  };
}

function mergeEntities(base: ExtractedEntities, override: Partial<ExtractedEntities>): void {
  for (const key of Object.keys(override) as (keyof ExtractedEntities)[]) {
    const val = override[key];
    if (val !== null && val !== undefined) {
      if (Array.isArray(val) && val.length === 0) continue;
      (base as Record<string, unknown>)[key] = val;
    }
  }
}

function computeSentiment(
  intent: ResponseIntent,
  body:   string,
): { sentiment: EmailAnalysisResult['sentiment']; sentimentScore: number } {
  const positiveMap: Partial<Record<ResponseIntent, number>> = {
    interview_scheduled: 0.9, interview_request: 0.7, availability_request: 0.6,
    calendar_link_sent: 0.6, offer_extended: 1.0, moved_to_next_stage: 0.75,
    assessment_sent: 0.5,
  };
  const negativeMap: Partial<Record<ResponseIntent, number>> = {
    rejection: -0.9, rejection_soft: -0.4,
  };

  const score = positiveMap[intent] ?? negativeMap[intent] ?? 0;

  // Additional body signals
  const positiveSignals = (body.match(/excited|thrilled|impressed|great|excellent|strong/gi) ?? []).length;
  const negativeSignals = (body.match(/unfortunately|regret|unable|sorry|decline/gi) ?? []).length;
  const adjusted = Math.max(-1, Math.min(1, score + positiveSignals * 0.05 - negativeSignals * 0.05));

  const sentiment: EmailAnalysisResult['sentiment'] =
    adjusted >= 0.7  ? 'very_positive'
  : adjusted >= 0.3  ? 'positive'
  : adjusted <= -0.7 ? 'very_negative'
  : adjusted <= -0.3 ? 'negative'
  :                    'neutral';

  return { sentiment, sentimentScore: adjusted };
}

function computeUrgency(intent: ResponseIntent, body: string): EmailAnalysisResult['urgency'] {
  const highUrgency = [
    /respond.*(?:today|asap|immediately|urgent|within 24 hours|within 48 hours)/i,
    /deadline.*(?:today|tomorrow)/i,
    /offer.*expires/i,
    /limited time/i,
  ];
  if (highUrgency.some(p => p.test(body))) return 'high';

  const mediumIntents: ResponseIntent[] = [
    'interview_scheduled', 'offer_extended', 'assessment_sent', 'availability_request',
  ];
  if (mediumIntents.includes(intent)) return 'medium';

  return 'low';
}
