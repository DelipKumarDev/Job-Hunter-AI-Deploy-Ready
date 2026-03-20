// ============================================================
// Candidate Loader
// Assembles CandidateFormData from 3 DB tables:
//   users + profiles + resumes + tailored_resumes
// Generates presigned S3 URLs for file downloads.
// ============================================================

import type { PrismaClient } from '@prisma/client';
import type { CandidateFormData } from '../types/botTypes.js';
import { logger } from '../utils/logger.js';

export async function loadCandidate(
  prisma:         PrismaClient,
  userId:         string,
  resumeId:       string,
  coverLetterId?: string,
): Promise<CandidateFormData> {

  // Load user + profile + resume in parallel
  const [user, profile, resume, coverLetter] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where:  { id: userId },
      select: { id: true, email: true, name: true },
    }),
    prisma.profile.findUnique({
      where:  { userId },
      select: {
        headline: true, location: true,
        linkedinUrl: true, githubUrl: true, portfolioUrl: true,
        seniorityLevel: true,
        salaryMin: true, noticePeriod: true,
        workAuthorization: true, requireSponsorship: true,
        willingToRelocate: true, remotePreference: true,
        phone: true, city: true, state: true, country: true,
        currentCompany: true, yearsOfExperience: true,
        educationLevel: true, school: true, degree: true, graduationYear: true,
        professionalSummary: true,
      },
    }),
    prisma.resume.findUniqueOrThrow({
      where:  { id: resumeId, userId },
      select: {
        id: true, fileUrl: true, fileName: true,
        parsedJson: true,
      },
    }),
    coverLetterId
      ? prisma.tailoredResume.findUnique({
          where:  { id: coverLetterId },
          select: { tailoredFileUrl: true, jobListingId: true },
        }).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Parse name
  const fullName  = user.name ?? 'Candidate';
  const nameParts = fullName.trim().split(/\s+/);
  const firstName = nameParts[0] ?? fullName;
  const lastName  = nameParts.slice(1).join(' ') || '';

  // Extract years of experience
  let yearsExp: number | null = profile?.yearsOfExperience ?? null;
  if (!yearsExp && resume.parsedJson) {
    const json = resume.parsedJson as Record<string, unknown>;
    if (typeof json['experience_years'] === 'number') {
      yearsExp = json['experience_years'] as number;
    }
  }

  // Cover letter file
  let coverLetterS3Url: string | null = null;
  let coverLetterFileName: string | null = null;
  if (coverLetter?.tailoredFileUrl) {
    coverLetterS3Url     = coverLetter.tailoredFileUrl;
    coverLetterFileName  = 'cover_letter.pdf';
  }

  // Extract cover letter text from profile/resume data
  const parsedJson = (resume.parsedJson ?? {}) as Record<string, unknown>;

  const candidate: CandidateFormData = {
    // Identity
    firstName,
    lastName,
    fullName,
    email:    user.email,
    phone:    profile?.phone ?? null,
    location: profile?.location ?? null,
    city:     profile?.city    ?? null,
    state:    profile?.state   ?? null,
    country:  profile?.country ?? null,

    // Online presence
    linkedinUrl:  profile?.linkedinUrl  ?? null,
    githubUrl:    profile?.githubUrl    ?? null,
    portfolioUrl: profile?.portfolioUrl ?? null,

    // Career
    currentTitle:    profile?.headline     ?? parsedJson['currentTitle'] as string ?? null,
    currentCompany:  profile?.currentCompany ?? parsedJson['currentCompany'] as string ?? null,
    yearsExperience: yearsExp,
    educationLevel:  profile?.educationLevel ?? null,
    school:          profile?.school         ?? null,
    degree:          profile?.degree         ?? null,
    graduationYear:  profile?.graduationYear ?? null,

    // Preferences
    salaryExpectation:  profile?.salaryMin      ?? null,
    noticePeriod:       profile?.noticePeriod    ?? '2 weeks',
    workAuthorization:  profile?.workAuthorization  ? 'Yes' : 'Yes',
    requireSponsorship: profile?.requireSponsorship ? 'Yes' : 'No',
    willingToRelocate:  profile?.willingToRelocate  ? 'Yes' : 'No',
    remotePreference:   profile?.remotePreference   ?? 'Remote',

    // Files
    resumeS3Url:         resume.fileUrl,
    coverLetterS3Url,
    resumeFileName:      resume.fileName ?? 'resume.pdf',
    coverLetterFileName,

    // Text content
    coverLetterText:     null, // Generated separately by AI cover letter engine
    professionalSummary: profile?.professionalSummary ?? null,
  };

  logger.debug('Candidate loaded', {
    name:         candidate.fullName,
    email:        candidate.email,
    hasPhone:     !!candidate.phone,
    hasLinkedIn:  !!candidate.linkedinUrl,
    hasCoverLetter: !!candidate.coverLetterS3Url,
    yearsExp:     candidate.yearsExperience,
  });

  return candidate;
}
