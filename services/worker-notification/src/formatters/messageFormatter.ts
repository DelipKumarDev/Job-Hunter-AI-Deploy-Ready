// ============================================================
// WhatsApp Message Formatter
// Converts structured briefing data into clearly formatted
// WhatsApp messages. WhatsApp supports limited markdown:
//
//   *bold*          → bold text
//   _italic_        → italic text
//   ~strikethrough~ → strikethrough
//   ```code```      → monospace
//   > blockquote    → quote
//
// Each notification type has a distinct format.
// Long content is split into numbered parts (max 4096 chars).
//
// Message shapes:
//   Interview Briefing  → 4 parts (header, prep, questions, CTA)
//   Interview Request   → 1 part with buttons
//   Offer Received      → 1 rich part
//   Rejection           → 1 short compassionate part
//   Application Submit  → 1 confirmation part
//   Follow-up Sent      → 1 short status part
//   Daily Digest        → dynamic summary part
// ============================================================

import type {
  InterviewBriefing, GeneratedBriefing,
  NotificationEvent,
} from '../types/notificationTypes.js';

// Max WhatsApp body length
const MAX_CHARS = 4096;

// ─────────────────────────────────────────────────────────────
// INTERVIEW BRIEFING — 4-part rich message
// Part 1: Header + company summary + interview logistics
// Part 2: Role highlights + key prep topics
// Part 3: Suggested questions (all 3 types)
// Part 4: Smart CTA with meeting link
// ─────────────────────────────────────────────────────────────
export function formatInterviewBriefing(
  briefing:  InterviewBriefing,
  generated: GeneratedBriefing,
): string[] {
  const parts: string[] = [];

  // ── Part 1: Header + logistics + company ─────────────────
  const p1 = [
    `🎯 *Interview Briefing*`,
    ``,
    `📌 *${escapeWa(briefing.jobTitle)}*`,
    `🏢 ${escapeWa(briefing.companyName)}`,
    ``,
    formatInterviewLogistics(briefing),
    ``,
    `━━━━━━━━━━━━━━━━━━━`,
    ``,
    `🏢 *About ${escapeWa(briefing.companyName)}*`,
    ``,
    escapeWa(generated.companySummary),
    generated.cultureInsight ? `\n💡 _${escapeWa(generated.cultureInsight)}_` : '',
  ].filter(l => l !== null).join('\n');

  parts.push(p1);

  // ── Part 2: Role highlights + prep topics ────────────────
  const roleLines = generated.roleHighlights
    .slice(0, 4)
    .map(h => `  • ${escapeWa(h)}`);

  const topicLines = generated.keyTopics
    .slice(0, 5)
    .map((t, i) => `  ${i + 1}. ${escapeWa(t)}`);

  const p2 = [
    `📋 *Role Highlights*`,
    ``,
    ...roleLines,
    ``,
    `━━━━━━━━━━━━━━━━━━━`,
    ``,
    `📚 *Key Topics to Prepare*`,
    ``,
    ...topicLines,
    generated.salaryInsight ? `\n💰 *Compensation:* _${escapeWa(generated.salaryInsight)}_` : '',
  ].filter(l => l !== null).join('\n');

  parts.push(p2);

  // ── Part 3: Interview questions ───────────────────────────
  const bLines = generated.suggestedQuestions.behavioural
    .slice(0, 3)
    .map((q, i) => `*${i + 1}.* ${escapeWa(q)}`);

  const tLines = generated.suggestedQuestions.technical
    .slice(0, 3)
    .map((q, i) => `*${i + 1}.* ${escapeWa(q)}`);

  const aLines = generated.suggestedQuestions.toAsk
    .slice(0, 3)
    .map((q, i) => `*${i + 1}.* ${escapeWa(q)}`);

  const p3 = [
    `❓ *Suggested Interview Questions*`,
    ``,
    `🧠 *Behavioural (STAR format)*`,
    ``,
    ...bLines,
    ``,
    `⚙️ *Technical*`,
    ``,
    ...tLines,
    ``,
    `🙋 *Questions to Ask Them*`,
    ``,
    ...aLines,
  ].join('\n');

  parts.push(p3);

  // ── Part 4: CTA ───────────────────────────────────────────
  const ctaLines = [
    `✅ *You're Ready!*`,
    ``,
    `Here's your pre-interview checklist:`,
    ``,
    `  ☐ Research ${escapeWa(briefing.companyName)}'s latest product updates`,
    `  ☐ Prepare 3 STAR stories from your experience`,
    `  ☐ Test your ${briefing.platform ?? 'video'} setup 10 min before`,
    `  ☐ Have your resume open for reference`,
    `  ☐ Write down your 3 questions to ask`,
  ];

  if (briefing.meetingLink) {
    ctaLines.push(``, `🔗 *Meeting Link:*`, briefing.meetingLink);
  }

  if (briefing.interviewers.length > 0) {
    ctaLines.push(``, `👥 *You'll meet:* ${briefing.interviewers.map(escapeWa).join(', ')}`);
  }

  ctaLines.push(``, `_Good luck, ${escapeWa(briefing.candidateName.split(' ')[0]!)}! You've got this. 💪_`);

  parts.push(ctaLines.join('\n'));

  return parts.map(p => p.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// INTERVIEW REQUEST (short, with buttons)
// ─────────────────────────────────────────────────────────────
export function formatInterviewRequest(
  companyName:    string,
  jobTitle:       string,
  recruiterName:  string | null,
  recruiterEmail: string,
): { body: string; buttons: Array<{ id: string; title: string }> } {
  const from = recruiterName ? `*${escapeWa(recruiterName)}*` : 'the recruiter';

  const body = [
    `📅 *Interview Request*`,
    ``,
    `${from} at *${escapeWa(companyName)}* wants to schedule an interview for the *${escapeWa(jobTitle)}* role.`,
    ``,
    `Reply to their email with your available times to confirm.`,
    ``,
    `📧 ${recruiterEmail}`,
  ].join('\n');

  return {
    body,
    buttons: [
      { id: 'view_application', title: '📋 View Application' },
      { id: 'open_email',       title: '📧 Open Email' },
    ],
  };
}

// ─────────────────────────────────────────────────────────────
// OFFER RECEIVED
// ─────────────────────────────────────────────────────────────
export function formatOfferReceived(
  companyName:    string,
  jobTitle:       string,
  recruiterName:  string | null,
  salaryMentioned: string | null,
  startDate:      string | null,
): string {
  const lines = [
    `🎊 *Job Offer Received!*`,
    ``,
    `Congratulations! You've received an offer from *${escapeWa(companyName)}* for the *${escapeWa(jobTitle)}* role.`,
    ``,
  ];

  if (salaryMentioned) lines.push(`💰 *Compensation:* ${escapeWa(salaryMentioned)}`, ``);
  if (startDate)       lines.push(`📅 *Start Date:* ${escapeWa(startDate)}`, ``);
  if (recruiterName)   lines.push(`👤 *Contact:* ${escapeWa(recruiterName)}`, ``);

  lines.push(
    `━━━━━━━━━━━━━━━━━━━`,
    ``,
    `_Before accepting, consider: compensation package, growth trajectory, team culture, and competing offers._`,
    ``,
    `📋 Review the full offer details in your dashboard.`,
  );

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// REJECTION (compassionate, brief)
// ─────────────────────────────────────────────────────────────
export function formatRejection(
  companyName: string,
  jobTitle:    string,
  isSoft:      boolean,
): string {
  if (isSoft) {
    return [
      `📋 *Application Update — ${escapeWa(companyName)}*`,
      ``,
      `${escapeWa(companyName)} isn't moving forward with the *${escapeWa(jobTitle)}* role right now, but has kept your profile on file for future opportunities.`,
      ``,
      `_This happens to great candidates all the time. Keep going. 👊_`,
    ].join('\n');
  }

  return [
    `📋 *Application Update — ${escapeWa(companyName)}*`,
    ``,
    `${escapeWa(companyName)} has decided not to move forward with your application for *${escapeWa(jobTitle)}* at this time.`,
    ``,
    `_Every rejection is one step closer to the right fit. Your follow-ups have been cancelled automatically._`,
    ``,
    `Keep applying — your next opportunity is being tracked. 🎯`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────
// APPLICATION SUBMITTED
// ─────────────────────────────────────────────────────────────
export function formatApplicationSubmitted(
  companyName:  string,
  jobTitle:     string,
  appliedAt:    Date,
  followUpDays: number[],
): string {
  const dateStr  = appliedAt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const fuDates  = followUpDays.map(d => {
    const dt = new Date(appliedAt.getTime() + d * 86400 * 1000);
    return `Day ${d}: ${dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
  });

  return [
    `✅ *Application Submitted*`,
    ``,
    `📌 *${escapeWa(jobTitle)}*`,
    `🏢 ${escapeWa(companyName)}`,
    `📅 Applied: ${dateStr}`,
    ``,
    `━━━━━━━━━━━━━━━━━━━`,
    ``,
    `📬 *Automatic Follow-Up Schedule*`,
    ``,
    ...fuDates.map(d => `  • ${d}`),
    ``,
    `_Follow-ups will be sent automatically and cancelled if the recruiter replies._`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────
// FOLLOW-UP SENT
// ─────────────────────────────────────────────────────────────
export function formatFollowUpSent(
  companyName:    string,
  jobTitle:       string,
  followUpNumber: 1 | 2 | 3,
  nextFollowUp:   Date | null,
): string {
  const ordinal = ['1st', '2nd', '3rd'][followUpNumber - 1];

  const lines = [
    `📤 *Follow-Up Sent — ${escapeWa(companyName)}*`,
    ``,
    `Your *${ordinal} follow-up* for the *${escapeWa(jobTitle)}* role has been sent.`,
    ``,
  ];

  if (nextFollowUp) {
    const next = nextFollowUp.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    lines.push(`📅 Next follow-up: *${next}*`, ``);
  } else {
    lines.push(`_This was your final follow-up for this application._`, ``);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// ASSESSMENT RECEIVED
// ─────────────────────────────────────────────────────────────
export function formatAssessmentReceived(
  companyName:  string,
  jobTitle:     string,
  platform:     string | null,
  deadline:     string | null,
  link:         string | null,
): string {
  const lines = [
    `📝 *Assessment Received — ${escapeWa(companyName)}*`,
    ``,
    `You've been sent a technical assessment for the *${escapeWa(jobTitle)}* role.`,
    ``,
  ];

  if (platform) lines.push(`🛠️ *Platform:* ${escapeWa(platform)}`, ``);
  if (deadline) lines.push(`⏰ *Deadline:* ${escapeWa(deadline)}`, ``);
  if (link)     lines.push(`🔗 *Link:* ${link}`, ``);

  lines.push(
    `━━━━━━━━━━━━━━━━━━━`,
    ``,
    `💡 *Tips:*`,
    `  • Read all instructions carefully before starting`,
    `  • Don't submit until you've tested edge cases`,
    `  • Write clean, well-commented code`,
    `  • Check time complexity and optimise where needed`,
  );

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// DAILY DIGEST
// ─────────────────────────────────────────────────────────────
export interface DigestEntry {
  companyName: string;
  jobTitle:    string;
  status:      string;
  matchScore:  number;
}

export function formatDailyDigest(
  candidateName:  string,
  date:           Date,
  applied:        number,
  interviews:     number,
  offers:         number,
  topMatches:     DigestEntry[],
  followUpsSent:  number,
): string {
  const dateStr = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const lines = [
    `📊 *Daily Job Hunt Update*`,
    `_${dateStr}_`,
    ``,
    `Good morning, *${escapeWa(candidateName.split(' ')[0]!)}*! Here's your summary:`,
    ``,
    `━━━━━━━━━━━━━━━━━━━`,
    ``,
    `📬 *Applications:* ${applied}`,
    `📅 *Interviews:* ${interviews}`,
    `🎊 *Offers:* ${offers}`,
    `📤 *Follow-ups Sent:* ${followUpsSent}`,
  ];

  if (topMatches.length > 0) {
    lines.push(``, `━━━━━━━━━━━━━━━━━━━`, ``, `🎯 *Top New Matches*`, ``);
    for (const m of topMatches.slice(0, 5)) {
      const bar = scoreBar(m.matchScore);
      lines.push(`*${escapeWa(m.jobTitle)}* @ ${escapeWa(m.companyName)}`);
      lines.push(`${bar} ${m.matchScore}% match — ${escapeWa(m.status)}`);
      lines.push(``);
    }
  }

  lines.push(`_Keep it up! Every application is progress. 🚀_`);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function formatInterviewLogistics(b: InterviewBriefing): string {
  const lines: string[] = [];

  if (b.interviewDate) {
    const dateStr = b.interviewDate.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    lines.push(`📅 *Date:* ${dateStr}`);
  }

  if (b.interviewTime) {
    lines.push(`🕐 *Time:* ${b.interviewTime}${b.timezone ? ` (${b.timezone})` : ''}`);
  }

  lines.push(`📞 *Format:* ${escapeWa(b.format)}`);

  if (b.platform) lines.push(`💻 *Platform:* ${escapeWa(b.platform)}`);
  if (b.duration) lines.push(`⏱️ *Duration:* ${b.duration} minutes`);
  if (b.recruiterName) lines.push(`👤 *Recruiter:* ${escapeWa(b.recruiterName)}`);

  return lines.join('\n');
}

// Escape WhatsApp special chars in user content
function escapeWa(text: string | null | undefined): string {
  if (!text) return '';
  // Only escape characters that WhatsApp interprets as formatting
  // when they appear at word boundaries
  return text.replace(/([*_~`])/g, '\\$1');
}

function scoreBar(score: number): string {
  const filled = Math.round(score / 20);
  return '█'.repeat(filled) + '░'.repeat(5 - filled);
}

// Split a long string into ≤4096 char chunks on paragraph boundaries
export function splitIntoParts(text: string, maxLen = MAX_CHARS): string[] {
  if (text.length <= maxLen) return [text];

  const parts: string[] = [];
  const paragraphs = text.split('\n\n');
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxLen) {
      if (current) parts.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}
