// ============================================================
// Match Scorer Tests
// Tests the weighted scoring formula and validator
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  computeWeightedScore,
  computeRecommendation,
  validateClaudeOutput,
  buildMatchAnalysis,
} from '../scorers/scoreValidator.js';
import { SCORE_WEIGHTS } from '../types.js';

// ── Weighted formula tests ────────────────────────────────────
describe('computeWeightedScore', () => {
  it('applies 40/30/20/10 weights correctly', () => {
    const output = {
      skillsScore: { raw: 100, rationale: '', signals: [] },
      experienceScore: { raw: 100, rationale: '', signals: [] },
      locationScore: { raw: 100, rationale: '', signals: [] },
      salaryScore: { raw: 100, rationale: '', signals: [] },
      missingSkills: [],
      strengthAreas: [],
      redFlags: [],
      keyHighlights: [],
      summary: 'Perfect match',
    };

    expect(computeWeightedScore(output)).toBe(100);
  });

  it('weights skills at 40%', () => {
    const output = {
      skillsScore: { raw: 100, rationale: '', signals: [] },
      experienceScore: { raw: 0, rationale: '', signals: [] },
      locationScore: { raw: 0, rationale: '', signals: [] },
      salaryScore: { raw: 0, rationale: '', signals: [] },
      missingSkills: [], strengthAreas: [], redFlags: [], keyHighlights: [],
      summary: '',
    };
    // 100 * 0.40 + 0 + 0 + 0 = 40
    expect(computeWeightedScore(output)).toBe(40);
    expect(SCORE_WEIGHTS.SKILLS).toBe(40);
  });

  it('weights experience at 30%', () => {
    const output = {
      skillsScore: { raw: 0, rationale: '', signals: [] },
      experienceScore: { raw: 100, rationale: '', signals: [] },
      locationScore: { raw: 0, rationale: '', signals: [] },
      salaryScore: { raw: 0, rationale: '', signals: [] },
      missingSkills: [], strengthAreas: [], redFlags: [], keyHighlights: [],
      summary: '',
    };
    expect(computeWeightedScore(output)).toBe(30);
  });

  it('weights location at 20%', () => {
    const output = {
      skillsScore: { raw: 0, rationale: '', signals: [] },
      experienceScore: { raw: 0, rationale: '', signals: [] },
      locationScore: { raw: 100, rationale: '', signals: [] },
      salaryScore: { raw: 0, rationale: '', signals: [] },
      missingSkills: [], strengthAreas: [], redFlags: [], keyHighlights: [],
      summary: '',
    };
    expect(computeWeightedScore(output)).toBe(20);
  });

  it('weights salary at 10%', () => {
    const output = {
      skillsScore: { raw: 0, rationale: '', signals: [] },
      experienceScore: { raw: 0, rationale: '', signals: [] },
      locationScore: { raw: 0, rationale: '', signals: [] },
      salaryScore: { raw: 100, rationale: '', signals: [] },
      missingSkills: [], strengthAreas: [], redFlags: [], keyHighlights: [],
      summary: '',
    };
    expect(computeWeightedScore(output)).toBe(10);
  });

  it('weights sum to 100', () => {
    const total = SCORE_WEIGHTS.SKILLS + SCORE_WEIGHTS.EXPERIENCE + SCORE_WEIGHTS.LOCATION + SCORE_WEIGHTS.SALARY;
    expect(total).toBe(100);
  });

  it('computes realistic mixed scores correctly', () => {
    // Skills: 90, Exp: 80, Location: 60, Salary: 70
    // Expected: 90*0.4 + 80*0.3 + 60*0.2 + 70*0.1 = 36 + 24 + 12 + 7 = 79
    const output = {
      skillsScore: { raw: 90, rationale: '', signals: [] },
      experienceScore: { raw: 80, rationale: '', signals: [] },
      locationScore: { raw: 60, rationale: '', signals: [] },
      salaryScore: { raw: 70, rationale: '', signals: [] },
      missingSkills: [], strengthAreas: [], redFlags: [], keyHighlights: [],
      summary: '',
    };
    expect(computeWeightedScore(output)).toBe(79);
  });

  it('clamps output to 0–100 range', () => {
    const output = {
      skillsScore: { raw: 0, rationale: '', signals: [] },
      experienceScore: { raw: 0, rationale: '', signals: [] },
      locationScore: { raw: 0, rationale: '', signals: [] },
      salaryScore: { raw: 0, rationale: '', signals: [] },
      missingSkills: [], strengthAreas: [], redFlags: [], keyHighlights: [],
      summary: '',
    };
    const score = computeWeightedScore(output);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

// ── Recommendation tests ───────────────────────────────────
describe('computeRecommendation', () => {
  it('returns YES for scores >= 75 without red flags', () => {
    expect(computeRecommendation(75, false)).toBe('YES');
    expect(computeRecommendation(90, false)).toBe('YES');
    expect(computeRecommendation(100, false)).toBe('YES');
  });

  it('returns MAYBE for scores 50–74', () => {
    expect(computeRecommendation(50, false)).toBe('MAYBE');
    expect(computeRecommendation(74, false)).toBe('MAYBE');
  });

  it('returns NO for scores below 50', () => {
    expect(computeRecommendation(49, false)).toBe('NO');
    expect(computeRecommendation(0, false)).toBe('NO');
  });

  it('downgrades recommendation when red flags present', () => {
    expect(computeRecommendation(72, true)).toBe('NO');   // < 70 with flags = NO
    expect(computeRecommendation(80, true)).toBe('MAYBE'); // 70-84 with flags = MAYBE
    expect(computeRecommendation(90, true)).toBe('YES');   // >= 85 with flags = still YES
  });
});

// ── Validator tests ────────────────────────────────────────
describe('validateClaudeOutput', () => {
  it('accepts valid output', () => {
    const valid = {
      skillsScore: { raw: 85, rationale: 'Strong React skills', signals: ['React', 'TypeScript'] },
      experienceScore: { raw: 75, rationale: '5 years matches', signals: [] },
      locationScore: { raw: 90, rationale: 'Remote role, no restriction', signals: [] },
      salaryScore: { raw: 70, rationale: 'Ranges overlap', signals: [] },
      missingSkills: ['Kubernetes'],
      strengthAreas: ['React expertise'],
      redFlags: [],
      keyHighlights: ['5 years React'],
      summary: 'Strong candidate for this role.',
    };
    expect(() => validateClaudeOutput(valid)).not.toThrow();
  });

  it('rejects scores outside 0–100', () => {
    const invalid = {
      skillsScore: { raw: 150, rationale: 'Too high', signals: [] },
      experienceScore: { raw: 75, rationale: '', signals: [] },
      locationScore: { raw: 90, rationale: '', signals: [] },
      salaryScore: { raw: 70, rationale: '', signals: [] },
      missingSkills: [], strengthAreas: [], redFlags: [], keyHighlights: [],
      summary: 'Test',
    };
    expect(() => validateClaudeOutput(invalid)).toThrow();
  });

  it('fills in default arrays when missing', () => {
    const minimal = {
      skillsScore: { raw: 80, rationale: 'Good', signals: [] },
      experienceScore: { raw: 70, rationale: 'OK', signals: [] },
      locationScore: { raw: 60, rationale: 'Remote', signals: [] },
      salaryScore: { raw: 90, rationale: 'Match', signals: [] },
      summary: 'Looks good.',
      // Missing arrays — should default to []
    };
    const result = validateClaudeOutput(minimal);
    expect(result.missingSkills).toEqual([]);
    expect(result.strengthAreas).toEqual([]);
    expect(result.redFlags).toEqual([]);
  });
});
