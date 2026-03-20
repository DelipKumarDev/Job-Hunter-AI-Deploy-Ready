// ============================================================
// AI Briefing Generator
// Uses Claude claude-sonnet-4-6 to generate a rich interview
// briefing from the job description and user's resume.
//
// Generates:
//   • 2–3 sentence company summary (culture, product, size)
//   • 4 role highlight bullets
//   • 3 behavioural STAR questions tailored to the role
//   • 3 technical questions based on JD requirements
//   • 3 smart questions to ask the interviewer
//   • 5 key prep topics (frameworks, domains, skills)
//   • Salary insight (if visible in JD)
//   • Culture signal (remote-friendly, fast-paced, etc.)
//
// Uses web_search tool inside Claude for company research
// when company name is provided. Falls back to JD-only
// analysis if search unavailable.
// ============================================================

import type { InterviewBriefing, GeneratedBriefing, QuestionSet } from '../types/notificationTypes.js';
import { logger } from '../utils/logger.js';

const SYSTEM_PROMPT = `You are an expert career coach and interview strategist.

Given an interview briefing, generate targeted preparation content.
Be specific to this exact role and company — never generic.
Return ONLY valid JSON. No markdown, no explanation, no preamble.`;

// ─────────────────────────────────────────────────────────────
// MAIN GENERATOR
// ─────────────────────────────────────────────────────────────
export async function generateInterviewBriefing(
  briefing: InterviewBriefing,
): Promise<GeneratedBriefing> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  logger.info('Generating interview briefing', {
    company:  briefing.companyName,
    role:     briefing.jobTitle,
    hasJD:    !!briefing.jobDescription,
    hasResume: !!briefing.resumeText,
  });

  const startMs = Date.now();

  const prompt = buildPrompt(briefing);

  // Use web_search tool for company research
  const tools = buildTools();

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:       'claude-sonnet-4-6',
      max_tokens:  2000,
      temperature: 0.4,
      system:      SYSTEM_PROMPT,
      tools,
      messages:    [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json() as {
    content:     Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>;
    stop_reason: string;
    usage:       { input_tokens: number; output_tokens: number };
  };

  // Handle tool use (web search for company info)
  let finalText = '';
  let tokensUsed = (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0);

  if (data.stop_reason === 'tool_use') {
    // Claude wants to search — execute and continue
    const result = await handleToolUse(data, briefing, apiKey, tools, prompt);
    finalText  = result.text;
    tokensUsed += result.extraTokens;
  } else {
    finalText = data.content.find(c => c.type === 'text')?.text ?? '{}';
  }

  const parsed = parseGeneratedContent(finalText, briefing);
  parsed.tokensUsed = tokensUsed;

  logger.info('Interview briefing generated', {
    company:    briefing.companyName,
    questions:  parsed.suggestedQuestions.behavioural.length + parsed.suggestedQuestions.technical.length,
    topics:     parsed.keyTopics.length,
    tokens:     tokensUsed,
    durationMs: Date.now() - startMs,
  });

  return parsed;
}

// ─────────────────────────────────────────────────────────────
// PROMPT BUILDER
// ─────────────────────────────────────────────────────────────
function buildPrompt(b: InterviewBriefing): string {
  const jdSnippet   = b.jobDescription?.slice(0, 1800) ?? 'Not available';
  const resumeSnippet = b.resumeText?.slice(0, 800) ?? 'Not available';

  return `Generate an interview preparation briefing for this candidate.

INTERVIEW DETAILS:
Company: ${b.companyName}
Role: ${b.jobTitle}
Format: ${b.format}
Platform: ${b.platform ?? 'TBD'}
Interviewers: ${b.interviewers.length > 0 ? b.interviewers.join(', ') : 'Unknown'}
Candidate: ${b.candidateName}

JOB DESCRIPTION (first 1800 chars):
${jdSnippet}

CANDIDATE RESUME SUMMARY:
${resumeSnippet}

${b.companyName ? `First, use web_search to find recent info about "${b.companyName}" (funding, product, culture, recent news) to enrich the company summary and questions.` : ''}

Then return this exact JSON:
{
  "company_summary": "2-3 engaging sentences about what the company does, their scale, culture, and recent momentum. Use web search results if available.",
  "role_highlights": ["4 specific bullets about key responsibilities from the JD. Be concrete, not generic."],
  "behavioural_questions": [
    "Tell me about a time you... [specific to a required skill in the JD]",
    "Describe a situation where you... [maps to a challenge this role faces]",
    "Give me an example of... [aligned to company values or team context]"
  ],
  "technical_questions": [
    "3 technical questions specific to this role's stack/domain — not generic 'explain recursion' questions"
  ],
  "questions_to_ask": [
    "3 thoughtful questions the candidate should ask the interviewer — show strategic thinking and genuine curiosity"
  ],
  "key_topics": ["5 specific areas to prepare: frameworks, methodologies, tools, or domain knowledge mentioned in JD"],
  "salary_insight": "Salary range insight if visible in JD, or null",
  "culture_insight": "1 sentence on culture signals from JD or company research, or null"
}`;
}

// ─────────────────────────────────────────────────────────────
// TOOL DEFINITIONS
// ─────────────────────────────────────────────────────────────
function buildTools(): object[] {
  return [
    {
      type: 'web_search_20250305',
      name: 'web_search',
    },
  ];
}

