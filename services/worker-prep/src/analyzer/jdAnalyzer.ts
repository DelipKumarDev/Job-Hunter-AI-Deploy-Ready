// ============================================================
// JD & Company Analyzer
// Deep analysis of job description and company context.
//
// Extracts:
//  • Required vs preferred skills (weighted)
//  • Implicit tech stack from JD language signals
//  • Culture and values signals
//  • ATS keyword frequency map
//  • Experience requirements (years, seniority)
//  • Interview style inference (FAANG, startup, etc.)
//  • Company research via Claude web_search tool
//
// Output feeds into:
//  • Question generator (knows what to ask about)
//  • Topic prioritiser (knows what to prep)
//  • Resume tailor (knows which keywords to inject)
// ============================================================

import type { CompanyAnalysis, PrepInput, SeniorityLevel } from '../types/prepTypes.js';
import { logger } from '../utils/logger.js';

export interface JdAnalysis {
  // Skills
  requiredSkills:   WeightedSkill[];
  preferredSkills:  WeightedSkill[];
  impliedSkills:    WeightedSkill[];

  // ATS keywords
  atsKeywords:      AtsKeyword[];

  // Role characteristics
  senioritySignals: string[];
  yearsRequired:    number | null;
  teamSize:         string | null;
  responsibilities: string[];

  // Culture
  cultureSignals:   string[];
  workStyle:        string[];    // "remote", "fast-paced", "collaborative"

  // Interview hints
  interviewStyleHints: string[];
  likelyFocusAreas:    string[];
}

export interface WeightedSkill {
  name:      string;
  weight:    number;    // 1–10 (10 = explicitly required, 1 = vaguely implied)
  explicit:  boolean;   // Directly stated vs inferred
  category:  string;    // "language", "framework", "cloud", "methodology"
}

export interface AtsKeyword {
  term:       string;
  frequency:  number;   // How often it appears in JD
  importance: 'critical' | 'important' | 'supporting';
  inResume:   boolean;  // Whether candidate's resume already has it
}

// ── Tech signal patterns (implicit stack detection) ───────────
const TECH_SIGNALS: Record<string, string[]> = {
  'microservices':     ['distributed systems', 'service mesh', 'kubernetes', 'docker', 'api gateway'],
  'machine learning':  ['model training', 'feature engineering', 'ml pipeline', 'inference', 'model deployment'],
  'fintech':           ['pci dss', 'payments', 'fraud detection', 'compliance', 'kyc', 'aml'],
  'data engineering':  ['etl', 'data pipeline', 'data warehouse', 'spark', 'airflow', 'dbt'],
  'frontend':          ['responsive', 'accessibility', 'a11y', 'cross-browser', 'performance budgets'],
  'devops':            ['ci/cd', 'infrastructure as code', 'sre', 'on-call', 'slo', 'sla'],
  'security':          ['penetration testing', 'vulnerability', 'owasp', 'zero trust', 'encryption'],
};

// ── Seniority level detection ─────────────────────────────────
const SENIORITY_PATTERNS: Record<SeniorityLevel, RegExp[]> = {
  junior:    [/junior|entry.?level|associate|0.?2 years/i],
  mid:       [/\b(2|3|4).?5?\s*years?|\bmid.?level\b/i],
  senior:    [/senior|sr\.|5\+?\s*years?|lead\s+engineer/i],
  staff:     [/staff\s+engineer|technical\s+lead|tech\s+lead/i],
  principal: [/principal|distinguished|fellow/i],
  director:  [/director|vp\s+of|vice\s+president|head\s+of\s+engineering/i],
};

