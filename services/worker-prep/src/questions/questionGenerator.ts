// ============================================================
// Interview Question Generator
// Generates a complete, prioritised set of interview questions
// tailored to the specific role, company, and candidate profile.
//
// Question categories produced:
//   behavioral       — STAR-format competency questions
//   technical        — Stack and domain-specific depth
//   system_design    — Architecture and scalability
//   culture_fit      — Values alignment, working style
//   situational      — Hypothetical scenarios
//   role_specific    — Direct JD responsibilities
//   company_knowledge — "Why us?" and product questions
//   closing          — Smart questions to ask them
//
// Strategy:
//   1. Fast heuristic pass: known common questions per category
//   2. Claude Sonnet: personalise + generate JD-specific questions
//   3. Deduplicate + rank by likelihood
// ============================================================

import { randomUUID } from 'crypto';
import type {
  InterviewQuestion, PrepInput, QuestionCategory,
} from '../types/prepTypes.js';
import type { JdAnalysis, CompanyAnalysis } from '../analyzer/jdAnalyzer.js';
import { logger } from '../utils/logger.js';

// ── Question count targets per category ───────────────────────
const QUESTION_TARGETS: Record<QuestionCategory, number> = {
  behavioral:        5,
  technical:         6,
  system_design:     3,
  culture_fit:       3,
  situational:       3,
  role_specific:     4,
  company_knowledge: 3,
  closing:           5,   // Questions TO ASK them
};

// ─────────────────────────────────────────────────────────────
// MAIN GENERATOR
// ─────────────────────────────────────────────────────────────
export async function generateQuestions(
  input:    PrepInput,
  jd:       JdAnalysis,
  company:  CompanyAnalysis,
): Promise<InterviewQuestion[]> {
  logger.info('Generating interview questions', {
    company:  input.companyName,
    role:     input.jobTitle,
    format:   input.interviewFormat,
  });

  const prompt = buildQuestionPrompt(input, jd, company);

  const apiKey = process.env['ANTHROPIC_API_KEY']!;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:       'claude-sonnet-4-6',
      max_tokens:  4000,
      temperature: 0.5,
      system:      SYSTEM_PROMPT,
      messages:    [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json() as {
    content: Array<{ type: string; text?: string }>;
    usage:   { input_tokens: number; output_tokens: number };
  };

  const raw = data.content.find(c => c.type === 'text')?.text ?? '[]';

  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()) as RawQuestion[];
    const questions = parsed.map(normaliseQuestion).filter(Boolean) as InterviewQuestion[];

    // Inject closing questions (what to ask them)
    const closingQs = buildClosingQuestions(input, company);
    questions.push(...closingQs);

    logger.info('Questions generated', {
      total:      questions.length,
      categories: [...new Set(questions.map(q => q.category))],
    });

    return questions;
  } catch (err) {
    logger.warn('Question parse failed — using heuristic fallback', { error: String(err) });
    return buildFallbackQuestions(input, jd, company);
  }
}

// ─────────────────────────────────────────────────────────────
// PROMPT
// ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a senior hiring manager and interview coach at a top tech company.
Generate highly specific interview questions tailored to this exact role and company.
Never generate generic, textbook questions. Every question must be grounded in the JD.
Return ONLY valid JSON array. No markdown, no explanation.`;

function buildQuestionPrompt(
  input:   PrepInput,
  jd:      JdAnalysis,
  company: CompanyAnalysis,
): string {
  const topSkills   = jd.requiredSkills.slice(0, 6).map(s => s.name).join(', ');
  const topResp     = jd.responsibilities.slice(0, 4).join('\n• ');
  const cultureHints = company.culture.slice(0, 3).join(', ');

  return `Generate interview questions for this role.

ROLE: ${input.jobTitle} at ${input.companyName}
SENIORITY: ${input.seniority}
INTERVIEW FORMAT: ${input.interviewFormat}
TOP REQUIRED SKILLS: ${topSkills}
KEY RESPONSIBILITIES:
• ${topResp}

COMPANY CULTURE: ${cultureHints}
INTERVIEW STYLE: ${company.interviewStyle}

