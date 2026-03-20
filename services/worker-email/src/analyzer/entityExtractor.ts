// ============================================================
// Entity Extractor
// Pulls structured entities from recruiter email body:
//
//   • Company name (domain heuristic + pattern matching)
//   • Job title / role name
//   • Recruiter name + title
//   • Hiring manager name
//   • Interview format + platform
//   • Video call link (Zoom, Meet, Teams, Webex)
//   • Dial-in phone number + passcode
//   • Calendly / scheduling links
//   • Duration in minutes
//   • Requested documents (portfolio, references…)
//   • Deadlines for documents / assessments
//   • Assessment links (HackerRank, Codility…)
//   • Location (office city or "Remote")
//   • Salary mentions
// ============================================================

import type { ExtractedEntities, MeetingDetails, InterviewFormat } from './analyzerTypes.js';

// ── Video meeting platforms ───────────────────────────────────
const VIDEO_PLATFORMS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /zoom\.us\/j\/[\d?password=&]+/i,                         name: 'Zoom' },
  { pattern: /meet\.google\.com\/[a-z-]+/i,                            name: 'Google Meet' },
  { pattern: /teams\.microsoft\.com\/l\/meetup-join\/[^>\s"]+/i,       name: 'Microsoft Teams' },
  { pattern: /webex\.com\/meet\/[^>\s"]+/i,                            name: 'Cisco Webex' },
  { pattern: /bluejeans\.com\/[^>\s"]+/i,                              name: 'BlueJeans' },
  { pattern: /gotomeeting\.com\/join\/\d+/i,                           name: 'GoToMeeting' },
  { pattern: /whereby\.com\/[^>\s"]+/i,                                name: 'Whereby' },
  { pattern: /around\.co\/r\/[^>\s"]+/i,                               name: 'Around' },
];

const SCHEDULING_LINKS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /calendly\.com\/[^>\s"]+/i,          name: 'Calendly' },
  { pattern: /cal\.com\/[^>\s"]+/i,               name: 'Cal.com' },
  { pattern: /savvycal\.com\/[^>\s"]+/i,          name: 'SavvyCal' },
  { pattern: /hubspot\.com\/meetings\/[^>\s"]+/i, name: 'HubSpot Meetings' },
  { pattern: /doodle\.com\/poll\/[^>\s"]+/i,      name: 'Doodle' },
  { pattern: /acuityscheduling\.com\/[^>\s"]+/i,  name: 'Acuity' },
];

const ASSESSMENT_LINKS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /hackerrank\.com\/[^>\s"]+/i,   name: 'HackerRank' },
  { pattern: /codility\.com\/[^>\s"]+/i,     name: 'Codility' },
  { pattern: /coderpad\.io\/[^>\s"]+/i,      name: 'CoderPad' },
  { pattern: /testgorilla\.com\/[^>\s"]+/i,  name: 'TestGorilla' },
  { pattern: /mercer\.mettl\.com\/[^>\s"]+/i, name: 'Mettl' },
  { pattern: /app\.greenhouse\.io\/tests\/[^>\s"]+/i, name: 'Greenhouse Test' },
];

// ── Document types ────────────────────────────────────────────
const DOC_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\breferences?\b/i,                      label: 'references' },
  { pattern: /\bportfolio\b/i,                        label: 'portfolio' },
  { pattern: /\bwriting sample\b/i,                   label: 'writing_sample' },
  { pattern: /\bwork sample\b/i,                      label: 'work_sample' },
  { pattern: /\btranscript\b/i,                       label: 'transcript' },
  { pattern: /\bcertification|certificate\b/i,        label: 'certification' },
  { pattern: /\bcover letter\b/i,                     label: 'cover_letter' },
  { pattern: /\blinkedin(?: profile| url)?\b/i,       label: 'linkedin_profile' },
  { pattern: /\bbackground (?:check|verification)\b/i, label: 'background_check' },
  { pattern: /\bidentification|passport|id\b/i,       label: 'identification' },
];

// ── Interview format signals ──────────────────────────────────
const FORMAT_MAP: Array<{ patterns: RegExp[]; format: InterviewFormat }> = [
  { patterns: [/phone (?:screen|interview|call)/i, /call you on/i],   format: 'phone_screen' },
  { patterns: [/video (?:interview|call|conference)/i, /virtual/i, /zoom|google meet|teams|webex/i], format: 'video_call' },
  { patterns: [/technical (?:interview|screen|round)/i, /coding (?:interview|challenge)/i], format: 'technical_interview' },
  { patterns: [/take.?home|homework assignment/i],                    format: 'take_home_assessment' },
  { patterns: [/on.?site|in.?person|come (?:in|to the office)/i],    format: 'onsite' },
  { patterns: [/panel (?:interview|discussion)/i, /meet the team/i], format: 'panel' },
  { patterns: [/informal (?:chat|coffee|conversation)/i, /casual chat/i], format: 'informal_chat' },
];

// ─────────────────────────────────────────────────────────────
// EXTRACT ENTITIES
// ─────────────────────────────────────────────────────────────
export function extractEntities(
  body:      string,
  subject:   string,
  fromEmail: string,
  fromName:  string | null,
): ExtractedEntities {
  const full = `${subject}\n${body}`;

  return {
    companyName:         extractCompany(full, fromEmail),
    jobTitle:            extractJobTitle(full),
    recruiterName:       fromName ?? extractRecruiterName(body),
    recruiterTitle:      extractRecruiterTitle(body),
    hiringManager:       extractHiringManager(body),
    location:            extractLocation(full),
    requestedDocuments:  extractDocuments(body),
    deadlineText:        extractDeadline(body),
    assessmentLink:      extractLink(body, ASSESSMENT_LINKS),
    assessmentDeadline:  extractAssessmentDeadline(body),
    salaryMentioned:     extractSalary(body),
    startDateMentioned:  extractStartDate(body),
  };
}

// ─────────────────────────────────────────────────────────────
// EXTRACT MEETING DETAILS
// ─────────────────────────────────────────────────────────────
export function extractMeetingDetails(body: string): MeetingDetails | null {
  const format    = detectInterviewFormat(body);
  const platform  = extractPlatformName(body);
  const videoLink = extractLink(body, VIDEO_PLATFORMS);
  const calLink   = extractLink(body, SCHEDULING_LINKS);
  const dialIn    = extractDialIn(body);
  const duration  = extractDuration(body);
  const interviewers = extractInterviewers(body);

  // Only return meeting details if we found something actionable
  if (!videoLink && !calLink && !dialIn && !platform && format === 'unknown') {
    return null;
  }

  return {
    format,
    platform,
    meetingLink:   videoLink,
    dialInNumber:  dialIn?.number ?? null,
    calendarLink:  calLink,
    duration,
    interviewers,
    notes:         extractMeetingNotes(body),
  };
}

// ─────────────────────────────────────────────────────────────
// INDIVIDUAL EXTRACTORS
// ─────────────────────────────────────────────────────────────

function extractCompany(text: string, fromEmail: string): string | null {
  // Pattern 1: "at [Company]" construction
  const atPatterns = [
    /interview (?:at|with) ([A-Z][A-Za-z0-9\s&.,'-]{2,50}?)(?:\s+for|\s+on|\s+is|\.|,)/,
    /(?:team|company|organization) at ([A-Z][A-Za-z0-9\s&.,'-]{2,50})(?:\s|\.)/,
    /(?:role|position|opportunity) at ([A-Z][A-Za-z0-9\s&.,'-]{2,50})(?:\s|\.)/,
    /([A-Z][A-Za-z0-9\s&.,'-]{2,50}?) (?:team|hiring team|talent team|recruiting team)/,
    /on behalf of ([A-Z][A-Za-z0-9\s&.,'-]{2,50}?)(?:\s|\.)/,
  ];

  for (const p of atPatterns) {
    const m = text.match(p);
    if (m?.[1] && m[1].length < 60) return m[1].trim();
  }

  // Fallback: email domain
  const domain = fromEmail.split('@')[1];
  if (domain) {
    const domainParts = domain.split('.');
    const company = domainParts[domainParts.length - 2];
    if (company && !['gmail', 'yahoo', 'outlook', 'hotmail', 'icloud', 'protonmail'].includes(company)) {
      return company.charAt(0).toUpperCase() + company.slice(1);
    }
  }
  return null;
}

function extractJobTitle(text: string): string | null {
  const patterns = [
    /(?:position|role|opening|opportunity) (?:of |for |as |titled? )(?:the )?([A-Z][A-Za-z\s/-]{5,60}?)(?:\s+at|\s+role|\s+position|[,.])/,
    /applying for (?:the )?([A-Z][A-Za-z\s/-]{5,60}?)(?:\s+(?:position|role|opening)|[,.])/i,
    /interview for (?:the )?([A-Z][A-Za-z\s/-]{5,60}?)(?:\s+(?:position|role|opening)|[,.])/i,
    /(?:RE:|Subject:)[^\n]*?([A-Z][A-Za-z\s/-]{5,60}?)(?:\s+at\s+|\s+-\s+|\s+@\s+)/,
    /(?:the |a )?([A-Z][A-Za-z\s/-]{5,60}?) (?:candidate|candidacy|applicant)/,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1] && m[1].length < 80) return m[1].trim();
  }
  return null;
}

function extractRecruiterName(body: string): string | null {
  // Signatures: "Best,\nJane Smith" or "Kind regards,\nJane"
  const sigPatterns = [
    /(?:best|regards|sincerely|cheers|thanks|warm regards|kind regards),?\s*\n+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*\n+(?:Recruiter|Talent|HR|People)/m,
  ];
  for (const p of sigPatterns) {
    const m = body.match(p);
    if (m?.[1] && m[1].length < 40) return m[1].trim();
  }
  return null;
}

function extractRecruiterTitle(body: string): string | null {
  const m = body.match(/\n([A-Za-z\s]+(?:Recruiter|Talent|HR|People Partner|Hiring)[^\n]{0,40})\n/);
  return m?.[1]?.trim() ?? null;
}

function extractHiringManager(body: string): string | null {
  const patterns = [
    /(?:hiring manager|interviewer|you(?:'ll| will) (?:be )?(?:meeting|speaking|talking) with)\s+(?:is\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    /interview with ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?),? (?:our|the)\s+/i,
  ];
  for (const p of patterns) {
    const m = body.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function extractLocation(text: string): string | null {
  if (/\b(?:remote|virtual|online|from home)\b/i.test(text)) return 'Remote';
  const m = text.match(/(?:location|office|address)\s*:\s*([^,\n]{5,60})/i);
  return m?.[1]?.trim() ?? null;
}

function extractDocuments(body: string): string[] {
  const found: string[] = [];
  for (const { pattern, label } of DOC_PATTERNS) {
    if (pattern.test(body)) found.push(label);
  }
  return [...new Set(found)];
}

function extractDeadline(body: string): string | null {
  const m = body.match(
    /(?:please|kindly|if possible)?(?:\s+(?:submit|send|provide|complete|return|reply))?(?:[^.]{0,30})(?:by|before|no later than|deadline)\s+([^.]{5,50})/i
  );
  return m?.[1]?.trim() ?? null;
}

function extractLink(body: string, sources: Array<{ pattern: RegExp; name: string }>): string | null {
  for (const { pattern } of sources) {
    const m = body.match(pattern);
    if (m) return m[0];
  }
  return null;
}

function extractPlatformName(body: string): string | null {
  for (const { pattern, name } of VIDEO_PLATFORMS) {
    if (pattern.test(body)) return name;
  }
  for (const { pattern, name } of SCHEDULING_LINKS) {
    if (pattern.test(body)) return name;
  }
  // Text mentions
  const platforms = [
    [/\bzoom\b/i, 'Zoom'], [/google meet/i, 'Google Meet'],
    [/microsoft teams/i, 'Microsoft Teams'], [/webex/i, 'Cisco Webex'],
    [/phone call|phone screen|give you a call/i, 'Phone'],
  ] as const;
  for (const [p, name] of platforms) {
    if ((p as RegExp).test(body)) return name;
  }
  return null;
}

function extractDialIn(body: string): { number: string; passcode?: string } | null {
  const m = body.match(/(?:dial.?in|call in|phone).*?(\+?[\d\s().-]{10,20})(?:[^\n]*?(?:passcode|pin|id)[:\s]+(\d{4,12}))?/i);
  if (!m) return null;
  return { number: m[1]!.replace(/\s/g, ''), passcode: m[2] };
}

function extractDuration(body: string): number | null {
  const m = body.match(/(\d+)[\s-](?:minute|min|hour|hr)(?:s?)[\s-]?(?:call|interview|meeting|chat|session)?/i);
  if (!m) return null;
  const n = parseInt(m[1]!);
  const unit = m[0].toLowerCase();
  return /hour|hr/.test(unit) ? n * 60 : n;
}

function extractInterviewers(body: string): string[] {
  const names: string[] = [];
  const patterns = [
    /(?:be meeting|speaking|interviewing) with ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?(?:,\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)*)/g,
    /interviewers?:\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?(?:,\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)*)/gi,
  ];
  for (const p of patterns) {
    for (const m of body.matchAll(p)) {
      if (m[1]) {
        const split = m[1].split(',').map(s => s.trim()).filter(s => s.length < 40);
        names.push(...split);
      }
    }
  }
  return [...new Set(names)];
}

function extractMeetingNotes(body: string): string | null {
  const m = body.match(/(?:notes?|(?:additional|special) instructions?|please note|important|reminder)[:\s]([^\n]{10,200})/i);
  return m?.[1]?.trim() ?? null;
}

function detectInterviewFormat(body: string): InterviewFormat {
  for (const { patterns, format } of FORMAT_MAP) {
    if (patterns.some(p => p.test(body))) return format;
  }
  return 'unknown';
}

function extractAssessmentDeadline(body: string): string | null {
  const m = body.match(/(?:complete|submit|finish|due) (?:the (?:assessment|test|challenge))?[^.]{0,40}(?:within|by|before)\s+([^.]{5,50})/i);
  return m?.[1]?.trim() ?? null;
}

function extractSalary(body: string): string | null {
  const m = body.match(/(?:\$|USD|GBP|EUR|£|€)[\d,]+(?:\s*[-–]\s*(?:\$|USD|GBP|EUR|£|€)?[\d,]+)?(?:\s*(?:k|K|per year|annually|\/yr))?/);
  return m?.[0]?.trim() ?? null;
}

function extractStartDate(body: string): string | null {
  const m = body.match(/start(?:ing)? (?:date|on)[:\s]+([^.]{5,50})/i)
         ?? body.match(/(?:proposed|anticipated|expected) start[:\s]+([^.]{5,50})/i);
  return m?.[1]?.trim() ?? null;
}