// ─────────────────────────────────────────────────────────────
// HANDLE TOOL USE — execute web search and continue
// ─────────────────────────────────────────────────────────────
async function handleToolUse(
  firstResponse: { content: Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>; stop_reason: string },
  briefing:      InterviewBriefing,
  apiKey:        string,
  tools:         object[],
  originalPrompt: string,
): Promise<{ text: string; extraTokens: number }> {
  // For our case, Claude with web_search tool will handle search internally
  // We just need to continue the conversation with the tool result
  const toolUseBlock = firstResponse.content.find(c => c.type === 'tool_use');

  if (!toolUseBlock) {
    const text = firstResponse.content.find(c => c.type === 'text')?.text ?? '{}';
    return { text, extraTokens: 0 };
  }

  // Re-invoke without web search tool to get final JSON
  // (tool use results come back in subsequent turn)
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:       'claude-sonnet-4-6',
      max_tokens:  2000,
      temperature: 0.4,
      system:      SYSTEM_PROMPT,
      tools,
      messages: [
        { role: 'user',      content: originalPrompt },
        { role: 'assistant', content: firstResponse.content },
      ],
    }),
  });

  if (!res.ok) {
    return { text: '{}', extraTokens: 0 };
  }

  const data = await res.json() as {
    content: Array<{ type: string; text?: string }>;
    usage:   { input_tokens: number; output_tokens: number };
  };

  const text       = data.content.find(c => c.type === 'text')?.text ?? '{}';
  const extraTokens = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);

  return { text, extraTokens };
}

// ─────────────────────────────────────────────────────────────
// PARSE CLAUDE OUTPUT → GeneratedBriefing
// ─────────────────────────────────────────────────────────────
function parseGeneratedContent(raw: string, fallback: InterviewBriefing): GeneratedBriefing {
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    const json  = JSON.parse(clean) as {
      company_summary:        string;
      role_highlights:        string[];
      behavioural_questions:  string[];
      technical_questions:    string[];
      questions_to_ask:       string[];
      key_topics:             string[];
      salary_insight:         string | null;
      culture_insight:        string | null;
    };

    return {
      companySummary:     json.company_summary    ?? fallbackCompanySummary(fallback),
      roleHighlights:     ensureArray(json.role_highlights,       4, `Key ${fallback.jobTitle} responsibilities`),
      suggestedQuestions: {
        behavioural: ensureArray(json.behavioural_questions, 3, fallbackBehavioural),
        technical:   ensureArray(json.technical_questions,   3, fallbackTechnical(fallback.jobTitle)),
        toAsk:       ensureArray(json.questions_to_ask,      3, fallbackToAsk),
      },
      keyTopics:          ensureArray(json.key_topics, 5, `${fallback.jobTitle} fundamentals`),
      salaryInsight:      json.salary_insight  ?? null,
      cultureInsight:     json.culture_insight ?? null,
      tokensUsed:         0,
    };
  } catch (err) {
    logger.warn('Failed to parse Claude briefing JSON — using fallbacks', { error: String(err) });
    return buildFallbackBriefing(fallback);
  }
}

// ─────────────────────────────────────────────────────────────
// FALLBACKS (if Claude fails)
// ─────────────────────────────────────────────────────────────
function buildFallbackBriefing(b: InterviewBriefing): GeneratedBriefing {
  return {
    companySummary:   fallbackCompanySummary(b),
    roleHighlights:   [
      `Lead and deliver high-impact ${b.jobTitle} work`,
      'Collaborate closely with cross-functional teams',
      'Drive technical and product decisions',
      'Contribute to a high-growth team environment',
    ],
    suggestedQuestions: {
      behavioural: fallbackBehavioural,
      technical:   fallbackTechnical(b.jobTitle),
      toAsk:       fallbackToAsk,
    },
    keyTopics:        [
      'Core competencies listed in the job description',
      'Recent company news and product announcements',
      'Industry trends relevant to this role',
      'STAR-format behavioural story preparation',
      'Questions that demonstrate strategic thinking',
    ],
    salaryInsight:    null,
    cultureInsight:   null,
    tokensUsed:       0,
  };
}

function fallbackCompanySummary(b: InterviewBriefing): string {
  return `${b.companyName} is hiring for the ${b.jobTitle} role. Review their website and recent news before the interview to demonstrate genuine interest and knowledge of their business.`;
}

const fallbackBehavioural = [
  'Tell me about a time you faced a significant technical challenge. What was your approach and what did you learn?',
  'Describe a situation where you had to influence stakeholders without direct authority. How did you achieve alignment?',
  'Give me an example of a project where you failed or made a mistake. How did you handle it and what changed?',
];

function fallbackTechnical(title: string): string[] {
  return [
    `Walk me through how you would approach architecting a new ${title} system from scratch.`,
    'What metrics do you use to measure success in your work, and how do you track them?',
    'How do you stay current with developments in your field? Give a recent example.',
  ];
}

const fallbackToAsk = [
  'What does success look like for this role in the first 90 days?',
  'What are the biggest technical or organisational challenges the team is working through right now?',
  'How does this role interact with the product and engineering teams day-to-day?',
];

// ── Helpers ───────────────────────────────────────────────────
function ensureArray(val: unknown, minLen: number, fallbackItem: string | string[]): string[] {
  const arr = Array.isArray(val) ? val.filter(Boolean) as string[] : [];
  if (arr.length >= minLen) return arr;

  const fb = Array.isArray(fallbackItem) ? fallbackItem : Array(minLen).fill(fallbackItem);
  while (arr.length < minLen) arr.push(fb[arr.length] ?? fallbackItem as string);
  return arr;
}
