// ============================================================
// Technical Preparation Topic Generator
// Builds a prioritised study plan from JD analysis.
//
// Priority levels:
//   critical      — Explicitly required + high frequency in JD
//   high          — Required skills the candidate may be weak on
//   medium        — Preferred skills or implied by role
//   nice_to_have  — Good to know, unlikely to be tested hard
//
// Each topic includes:
//   - Description of what to cover
//   - Specific subtopics
//   - Estimated hours to reach interview readiness
//   - Curated resources (docs, articles, practice sites)
//
// Resource links are real, commonly-known URLs.
// Claude generates the topic list; resource URLs are
// injected from a curated map to avoid hallucinated links.
// ============================================================

import { randomUUID } from 'crypto';
import type { PrepTopic, PrepInput } from '../types/prepTypes.js';
import type { JdAnalysis, CompanyAnalysis } from '../analyzer/jdAnalyzer.js';
import { logger } from '../utils/logger.js';

// ── Curated resource map — real, stable URLs ──────────────────
const RESOURCE_MAP: Record<string, Array<{ type: string; title: string; url: string }>> = {
  // Languages
  'python': [
    { type: 'documentation', title: 'Python Official Docs', url: 'https://docs.python.org/3/' },
    { type: 'practice', title: 'Exercism Python Track', url: 'https://exercism.org/tracks/python' },
  ],
  'typescript': [
    { type: 'documentation', title: 'TypeScript Handbook', url: 'https://www.typescriptlang.org/docs/handbook/intro.html' },
    { type: 'practice', title: 'Type Challenges', url: 'https://github.com/type-challenges/type-challenges' },
  ],
  'javascript': [
    { type: 'documentation', title: 'MDN JavaScript Guide', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide' },
    { type: 'practice', title: 'JavaScript.info', url: 'https://javascript.info/' },
  ],

  // Frameworks
  'react': [
    { type: 'documentation', title: 'React Official Docs', url: 'https://react.dev/' },
    { type: 'article', title: 'React Interview Questions', url: 'https://github.com/sudheerj/reactjs-interview-questions' },
  ],
  'node.js': [
    { type: 'documentation', title: 'Node.js Docs', url: 'https://nodejs.org/docs/latest/api/' },
    { type: 'article', title: 'Node.js Best Practices', url: 'https://github.com/goldbergyoni/nodebestpractices' },
  ],

  // Infrastructure
  'kubernetes': [
    { type: 'documentation', title: 'Kubernetes Docs', url: 'https://kubernetes.io/docs/home/' },
    { type: 'practice', title: 'Kubernetes Interactive Tutorial', url: 'https://kubernetes.io/docs/tutorials/kubernetes-basics/' },
  ],
  'aws': [
    { type: 'documentation', title: 'AWS Documentation', url: 'https://docs.aws.amazon.com/' },
    { type: 'practice', title: 'AWS Skill Builder', url: 'https://skillbuilder.aws/' },
  ],
  'docker': [
    { type: 'documentation', title: 'Docker Docs', url: 'https://docs.docker.com/' },
    { type: 'practice', title: 'Play with Docker', url: 'https://labs.play-with-docker.com/' },
  ],

  // Databases
  'postgresql': [
    { type: 'documentation', title: 'PostgreSQL Docs', url: 'https://www.postgresql.org/docs/' },
    { type: 'practice', title: 'PGExercises', url: 'https://pgexercises.com/' },
  ],
  'redis': [
    { type: 'documentation', title: 'Redis Docs', url: 'https://redis.io/docs/' },
    { type: 'article', title: 'Redis University', url: 'https://university.redis.com/' },
  ],

  // System design
  'system design': [
    { type: 'book', title: 'Designing Data-Intensive Applications — Kleppmann', url: 'https://dataintensive.net/' },
    { type: 'article', title: 'System Design Primer', url: 'https://github.com/donnemartin/system-design-primer' },
    { type: 'video', title: 'ByteByteGo System Design', url: 'https://www.youtube.com/@ByteByteGo' },
  ],

  // Algorithms
  'algorithms': [
    { type: 'practice', title: 'LeetCode', url: 'https://leetcode.com/' },
    { type: 'practice', title: 'NeetCode Roadmap', url: 'https://neetcode.io/roadmap' },
    { type: 'book', title: 'Cracking the Coding Interview', url: 'https://www.crackingthecodinginterview.com/' },
  ],

  // Behavioral
  'behavioral': [
    { type: 'article', title: 'STAR Method Guide', url: 'https://www.themuse.com/advice/star-interview-method' },
    { type: 'practice', title: 'Pramp Mock Interviews', url: 'https://www.pramp.com/' },
  ],

  // ML/AI
  'machine learning': [
    { type: 'documentation', title: 'Scikit-learn User Guide', url: 'https://scikit-learn.org/stable/user_guide.html' },
    { type: 'practice', title: 'Kaggle Learn', url: 'https://www.kaggle.com/learn' },
  ],
  'tensorflow': [
    { type: 'documentation', title: 'TensorFlow Docs', url: 'https://www.tensorflow.org/learn' },
    { type: 'practice', title: 'TensorFlow Tutorials', url: 'https://www.tensorflow.org/tutorials' },
  ],
};

// ─────────────────────────────────────────────────────────────
// MAIN GENERATOR
// ─────────────────────────────────────────────────────────────
export async function generateTopics(
  input:   PrepInput,
  jd:      JdAnalysis,
  company: CompanyAnalysis,
): Promise<PrepTopic[]> {
  logger.info('Generating prep topics', {
    requiredSkills: jd.requiredSkills.length,
    seniority:      input.seniority,
  });

  const topics: PrepTopic[] = [];

  // ── Critical: required skills not in resume ───────────────
  const missingRequired = jd.requiredSkills
    .filter(s => !isInResume(s.name, input.resumeText))
    .slice(0, 4);

  for (const skill of missingRequired) {
    topics.push(buildTopic(skill.name, 'critical', 'jd_explicit', input, jd));
  }

  // ── High: required skills that exist but may need refreshing ──
  const existingRequired = jd.requiredSkills
    .filter(s => isInResume(s.name, input.resumeText))
    .slice(0, 3);

  for (const skill of existingRequired) {
    topics.push(buildTopic(skill.name, 'high', 'jd_explicit', input, jd));
  }

  // ── Always include system design for senior+ ─────────────
  if (['senior', 'staff', 'principal', 'director'].includes(input.seniority)) {
    topics.push(buildTopic('system design', 'critical', 'role_standard', input, jd));
  }

  // ── Always include algorithms/DS ─────────────────────────
  topics.push(buildTopic('algorithms', 'high', 'role_standard', input, jd));

  // ── Always include behavioral prep ───────────────────────
  topics.push(buildTopic('behavioral', 'high', 'role_standard', input, jd));

  // ── Medium: preferred skills ──────────────────────────────
  const preferred = jd.preferredSkills.slice(0, 3);
  for (const skill of preferred) {
    topics.push(buildTopic(skill.name, 'medium', 'jd_explicit', input, jd));
  }

  // ── Company-specific topics from tech stack ───────────────
  const companyStack = company.techStack
    .filter(t => !topics.some(topic => topic.area.toLowerCase() === t.toLowerCase()))
    .slice(0, 2);

  for (const tech of companyStack) {
    topics.push(buildTopic(tech, 'medium', 'company_stack', input, jd));
  }

  // ── Enrich with Claude for detailed subtopics ─────────────
  const enriched = await enrichTopicsWithClaude(topics, input, jd);

  logger.info('Prep topics generated', {
    total:    enriched.length,
    critical: enriched.filter(t => t.priority === 'critical').length,
    high:     enriched.filter(t => t.priority === 'high').length,
  });

  return enriched.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, nice_to_have: 3 };
    return order[a.priority] - order[b.priority];
  });
}

