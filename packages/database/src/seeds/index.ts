// ============================================================
// Database Seed Script
// Creates initial data for development environment
// ============================================================

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function seed(): Promise<void> {
  console.log('🌱 Seeding database...');

  // ── Admin User ─────────────────────────────────────────────
  const adminPassword = await bcrypt.hash('admin123456', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@jobhunterai.com' },
    update: {},
    create: {
      email: 'admin@jobhunterai.com',
      passwordHash: adminPassword,
      role: 'ADMIN',
      isVerified: true,
      profile: {
        create: {
          firstName: 'Admin',
          lastName: 'User',
          headline: 'System Administrator',
        },
      },
      subscription: {
        create: {
          plan: 'ENTERPRISE',
          status: 'ACTIVE',
          monthlyApplyLimit: -1,
          aiCallsLimit: -1,
        },
      },
    },
  });

  // ── Demo User ──────────────────────────────────────────────
  const demoPassword = await bcrypt.hash('demo123456', 12);
  const demoUser = await prisma.user.upsert({
    where: { email: 'demo@jobhunterai.com' },
    update: {},
    create: {
      email: 'demo@jobhunterai.com',
      passwordHash: demoPassword,
      phone: '+1234567890',
      whatsappNumber: '+1234567890',
      isVerified: true,
      profile: {
        create: {
          firstName: 'Alex',
          lastName: 'Demo',
          headline: 'Senior Full Stack Developer',
          bio: 'Passionate developer with 5 years of experience in React, Node.js, and cloud technologies.',
          location: 'San Francisco, CA',
          country: 'US',
          linkedinUrl: 'https://linkedin.com/in/alex-demo',
          githubUrl: 'https://github.com/alex-demo',
          yearsExperience: 5,
          seniorityLevel: 'senior',
          currentTitle: 'Full Stack Developer',
        },
      },
      subscription: {
        create: {
          plan: 'PROFESSIONAL',
          status: 'ACTIVE',
          monthlyApplyLimit: 500,
          aiCallsLimit: 2000,
        },
      },
      jobPreferences: {
        create: {
          targetRoles: ['Full Stack Developer', 'Software Engineer', 'Backend Developer'],
          preferredLocations: ['San Francisco', 'Remote', 'New York'],
          jobTypes: ['FULL_TIME'],
          remotePreference: 'HYBRID_OK',
          salaryMin: 120000,
          salaryMax: 180000,
          salaryCurrency: 'USD',
          autoApplyEnabled: false,
          minMatchScore: 70,
          maxApplicationsPerDay: 10,
          searchPlatforms: ['LINKEDIN', 'INDEED', 'WELLFOUND'],
        },
      },
    },
  });

  // ── Demo Skills ───────────────────────────────────────────
  const skills = [
    { name: 'React.js', category: 'Frontend', proficiency: 'EXPERT' as const },
    { name: 'Node.js', category: 'Backend', proficiency: 'ADVANCED' as const },
    { name: 'TypeScript', category: 'Language', proficiency: 'ADVANCED' as const },
    { name: 'PostgreSQL', category: 'Database', proficiency: 'INTERMEDIATE' as const },
    { name: 'AWS', category: 'Cloud', proficiency: 'INTERMEDIATE' as const },
    { name: 'Docker', category: 'DevOps', proficiency: 'INTERMEDIATE' as const },
    { name: 'Python', category: 'Language', proficiency: 'INTERMEDIATE' as const },
    { name: 'GraphQL', category: 'API', proficiency: 'ADVANCED' as const },
  ];

  for (const skill of skills) {
    await prisma.skill.upsert({
      where: { userId_name: { userId: demoUser.id, name: skill.name } },
      update: {},
      create: { userId: demoUser.id, ...skill },
    });
  }

  // ── Sample Job Listings ───────────────────────────────────
  const jobs = [
    {
      title: 'Senior Full Stack Developer',
      company: 'TechCorp Inc',
      location: 'San Francisco, CA',
      jobType: 'FULL_TIME' as const,
      remoteType: 'HYBRID' as const,
      description: 'We are looking for a Senior Full Stack Developer with expertise in React, Node.js, and PostgreSQL. You will build scalable web applications and work with a talented team.',
      salaryMin: 140000,
      salaryMax: 180000,
      salaryCurrency: 'USD',
      sourcePlatform: 'LINKEDIN' as const,
      sourceUrl: 'https://linkedin.com/jobs/view/1',
    },
    {
      title: 'Backend Engineer - Node.js',
      company: 'StartupXYZ',
      location: 'Remote',
      jobType: 'FULL_TIME' as const,
      remoteType: 'REMOTE' as const,
      description: 'Join our backend team to build high-performance APIs using Node.js, TypeScript, and microservices architecture.',
      salaryMin: 110000,
      salaryMax: 150000,
      salaryCurrency: 'USD',
      sourcePlatform: 'WELLFOUND' as const,
      sourceUrl: 'https://wellfound.com/jobs/2',
    },
  ];

  for (const job of jobs) {
    await prisma.jobListing.upsert({
      where: { sourceUrl: job.sourceUrl },
      update: {},
      create: job,
    });
  }

  console.log('✅ Seed complete!');
  console.log(`   Admin: admin@jobhunterai.com / admin123456`);
  console.log(`   Demo:  demo@jobhunterai.com  / demo123456`);
}

seed()
  .catch((error) => {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
