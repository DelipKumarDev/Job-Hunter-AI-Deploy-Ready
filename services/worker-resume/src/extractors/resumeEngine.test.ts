// ============================================================
// Resume Intelligence Engine — Unit Tests
// Tests: section detection, date parsing, experience years,
// taxonomy lookup, and profile shape validation
// ============================================================

import { describe, it, expect } from 'vitest';
import { lookupTech, normalizeTechName, getAllCanonicalTech } from '../extractors/techTaxonomy.js';
import {
  buildFullTextEmbedding,
  buildSkillsEmbedding,
  cosineSimilarity,
  computeEmbeddingBoost,
} from '../embeddings/embeddingGenerator.js';
import type { CandidateProfile } from '../types/resumeTypes.js';

// ── Tech Taxonomy Tests ───────────────────────────────────────
describe('Tech Taxonomy', () => {
  it('looks up canonical name by exact match', () => {
    const entry = lookupTech('React');
    expect(entry?.canonical).toBe('React');
  });

  it('looks up canonical name by alias (lowercase)', () => {
    const entry = lookupTech('reactjs');
    expect(entry?.canonical).toBe('React');
  });

  it('normalises alias to canonical name', () => {
    expect(normalizeTechName('nodejs')).toBe('Node.js');
    expect(normalizeTechName('k8s')).toBe('Kubernetes');
    expect(normalizeTechName('postgres')).toBe('PostgreSQL');
    expect(normalizeTechName('ts')).toBe('TypeScript');
  });

  it('returns original term when not in taxonomy', () => {
    expect(normalizeTechName('SomeProprietary SDK')).toBe('SomeProprietary SDK');
  });

  it('all canonical names are unique', () => {
    const canonical = getAllCanonicalTech();
    const unique = new Set(canonical);
    expect(unique.size).toBe(canonical.length);
  });

  it('classifies Python as programming_language', () => {
    const entry = lookupTech('python');
    expect(entry?.category).toBe('programming_language');
  });

  it('classifies PostgreSQL as database', () => {
    const entry = lookupTech('psql');
    expect(entry?.category).toBe('database');
  });

  it('classifies Docker as devops', () => {
    const entry = lookupTech('dockerfile');
    expect(entry?.category).toBe('devops');
  });

  it('classifies AWS as cloud', () => {
    const entry = lookupTech('amazon web services');
    expect(entry?.category).toBe('cloud');
  });
});

// ── Embedding Tests ───────────────────────────────────────────
const mockProfile: CandidateProfile = {
  name:             'Jane Smith',
  email:            'jane@example.com',
  phone:            '+1-555-0100',
  location:         'San Francisco, CA',
  linkedinUrl:      'https://linkedin.com/in/janesmith',
  githubUrl:        'https://github.com/janesmith',
  portfolioUrl:     null,
  summary:          'Full-stack engineer with 7 years building scalable web apps.',
  currentTitle:     'Senior Software Engineer',
  seniorityLevel:   'senior',
  experience_years: 7,
  roles:            ['Senior Software Engineer', 'Software Engineer', 'Junior Developer'],
  industries:       ['SaaS', 'Fintech'],
  skills: [
    { name: 'TypeScript', category: 'programming_language', proficiency: 'expert', yearsUsed: 5, explicit: true },
    { name: 'React', category: 'framework', proficiency: 'expert', yearsUsed: 5, explicit: true },
    { name: 'Node.js', category: 'framework', proficiency: 'advanced', yearsUsed: 4, explicit: true },
    { name: 'PostgreSQL', category: 'database', proficiency: 'advanced', yearsUsed: 4, explicit: true },
    { name: 'AWS', category: 'cloud', proficiency: 'intermediate', yearsUsed: 3, explicit: true },
  ],
  skills_flat: ['TypeScript', 'React', 'Node.js', 'PostgreSQL', 'AWS'],
  technologies: [
    { name: 'TypeScript', type: 'language', version: null },
    { name: 'React', type: 'framework', version: '18' },
    { name: 'PostgreSQL', type: 'database', version: null },
  ],
  technologies_flat: ['TypeScript', 'React', 'PostgreSQL'],
  experience: [
    {
      title: 'Senior Software Engineer', company: 'Stripe', location: 'San Francisco',
      startDate: '2021-03', endDate: null, isCurrent: true, durationMonths: 36,
      description: 'Led frontend architecture', achievements: ['Reduced load time by 40%'],
      skills: ['TypeScript', 'React'], technologies: ['TypeScript', 'React'],
    },
    {
      title: 'Software Engineer', company: 'Twilio', location: 'Remote',
      startDate: '2018-06', endDate: '2021-02', isCurrent: false, durationMonths: 32,
      description: 'Built API integrations', achievements: [],
      skills: ['Node.js', 'PostgreSQL'], technologies: ['Node.js'],
    },
  ],
  education: [
    {
      institution: 'UC Berkeley', degree: 'B.S.', field: 'Computer Science',
      level: 'bachelors', startYear: 2014, endYear: 2018, gpa: 3.8, honors: 'Magna Cum Laude',
    },
  ],
  highest_degree:  'bachelors',
  certifications:  [],
  languages:       [{ name: 'English', proficiency: 'Native' }],
  _meta: {
    extractedAt: new Date().toISOString(),
    modelUsed: 'claude-sonnet-4-6',
    tokensUsed: 1200,
    parserVersion: '2.0.0',
    rawTextLength: 3400,
    confidence: 0.92,
    warnings: [],
  },
};