// ─────────────────────────────────────────────────────────────
// BUILD A SINGLE TOPIC
// ─────────────────────────────────────────────────────────────
function buildTopic(
  area:     string,
  priority: PrepTopic['priority'],
  source:   PrepTopic['source'],
  input:    PrepInput,
  jd:       JdAnalysis,
): PrepTopic {
  const normalised = area.toLowerCase();
  const resources  = findResources(normalised);
  const hours      = estimateHours(priority, normalised, input);

  return {
    id:          randomUUID(),
    area:        capitalise(area),
    priority,
    source,
    description: buildDescription(area, priority, input),
    subtopics:   buildSubtopics(normalised, input),
    resources,
    estimatedHours: hours,
  };
}

// ─────────────────────────────────────────────────────────────
// ENRICH WITH CLAUDE (adds richer subtopics + descriptions)
// ─────────────────────────────────────────────────────────────
async function enrichTopicsWithClaude(
  topics: PrepTopic[],
  input:  PrepInput,
  jd:     JdAnalysis,
): Promise<PrepTopic[]> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) return topics;

  try {
    const topicList = topics.map((t, i) => `${i + 1}. ${t.area} (${t.priority})`).join('\n');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 2500, temperature: 0,
        system: 'You are a senior engineer creating a personalised technical interview study plan. Return ONLY valid JSON array. No markdown.',
        messages: [{
          role: 'user',
          content: `Create specific, actionable subtopics for each prep area.

ROLE: ${input.jobTitle} at ${input.companyName}
SENIORITY: ${input.seniority}
JD KEYWORDS: ${jd.requiredSkills.slice(0, 5).map(s => s.name).join(', ')}

TOPICS TO ENRICH:
${topicList}

Return JSON array (same order as input):
[{
  "area": "Topic name",
  "description": "2 sentences: what to cover and why it matters for this role",
  "subtopics": ["5-7 specific subtopics — go deep, not broad"]
}]`,
        }],
      }),
    });

    const data = await res.json() as { content: Array<{ type: string; text?: string }> };
    const raw  = data.content.find(c => c.type === 'text')?.text ?? '[]';
    const enrichments = JSON.parse(raw.replace(/```json|```/g, '').trim()) as Array<{
      area: string; description: string; subtopics: string[];
    }>;

    return topics.map((topic, i) => {
      const enrich = enrichments[i];
      if (!enrich) return topic;
      return {
        ...topic,
        description: enrich.description || topic.description,
        subtopics:   enrich.subtopics?.length ? enrich.subtopics : topic.subtopics,
      };
    });
  } catch (err) {
    logger.warn('Topic enrichment failed', { error: String(err) });
    return topics;
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function findResources(area: string): PrepTopic['resources'] {
  // Exact match first
  if (RESOURCE_MAP[area]) return RESOURCE_MAP[area]!.map(r => ({ ...r, type: r.type as PrepTopic['resources'][0]['type'] }));

  // Partial match
  for (const [key, resources] of Object.entries(RESOURCE_MAP)) {
    if (area.includes(key) || key.includes(area)) {
      return resources.map(r => ({ ...r, type: r.type as PrepTopic['resources'][0]['type'] }));
    }
  }

  // Generic fallback
  return [
    { type: 'practice', title: `${capitalise(area)} on LeetCode`, url: `https://leetcode.com/tag/${area.replace(/\s+/g, '-')}/` },
    { type: 'article', title: `${capitalise(area)} Interview Questions — GitHub`, url: `https://github.com/search?q=${encodeURIComponent(area + ' interview questions')}` },
  ];
}

function buildDescription(area: string, priority: PrepTopic['priority'], input: PrepInput): string {
  const urgency = priority === 'critical' ? 'This is a must-know for this role'
                : priority === 'high'     ? 'Strongly expected at interview'
                : priority === 'medium'   ? 'Will strengthen your candidacy'
                :                           'Good to mention if it comes up naturally';

  return `${urgency}. Prepare ${area} fundamentals tailored to ${input.seniority}-level expectations at ${input.companyName}.`;
}

function buildSubtopics(area: string, input: PrepInput): string[] {
  const subtopicMap: Record<string, string[]> = {
    'system design': [
      'Load balancing strategies (L4 vs L7)',
      'Database sharding and replication patterns',
      'Caching layers: CDN, Redis, local cache',
      'Message queues and async processing',
      'CAP theorem and consistency trade-offs',
      'API design: REST vs gRPC vs GraphQL',
      `Scalability to ${input.seniority === 'senior' ? '10M' : '1M'} users — walk-through approach`,
    ],
    'algorithms': [
      'Two-pointer and sliding window patterns',
      'BFS / DFS — trees and graphs',
      'Dynamic programming fundamentals',
      'Binary search and its variants',
      'Hash maps and set operations',
      'Heap / priority queue usage',
      'Time and space complexity analysis',
    ],
    'behavioral': [
      'Prepare 5–7 STAR stories covering: leadership, failure, conflict, impact, innovation',
      'Your "greatest achievement" story (quantified)',
      'A time you disagreed with management',
      'A time you mentored or grew someone',
      'Why this company / why this role',
      'Where you want to be in 3–5 years',
      'Questions to ask at the end',
    ],
    'sql': [
      'JOINs: INNER, LEFT, RIGHT, FULL OUTER, CROSS',
      'Window functions: ROW_NUMBER, RANK, LAG, LEAD',
      'Subqueries and CTEs',
      'Indexes: B-tree, covering, composite',
      'EXPLAIN / EXPLAIN ANALYZE for query optimisation',
      'Transactions and isolation levels',
    ],
  };

  for (const [key, subs] of Object.entries(subtopicMap)) {
    if (area.includes(key) || key.includes(area)) return subs;
  }

  return [
    `Core concepts and fundamental principles`,
    `Common interview patterns for ${capitalise(area)}`,
    `Production use cases and best practices`,
    `Performance considerations and trade-offs`,
    `Integration with other systems`,
  ];
}

function estimateHours(priority: PrepTopic['priority'], area: string, input: PrepInput): number {
  const base: Record<PrepTopic['priority'], number> = {
    critical: 8, high: 5, medium: 3, nice_to_have: 1,
  };
  let hours = base[priority];

  // Complex topics need more time
  if (['system design', 'algorithms', 'machine learning'].includes(area)) hours *= 1.5;

  // Senior roles need deeper prep
  if (['staff', 'principal', 'director'].includes(input.seniority)) hours *= 1.3;

  return Math.round(hours);
}

function isInResume(skill: string, resumeText: string): boolean {
  return resumeText.toLowerCase().includes(skill.toLowerCase());
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
