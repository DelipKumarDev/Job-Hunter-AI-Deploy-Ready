// ============================================================
// Subscription Plan Limits
// ============================================================

export const PLAN_LIMITS = {
  FREE: {
    monthlyApplyLimit: 10,
    aiCallsLimit: 50,
    jobSearchPlatforms: 2,
    resumeVersions: 1,
    emailAccounts: 1,
    followUpsEnabled: false,
    interviewPrepEnabled: false,
    resumeTailoringEnabled: false,
    whatsappNotifications: false,
  },
  STARTER: {
    monthlyApplyLimit: 100,
    aiCallsLimit: 500,
    jobSearchPlatforms: 4,
    resumeVersions: 3,
    emailAccounts: 2,
    followUpsEnabled: true,
    interviewPrepEnabled: false,
    resumeTailoringEnabled: true,
    whatsappNotifications: true,
  },
  PROFESSIONAL: {
    monthlyApplyLimit: 500,
    aiCallsLimit: 2000,
    jobSearchPlatforms: 6,
    resumeVersions: 10,
    emailAccounts: 3,
    followUpsEnabled: true,
    interviewPrepEnabled: true,
    resumeTailoringEnabled: true,
    whatsappNotifications: true,
  },
  ENTERPRISE: {
    monthlyApplyLimit: -1,       // Unlimited
    aiCallsLimit: -1,            // Unlimited
    jobSearchPlatforms: 6,
    resumeVersions: -1,          // Unlimited
    emailAccounts: 5,
    followUpsEnabled: true,
    interviewPrepEnabled: true,
    resumeTailoringEnabled: true,
    whatsappNotifications: true,
  },
} as const;

export type PlanName = keyof typeof PLAN_LIMITS;

export function getPlanLimits(plan: PlanName) {
  return PLAN_LIMITS[plan];
}

export function isUnlimited(value: number): boolean {
  return value === -1;
}

// Bot rate limiting
export const BOT_LIMITS = {
  MAX_APPLICATIONS_PER_DAY: 20,
  MAX_APPLICATIONS_PER_HOUR: 5,
  MAX_FOLLOW_UPS_PER_APPLICATION: 2,
  FOLLOW_UP_DELAY_DAYS: 5,
  SECOND_FOLLOW_UP_DELAY_DAYS: 7,
  MIN_MATCH_SCORE_FOR_AUTO_APPLY: 75,
} as const;