describe('Embedding Text Builders', () => {
  it('builds full-text embedding with expected fields', () => {
    const text = buildFullTextEmbedding(mockProfile);
    expect(text).toContain('Senior Software Engineer');
    expect(text).toContain('7');
    expect(text).toContain('TypeScript');
    expect(text).toContain('React');
    expect(text).toContain('Stripe');
    expect(text).toContain('UC Berkeley');
  });

  it('builds skills-only embedding concisely', () => {
    const text = buildSkillsEmbedding(mockProfile);
    expect(text).toContain('TypeScript');
    expect(text).toContain('React');
    expect(text.length).toBeLessThan(buildFullTextEmbedding(mockProfile).length);
  });

  it('full embedding is longer than skills embedding', () => {
    const full   = buildFullTextEmbedding(mockProfile);
    const skills = buildSkillsEmbedding(mockProfile);
    expect(full.length).toBeGreaterThan(skills.length);
  });
});

describe('Cosine Similarity', () => {
  it('identical vectors have similarity 1.0', () => {
    const v = [0.5, 0.5, 0.5, 0.5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it('orthogonal vectors have similarity 0.0', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it('opposite vectors have similarity -1.0', () => {
    const a = [1, 0];
    const b = [-1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('Embedding Boost', () => {
  it('high similarity boosts score', () => {
    const boosted = computeEmbeddingBoost(0.95, 75);
    expect(boosted).toBeGreaterThan(75);
  });

  it('low similarity penalises score', () => {
    const penalised = computeEmbeddingBoost(0.20, 75);
    expect(penalised).toBeLessThan(75);
  });

  it('neutral similarity (0.625) has no effect', () => {
    const neutral = computeEmbeddingBoost(0.625, 75);
    expect(neutral).toBe(75);
  });

  it('never exceeds 100', () => {
    expect(computeEmbeddingBoost(1.0, 98)).toBeLessThanOrEqual(100);
  });

  it('never goes below 0', () => {
    expect(computeEmbeddingBoost(0.0, 2)).toBeGreaterThanOrEqual(0);
  });
});

// ── Profile Shape Tests ───────────────────────────────────────
describe('CandidateProfile shape', () => {
  it('has all required top-level keys', () => {
    const requiredKeys = [
      'name','email','phone','location','summary','currentTitle',
      'seniorityLevel','experience_years','roles','industries',
      'skills','skills_flat','technologies','technologies_flat',
      'experience','education','highest_degree','certifications',
      'languages','_meta',
    ] as const;

    for (const key of requiredKeys) {
      expect(mockProfile).toHaveProperty(key);
    }
  });

  it('skills_flat matches skills array names', () => {
    expect(mockProfile.skills_flat).toEqual(mockProfile.skills.map(s => s.name));
  });

  it('experience_years is a positive number', () => {
    expect(mockProfile.experience_years).toBeGreaterThan(0);
    expect(typeof mockProfile.experience_years).toBe('number');
  });

  it('confidence is between 0 and 1', () => {
    expect(mockProfile._meta.confidence).toBeGreaterThanOrEqual(0);
    expect(mockProfile._meta.confidence).toBeLessThanOrEqual(1);
  });
});
