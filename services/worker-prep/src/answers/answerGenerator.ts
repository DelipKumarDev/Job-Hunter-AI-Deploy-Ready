// ============================================================
// Suggested Answer Generator
// Produces personalised, resume-grounded answer guidance
// for every interview question.
//
// For each question:
//  • Selects the best format (STAR, direct, structured, narrative)
//  • Mines the candidate's resume for relevant experience
//  • Generates a full model answer using real career history
//  • Lists 3–5 key points to hit
//  • Flags 2–3 common pitfalls to avoid
//  • Notes which resume strengths were used
//
// Batches questions into groups of 6 to reduce API calls.
// Claude claude-sonnet-4-6 with temp=0.3 for consistency.
// Falls back per-question if a batch fails.
// ============================================================

import type { InterviewQuestion, SuggestedAnswer, PrepInput } from '../types/prepTypes.js';
import { logger } from '../utils/logger.js';

const BATCH_SIZE = 6;

const SYSTEM_PROMPT = `You are an expert interview coach. Generate personalised, specific answer guidance.
Ground every answer in the candidate's actual experience. Never use placeholder examples.
If a skill isn't in their resume, use transferable experience and be honest about it.
Return ONLY valid JSON array. No markdown, no preamble.`;

// ─────────────────────────────────────────────────────────────
// MAIN GENERATOR
// ─────────────────────────────────────────────────────────────
export async function generateAnswers(
  input:     PrepInput,
  questions: InterviewQuestion[],
): Promise<SuggestedAnswer[]> {
  logger.info('Generating suggested answers', {
    questionCount: questions.length,
    batches: Math.ceil(questions.length / BATCH_SIZE),
  });

  // Skip closing questions — those are questions TO ASK, not to answer
  const answerable = questions.filter(q => q.category !== 'closing');

  const answers: SuggestedAnswer[] = [];
  const batches = chunkArray(answerable, BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    logger.debug(`Processing answer batch ${i + 1}/${batches.length}`, { count: batch.length });

    try {
      const batchAnswers = await processBatch(input, batch);
      answers.push(...batchAnswers);
    } catch (err) {
      logger.warn(`Batch ${i + 1} failed — using per-question fallback`, { error: String(err) });
      for (const q of batch) {
        answers.push(buildFallbackAnswer(q, input));
      }
    }

    // Pace API calls
    if (i < batches.length - 1) await sleep(500);
  }

  logger.info('Answers generated', { total: answers.length });
  return answers;
}