// ─────────────────────────────────────────────────────────────
// ANALYZE JOB DESCRIPTION
// ─────────────────────────────────────────────────────────────
export async function analyzeJobDescription(input: PrepInput): Promise<JdAnalysis> {
  logger.info('Analyzing JD', { company: input.companyName, role: input.jobTitle });

  const jd     = input.jobDescription;
  const lower  = jd.toLowerCase();
  const resume = (input.resumeText ?? '').toLowerCase();

  // ── Extract explicit skills (bullet-listed) ───────────────
  const requiredSkills   = extractSkillsFromSection(jd, 'required');
  const preferredSkills  = extractSkillsFromSection(jd, 'preferred');
  const impliedSkills    = extractImpliedSkills(lower);

  // ── ATS keyword frequency ────────────────────────────────
  const allSkillNames = [
    ...requiredSkills.map(s => s.name),
    ...preferredSkills.map(s => s.name),
    ...impliedSkills.map(s => s.name),
  ];

  const atsKeywords: AtsKeyword[] = allSkillNames.map(name => {
    const freq  = countOccurrences(lower, name.toLowerCase());
    const inRes = resume.includes(name.toLowerCase());
    return {
      term:       name,
      frequency:  freq,
      importance: requiredSkills.some(s => s.name === name) ? 'critical' :
                  preferredSkills.some(s => s.name === name) ? 'important' : 'supporting',
      inResume:   inRes,
    };
  }).sort((a, b) => b.frequency - a.frequency);

  // ── Seniority detection ───────────────────────────────────
  const senioritySignals: string[] = [];
  for (const [level, patterns] of Object.entries(SENIORITY_PATTERNS)) {
    if (patterns.some(p => p.test(jd))) {
      senioritySignals.push(level);
    }
  }

  // ── Years required ────────────────────────────────────────
  const yearsMatch = jd.match(/(\d+)\+?\s*years?\s*(?:of\s*)?(?:experience|exp)/i);
  const yearsRequired = yearsMatch ? parseInt(yearsMatch[1]!) : null;

  // ── Responsibilities ──────────────────────────────────────
  const responsibilities = extractBulletSection(jd,
    /responsibilities|what you.ll do|the role|your day/i
  ).slice(0, 8);

  // ── Culture signals ───────────────────────────────────────
  const cultureSignals = extractCultureSignals(lower);
  const workStyle      = extractWorkStyle(lower);

  // ── Interview style hints ─────────────────────────────────
  const interviewStyleHints = inferInterviewStyle(lower, input.companyName);

  // ── Focus areas ───────────────────────────────────────────
  const likelyFocusAreas = inferFocusAreas(lower, requiredSkills);

  return {
    requiredSkills,
    preferredSkills,
    impliedSkills,
    atsKeywords,
    senioritySignals,
    yearsRequired,
    teamSize: extractTeamSize(jd),
    responsibilities,
    cultureSignals,
    workStyle,
    interviewStyleHints,
    likelyFocusAreas,
  };
}

