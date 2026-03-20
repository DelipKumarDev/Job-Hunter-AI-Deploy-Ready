// ============================================================
// @job-hunter/database — Prisma Client Export
// All services import PrismaClient from here to ensure one
// consistent generated client version across the monorepo.
// ============================================================

export { PrismaClient, Prisma } from '@prisma/client';
export type {
  User,
  UserProfile,
  JobPreference,
  JobListing,
  Application,
  Resume,
  UserEmailAccount,
  EmailThread,
  FollowupLog,
  Notification,
  InterviewSchedule,
  ApplicationStatusHistory,
} from '@prisma/client';