// ─────────────────────────────────────────────────────────────
// BATCH PROCESSOR
// ─────────────────────────────────────────────────────────────
async function processBatch(
  input:     PrepInput,
  questions: InterviewQuestion[],
): Promise<SuggestedAnswer[]> {
  const apiKey = process.env['ANTHROPIC_API_KEY']!;

  const prompt = buildBatchPrompt(input, questions);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:       'claude-sonnet-4-6',
      max_tokens:  5000,
      temperature: 0.3,
      system:      SYSTEM_PROMPT,
      messages:    [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API ${res.status}`);

  const data = await res.json() as { content: Array<{ type: string; text?: string }> };
  const raw  = data.content.find(c => c.type === 'text')?.text ?? '[]';

  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()) as RawAnswer[];

  return parsed.map((raw, idx) => normaliseAnswer(raw, questions[idx]?.id ?? '', input));
}

// ─────────────────────────────────────────────────────────────
// PROMPT BUILDER
// ─────────────────────────────────────────────────────────────
function buildBatchPrompt(
  input:     PrepInput,
  questions: InterviewQuestion[],
): string {
  const qs = questions.map((q, i) => `${i + 1}. [${q.category}] ${q.question}`).join('\n');

  // Extract most relevant resume sections
  const resumeSnippet = extractRelevantResume(input.resumeText, input.jobTitle);

  return `Generate personalised suggested answers for these ${questions.length} interview questions.

CANDIDATE APPLYING FOR: ${input.jobTitle} at ${input.companyName}
SENIORITY: ${input.seniority}

CANDIDATE RESUME (key sections):
${resumeSnippet}

QUESTIONS TO ANSWER:
${qs}

For each question, return a JSON object in this array:
[
  {
    "question_index": 1,
    "format": "STAR|direct|structured|narrative",
    "answer": "Full model answer (200-350 words). Use specific examples from the resume. For STAR: clearly label Situation, Task, Action, Result. For technical: be specific about the technology/approach. Start strong — don't say 'Great question' or 'Sure!'",
    "key_points": ["3-5 bullets of what to hit in this answer"],
    "avoid_points": ["2-3 common mistakes or things not to say"],
    "customised_for": "Brief note on which resume experience was used to personalise this",
    "strengths_used": ["Specific skills/experiences from resume used in this answer"]
  }
]

Return exactly ${questions.length} answer objects in order.`;
}

// ─────────────────────────────────────────────────────────────
// NORMALISE RAW CLAUDE OUTPUT
// ─────────────────────────────────────────────────────────────
interface RawAnswer {
  question_index:  number;
  format:          string;
  answer:          string;
  key_points:      string[];
  avoid_points:    string[];
  customised_for:  string;
  strengths_used:  string[];
}

function normaliseAnswer(
  raw:        RawAnswer,
  questionId: string,
  input:      PrepInput,
): SuggestedAnswer {
  const answer = raw.answer ?? '';
  return {
    questionId,
    format:        (raw.format ?? 'structured') as SuggestedAnswer['format'],
    answer,
    keyPoints:     Array.isArray(raw.key_points)    ? raw.key_points    : [],
    avoidPoints:   Array.isArray(raw.avoid_points)  ? raw.avoid_points  : [],
    customisedFor: raw.customised_for ?? `Tailored for ${input.jobTitle} at ${input.companyName}`,
    strengthsUsed: Array.isArray(raw.strengths_used) ? raw.strengths_used : [],
    wordCount:     answer.split(/\s+/).filter(Boolean).length,
  };
}

// ─────────────────────────────────────────────────────────────
// FALLBACK (per-question if batch fails)
// ─────────────────────────────────────────────────────────────
function buildFallbackAnswer(
  q:     InterviewQuestion,
  input: PrepInput,
): SuggestedAnswer {
  const formatMap: Record<InterviewQuestion['category'], SuggestedAnswer['format']> = {
    behavioral:        'STAR',
    technical:         'structured',
    system_design:     'structured',
    culture_fit:       'narrative',
    situational:       'STAR',
    role_specific:     'structured',
    company_knowledge: 'direct',
    closing:           'direct',
  };

  const format = formatMap[q.category] ?? 'structured';

  const starTemplate = `
*Situation:* Describe a specific, relevant situation from your experience at [Company].

*Task:* What was your responsibility or goal in that situation?

*Action:* Walk through the specific steps you took. Be detailed — this is where you demonstrate competence. Use "I" not "we" to show your personal contribution.

*Result:* Quantify the outcome where possible. What changed because of your actions? What did you learn?

*Closing:* Connect the experience back to what you'd bring to ${input.companyName}.`.trim();

  const technicalTemplate = `
Start by confirming your understanding of the question, then structure your answer:

1. **Your approach/experience with this topic** — State your level of experience clearly.
2. **Specific implementation details** — Go deep on the technical specifics relevant to ${input.jobTitle}.
3. **Trade-offs you've navigated** — Every technical choice has trade-offs. Show you understand them.
4. **Real-world example** — Reference a specific project where you applied this knowledge.
5. **How it applies here** — Connect to what ${input.companyName} likely needs.`.trim();

  const answer = format === 'STAR' ? starTemplate : technicalTemplate;

  return {
    questionId:    q.id,
    format,
    answer,
    keyPoints: [
      'Be specific — use names, numbers, dates where possible',
      'Show the impact of your actions, not just what you did',
      `Connect your experience to the ${input.jobTitle} role`,
      'Keep your answer focused — aim for 2–3 minutes max',
    ],
    avoidPoints: [
      'Don\'t be vague — "we worked on a project" tells them nothing',
      'Don\'t forget the Result in a STAR story — it\'s the most important part',
      'Don\'t speak negatively about former colleagues or employers',
    ],
    customisedFor: `Generic template — regenerate for a personalised answer`,
    strengthsUsed: [],
    wordCount:     answer.split(/\s+/).length,
  };
}

// ─────────────────────────────────────────────────────────────
// EXTRACT MOST RELEVANT RESUME SECTION
// ─────────────────────────────────────────────────────────────
function extractRelevantResume(resumeText: string, jobTitle: string): string {
  if (!resumeText) return 'No resume provided.';

  // Take first 1200 chars (usually includes summary + recent experience)
  const snippet = resumeText.slice(0, 1200);

  // Try to extract just the experience section
  const expMatch = resumeText.match(/(?:experience|work history|employment)[:\s]*([\s\S]{200,800})/i);
  if (expMatch?.[1]) {
    return `[Summary truncated]\n\nEXPERIENCE:\n${expMatch[1].slice(0, 800)}`;
  }

  return snippet;
}

// ─────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