// ─────────────────────────────────────────────────────────────
// COMPANY ANALYSIS via Claude + Web Search
// ─────────────────────────────────────────────────────────────
export async function analyzeCompany(input: PrepInput): Promise<CompanyAnalysis> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    return buildFallbackCompanyAnalysis(input);
  }

  logger.info('Running company analysis with web search', { company: input.companyName });

  const prompt = `Research "${input.companyName}" and analyze this job description for the "${input.jobTitle}" role.

Job description excerpt:
${input.jobDescription.slice(0, 1200)}

${input.companyContext ? `Additional context: ${input.companyContext.slice(0, 500)}` : ''}

Use web_search to find:
1. What does ${input.companyName} do? (product, customers, revenue/funding)
2. Their tech stack (engineering blog, job postings, StackShare)
3. Interview process and culture (Glassdoor, Blind, Levels.fyi)
4. Recent news (funding, product launches, layoffs, acquisitions)

Return ONLY this JSON:
{
  "one_liner": "One crisp sentence: what they do and why it matters",
  "product_summary": "2-3 sentences on product, customers, scale",
  "tech_stack": ["list of known technologies"],
  "culture": ["3-5 culture signals from JD language and research"],
  "recent_news": ["2-3 recent notable items"],
  "interview_style": "What their interview process is known for (e.g. FAANG-style, practical coding, case studies)",
  "values": ["3-5 company values explicitly or implicitly present"],
  "competitors": ["2-3 main competitors"],
  "growth_stage": "e.g. Series B, Late-stage private, Public (NYSE: X)"
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
        max_tokens:  1200,
        temperature: 0,
        tools:       [{ type: 'web_search_20250305', name: 'web_search' }],
        messages:    [{ role: 'user', content: prompt }],
      }),
    });

    const data = await res.json() as {
      content:     Array<{ type: string; text?: string }>;
      stop_reason: string;
    };

    // If tool use triggered, continue conversation
    let finalText = data.content.find(c => c.type === 'text')?.text ?? '';

    if (data.stop_reason === 'tool_use' && !finalText) {
      const cont = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 1200, temperature: 0,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [
            { role: 'user',      content: prompt },
            { role: 'assistant', content: data.content },
          ],
        }),
      });
      const contData = await cont.json() as { content: Array<{ type: string; text?: string }> };
      finalText = contData.content.find(c => c.type === 'text')?.text ?? '';
    }

    const json = JSON.parse(finalText.replace(/```json|```/g, '').trim()) as {
      one_liner: string; product_summary: string; tech_stack: string[];
      culture: string[]; recent_news: string[]; interview_style: string;
      values: string[]; competitors: string[]; growth_stage: string | null;
    };

    return {
      name:           input.companyName,
      oneLiner:       json.one_liner       ?? `${input.companyName} — ${input.jobTitle} opportunity`,
      productSummary: json.product_summary ?? '',
      techStack:      json.tech_stack      ?? [],
      culture:        json.culture         ?? [],
      recentNews:     json.recent_news     ?? [],
      interviewStyle: json.interview_style ?? 'Standard technical + behavioral rounds',
      values:         json.values          ?? [],
      competitors:    json.competitors     ?? [],
      growthStage:    json.growth_stage    ?? null,
    };
  } catch (err) {
    logger.warn('Company analysis failed — using fallback', { error: String(err) });
    return buildFallbackCompanyAnalysis(input);
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function extractSkillsFromSection(jd: string, type: 'required' | 'preferred'): import('../types/prepTypes.js').WeightedSkill[] {
  const patterns = type === 'required'
    ? [/required|must have|you have|you bring|you need|qualifications/i]
    : [/preferred|nice to have|bonus|ideal|plus|desired/i];

  const section = extractSection(jd, patterns);
  return parseSkillBullets(section || jd, type === 'required' ? 8 : 6);
}

function parseSkillBullets(text: string, maxWeight: number): import('../types/prepTypes.js').WeightedSkill[] {
  const skills: import('../types/prepTypes.js').WeightedSkill[] = [];
  const seen = new Set<string>();

  // Tech keyword patterns
  const techPatterns = [
    /\b(Python|TypeScript|JavaScript|Java|Go|Rust|C\+\+|Ruby|Scala|Kotlin|Swift|PHP|R)\b/gi,
    /\b(React|Vue|Angular|Next\.js|Node\.js|Django|FastAPI|Spring|Rails|Laravel|Express)\b/gi,
    /\b(AWS|GCP|Azure|Kubernetes|Docker|Terraform|Ansible|Helm|ArgoCD|Jenkins)\b/gi,
    /\b(PostgreSQL|MySQL|MongoDB|Redis|Elasticsearch|Cassandra|DynamoDB|BigQuery|Snowflake)\b/gi,
    /\b(Kafka|RabbitMQ|SQS|Pub\/Sub|Kinesis|gRPC|GraphQL|REST|WebSockets)\b/gi,
    /\b(TensorFlow|PyTorch|scikit-learn|Pandas|Spark|Flink|dbt|Airflow|MLflow)\b/gi,
    /\b(Git|GitHub|GitLab|JIRA|Agile|Scrum|Kanban|CI\/CD|TDD|BDD)\b/gi,
  ];

  const categoryMap: Record<string, string> = {
    Python: 'language', TypeScript: 'language', JavaScript: 'language', Java: 'language',
    Go: 'language', Rust: 'language', React: 'framework', Vue: 'framework', Angular: 'framework',
    'Next.js': 'framework', 'Node.js': 'framework', AWS: 'cloud', GCP: 'cloud', Azure: 'cloud',
    Kubernetes: 'infrastructure', Docker: 'infrastructure', Terraform: 'infrastructure',
    PostgreSQL: 'database', MySQL: 'database', MongoDB: 'database', Redis: 'database',
    Kafka: 'messaging', gRPC: 'protocol', GraphQL: 'protocol', REST: 'protocol',
    TensorFlow: 'ml', PyTorch: 'ml', Agile: 'methodology', Scrum: 'methodology',
  };

  for (const pattern of techPatterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[0];
      if (!seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        skills.push({
          name,
          weight:   maxWeight,
          explicit: true,
          category: categoryMap[name] ?? 'tool',
        });
      }
    }
  }

  return skills.slice(0, 15);
}

function extractImpliedSkills(lower: string): import('../types/prepTypes.js').WeightedSkill[] {
  const implied: import('../types/prepTypes.js').WeightedSkill[] = [];
  for (const [signal, related] of Object.entries(TECH_SIGNALS)) {
    if (lower.includes(signal)) {
      for (const skill of related) {
        implied.push({ name: skill, weight: 3, explicit: false, category: 'implied' });
      }
    }
  }
  return implied;
}

function extractSection(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(new RegExp(`(?:${pattern.source})[:\\s]*\\n([\\s\\S]{0,800})`, pattern.flags));
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractBulletSection(text: string, sectionPattern: RegExp): string[] {
  const lines = text.split('\n');
  let inSection = false;
  const bullets: string[] = [];

  for (const line of lines) {
    if (sectionPattern.test(line)) { inSection = true; continue; }
    if (inSection) {
      if (/^#{1,3}\s|^[A-Z][a-z]+:/.test(line) && bullets.length > 0) break;
      const cleaned = line.replace(/^[\s•\-*▪◦]+/, '').trim();
      if (cleaned.length > 20) bullets.push(cleaned);
    }
  }
  return bullets;
}

function countOccurrences(text: string, term: string): number {
  return (text.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) ?? []).length;
}

function extractCultureSignals(lower: string): string[] {
  const signals: string[] = [];
  const checks: [RegExp, string][] = [
    [/remote.?first|fully remote/i, 'Remote-first culture'],
    [/fast.?paced|high.?growth|hypergrowth/i, 'Fast-paced environment'],
    [/collaborative|cross.?functional/i, 'Collaborative team structure'],
    [/ownership|autonomy|empowered/i, 'High ownership & autonomy'],
    [/data.?driven|metrics|kpi/i, 'Data-driven decision making'],
    [/inclusive|diverse|belonging/i, 'Diversity & inclusion focus'],
    [/startup|scrappy|hustle/i, 'Startup energy'],
    [/work.?life balance|flexible hours/i, 'Flexible working hours'],
    [/mentorship|learning|growth/i, 'Learning & development culture'],
    [/mission.?driven|impact/i, 'Mission-driven organisation'],
  ];
  for (const [pattern, signal] of checks) {
    if (pattern.test(lower)) signals.push(signal);
  }
  return signals;
}

function extractWorkStyle(lower: string): string[] {
  const styles: string[] = [];
  if (/remote/i.test(lower))        styles.push('remote');
  if (/hybrid/i.test(lower))        styles.push('hybrid');
  if (/on.?site|in.?office/i.test(lower)) styles.push('onsite');
  if (/async|asynchronous/i.test(lower)) styles.push('async');
  if (/agile|scrum|sprint/i.test(lower))  styles.push('agile');
  return styles;
}

function inferInterviewStyle(lower: string, company: string): string[] {
  const hints: string[] = [];
  const fangCompanies = ['google', 'meta', 'amazon', 'apple', 'microsoft', 'netflix', 'uber', 'airbnb', 'stripe'];
  if (fangCompanies.some(c => company.toLowerCase().includes(c))) {
    hints.push('FAANG-style — expect LeetCode-level algorithmic questions');
    hints.push('System design is typically a separate round');
  }
  if (/take.?home|technical assessment|coding challenge/i.test(lower)) {
    hints.push('Take-home assessment likely involved');
  }
  if (/case study|product sense/i.test(lower)) {
    hints.push('Case study or product sense round expected');
  }
  if (/pair programming/i.test(lower)) {
    hints.push('Pair programming session likely');
  }
  return hints;
}

function inferFocusAreas(lower: string, skills: import('../types/prepTypes.js').WeightedSkill[]): string[] {
  const areas = skills.slice(0, 5).map(s => s.name);
  if (/scalab|high.?availab|distributed/i.test(lower)) areas.push('Distributed Systems');
  if (/machine learning|ml |ai /i.test(lower))          areas.push('Machine Learning Fundamentals');
  if (/sql|query|database/i.test(lower))                 areas.push('Database Design & SQL');
  return [...new Set(areas)].slice(0, 8);
}

function extractTeamSize(jd: string): string | null {
  const m = jd.match(/team of (\d+[\-–]\d+|\d+\+?|\w+)/i);
  return m ? m[1]! : null;
}

function buildFallbackCompanyAnalysis(input: PrepInput): CompanyAnalysis {
  return {
    name:           input.companyName,
    oneLiner:       `${input.companyName} is hiring for ${input.jobTitle}`,
    productSummary: input.companyContext ?? 'Review their website before the interview.',
    techStack:      [],
    culture:        extractCultureSignals(input.jobDescription.toLowerCase()),
    recentNews:     [],
    interviewStyle: 'Standard technical and behavioral interview rounds',
    values:         [],
    competitors:    [],
    growthStage:    null,
  };
}