CANDIDATE BACKGROUND SUMMARY:
${input.resumeText.slice(0, 600)}

Generate exactly these questions:
- 5 behavioral (STAR format, specific to the role's challenges)
- 6 technical (specific to ${topSkills.split(',').slice(0, 3).join(', ')} — not generic)
- 3 system design (appropriate for ${input.seniority} level)
- 3 culture fit (based on ${input.companyName}'s known values)
- 3 situational ("What would you do if...")
- 4 role-specific (directly from the responsibilities listed above)

Return a JSON array where each object has:
{
  "category": "behavioral|technical|system_design|culture_fit|situational|role_specific",
  "question": "The exact question as it would be asked",
  "difficulty": "easy|medium|hard",
  "frequency": "common|likely|curveball",
  "rationale": "One sentence: why this question will likely come up for THIS role",
  "time_limit": 120,
  "follow_ups": ["Follow-up 1", "Follow-up 2"]
}`;
}

// ─────────────────────────────────────────────────────────────
// CLOSING QUESTIONS (what to ask the interviewer)
// ─────────────────────────────────────────────────────────────
function buildClosingQuestions(
  input:   PrepInput,
  company: CompanyAnalysis,
): InterviewQuestion[] {
  const questions: Array<{ q: string; rationale: string }> = [
    {
      q:         `What does success look like for the ${input.jobTitle} role in the first 90 days?`,
      rationale: 'Shows you think in outcomes, not activities. Sets mutual expectations.',
    },
    {
      q:         `What's the biggest technical challenge the team is working through right now?`,
      rationale: 'Signals technical curiosity and appetite to contribute immediately.',
    },
    {
      q:         `How does the team balance shipping new features against reducing technical debt?`,
      rationale: 'Tests for engineering culture alignment without being confrontational.',
    },
    {
      q:         company.recentNews.length > 0
        ? `I saw that ${input.companyName} recently ${company.recentNews[0]}. How does that affect the ${input.jobTitle} team's roadmap?`
        : `Where do you see the ${input.jobTitle} function in two years as ${input.companyName} scales?`,
      rationale: 'Demonstrates you've done research. Shows strategic thinking.',
    },
    {
      q:         `What do you personally enjoy most about working here compared to other places you've been?`,
      rationale: 'Gets authentic, unscripted answers. Helps you evaluate culture fit.',
    },
  ];

  return questions.map(({ q, rationale }) => ({
    id:         randomUUID(),
    category:   'closing' as QuestionCategory,
    question:   q,
    difficulty: 'easy' as const,
    frequency:  'common' as const,
    rationale,
    timeLimit:  90,
    followUps:  [],
  }));
}

// ─────────────────────────────────────────────────────────────
// FALLBACK QUESTIONS (if Claude fails)
// ─────────────────────────────────────────────────────────────
function buildFallbackQuestions(
  input:   PrepInput,
  jd:      JdAnalysis,
  company: CompanyAnalysis,
): InterviewQuestion[] {
  const skills = jd.requiredSkills.slice(0, 3).map(s => s.name);

  const fallbacks: Array<Omit<InterviewQuestion, 'id'>> = [
    // Behavioral
    {
      category: 'behavioral', difficulty: 'medium', frequency: 'common',
      question: `Tell me about a time you had to deliver a complex ${input.jobTitle.split(' ').pop()} project under tight deadlines. How did you prioritise?`,
      rationale: 'Tests time management and delivery under pressure — critical for this role.',
      timeLimit: 180, followUps: ['What would you do differently?', 'How did the team react?'],
    },
    {
      category: 'behavioral', difficulty: 'medium', frequency: 'common',
      question: 'Describe a situation where you disagreed with a technical decision your team made. How did you handle it?',
      rationale: 'Tests collaboration and constructive conflict resolution.',
      timeLimit: 180, followUps: ['What was the outcome?', 'Would you handle it differently now?'],
    },
    {
      category: 'behavioral', difficulty: 'hard', frequency: 'likely',
      question: 'Tell me about the most challenging technical problem you have ever solved. Walk me through your thought process.',
      rationale: 'Reveals depth of technical problem-solving and communication skills.',
      timeLimit: 240, followUps: ['What alternatives did you consider?', 'How did you measure success?'],
    },

    // Technical
    {
      category: 'technical', difficulty: 'medium', frequency: 'common',
      question: skills[0] ? `How do you approach testing and code quality in ${skills[0]} projects? What does your ideal CI/CD pipeline look like?` : 'Walk me through how you ensure code quality in your projects.',
      rationale: 'Tests engineering standards and DevOps awareness.',
      timeLimit: 150, followUps: ['What tools do you use?', 'How do you handle flaky tests?'],
    },
    {
      category: 'technical', difficulty: 'hard', frequency: 'likely',
      question: skills[1] ? `Explain how you would optimise a slow ${skills[1]} application serving 100k concurrent users.` : 'How do you diagnose and fix performance bottlenecks in a production system?',
      rationale: 'Tests scalability thinking and depth of technical knowledge.',
      timeLimit: 180, followUps: ['Where would you start?', 'What metrics would you watch?'],
    },

    // System design
    {
      category: 'system_design', difficulty: 'hard', frequency: 'likely',
      question: `Design a ${getSystemDesignPrompt(input.jobTitle)} that handles ${input.seniority === 'senior' || input.seniority === 'staff' ? '10 million' : '1 million'} users.`,
      rationale: 'Standard system design question calibrated to seniority level.',
      timeLimit: 300, followUps: ['How would you scale the database?', 'What are the failure modes?'],
    },

    // Culture fit
    {
      category: 'culture_fit', difficulty: 'easy', frequency: 'common',
      question: `Why ${input.companyName}? What specifically drew you to this company over others in the space?`,
      rationale: 'Tests genuine interest and research. Poor answers are a major red flag.',
      timeLimit: 120, followUps: ['What do you know about our product?', 'Have you used our product?'],
    },

    // Role-specific
    {
      category: 'role_specific', difficulty: 'medium', frequency: 'common',
      question: jd.responsibilities[0] ? `The JD mentions "${jd.responsibilities[0].slice(0, 80)}". Walk me through how you would approach this in your first 30 days.` : `How would you approach the first 30 days in this ${input.jobTitle} role?`,
      rationale: 'Directly tests readiness for the most prominent listed responsibility.',
      timeLimit: 180, followUps: ['What obstacles do you foresee?', 'How would you measure impact?'],
    },

    ...buildClosingQuestions(input, company),
  ];

  return fallbacks.map(q => ({ ...q, id: randomUUID() }));
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
interface RawQuestion {
  category:   string;
  question:   string;
  difficulty: string;
  frequency:  string;
  rationale:  string;
  time_limit: number;
  follow_ups: string[];
}

function normaliseQuestion(raw: RawQuestion): InterviewQuestion | null {
  if (!raw.question || !raw.category) return null;
  return {
    id:         randomUUID(),
    category:   raw.category as QuestionCategory,
    question:   raw.question,
    difficulty: (raw.difficulty ?? 'medium') as InterviewQuestion['difficulty'],
    frequency:  (raw.frequency ?? 'likely')  as InterviewQuestion['frequency'],
    rationale:  raw.rationale ?? '',
    timeLimit:  raw.time_limit ?? 120,
    followUps:  Array.isArray(raw.follow_ups) ? raw.follow_ups : [],
  };
}

function getSystemDesignPrompt(jobTitle: string): string {
  const lower = jobTitle.toLowerCase();
  if (lower.includes('backend') || lower.includes('api'))  return 'URL shortening service with analytics';
  if (lower.includes('data') || lower.includes('ml'))       return 'real-time ML feature store';
  if (lower.includes('frontend') || lower.includes('ui'))   return 'collaborative document editing system';
  if (lower.includes('devops') || lower.includes('infra'))  return 'multi-region deployment pipeline';
  if (lower.includes('mobile'))                             return 'offline-first mobile sync system';
  return 'distributed notification system';
}
