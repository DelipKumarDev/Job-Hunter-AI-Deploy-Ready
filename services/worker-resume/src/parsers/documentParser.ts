// ============================================================
// Document Parsers — PDF + DOCX
// Extracts raw text from uploaded resume files.
// PDF: pdf-parse (handles encrypted, multi-column, tables)
// DOCX: mammoth (preserves semantic structure)
// Both include section detection using header heuristics.
// ============================================================

import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { RawResumeText, ResumeSection, SectionType } from '../types/resumeTypes.js';
import { logger } from '../utils/logger.js';

// ── S3 client ────────────────────────────────────────────────
let s3: S3Client | null = null;
function getS3(): S3Client {
  if (!s3) s3 = new S3Client({
    region: process.env['AWS_REGION'] ?? 'us-east-1',
    credentials: process.env['AWS_ACCESS_KEY_ID']
      ? { accessKeyId: process.env['AWS_ACCESS_KEY_ID']!, secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY']! }
      : undefined,
  });
  return s3;
}

// ── Download file from S3 into memory buffer ─────────────────
async function downloadToBuffer(s3Url: string): Promise<Buffer> {
  let bucket: string;
  let key: string;

  if (s3Url.startsWith('s3://')) {
    const parts = s3Url.replace('s3://', '').split('/');
    bucket = parts[0]!;
    key = parts.slice(1).join('/');
  } else {
    const url = new URL(s3Url);
    bucket = url.hostname.split('.')[0]!;
    key = url.pathname.slice(1);
  }

  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await getS3().send(cmd);
  const chunks: Buffer[] = [];

  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

// ─────────────────────────────────────────────────────────────
// PDF PARSER
// ─────────────────────────────────────────────────────────────
export async function parsePdf(s3Url: string): Promise<RawResumeText> {
  logger.debug('Parsing PDF resume', { s3Url });
  const buffer = await downloadToBuffer(s3Url);

  const data = await pdfParse(buffer, {
    // Custom page renderer to preserve layout
    pagerender: (pageData) => {
      return pageData.getTextContent().then((textContent: { items: Array<{ str: string; transform: number[] }> }) => {
        let lastY: number | null = null;
        const lines: string[] = [];
        let line = '';

        for (const item of textContent.items) {
          const y = item.transform[5];
          if (lastY !== null && Math.abs(y - lastY) > 2) {
            if (line.trim()) lines.push(line.trim());
            line = '';
          }
          line += item.str + ' ';
          lastY = y;
        }
        if (line.trim()) lines.push(line.trim());

        return lines.join('\n');
      });
    },
  });

  const rawText = cleanExtractedText(data.text);
  const sections = detectSections(rawText);

  return {
    full: rawText,
    sections,
    metadata: {
      pageCount: data.numpages,
      wordCount: rawText.split(/\s+/).filter(Boolean).length,
      charCount: rawText.length,
      hasStructure: sections.filter(s => s.type !== 'unknown').length >= 2,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// DOCX PARSER
// ─────────────────────────────────────────────────────────────
export async function parseDocx(s3Url: string): Promise<RawResumeText> {
  logger.debug('Parsing DOCX resume', { s3Url });
  const buffer = await downloadToBuffer(s3Url);

  // Extract with mammoth — preserves headings as section markers
  const result = await mammoth.extractRawText({ buffer });

  if (result.messages.length > 0) {
    logger.debug('DOCX parse warnings', { messages: result.messages.map(m => m.message) });
  }

  // Also extract with HTML mode to get heading structure
  const htmlResult = await mammoth.convertToHtml({ buffer });
  const htmlText = htmlResult.value;

  // Enhance plain text with heading markers extracted from HTML
  const enhancedText = enhanceDocxText(result.value, htmlText);
  const rawText = cleanExtractedText(enhancedText);
  const sections = detectSections(rawText);

  return {
    full: rawText,
    sections,
    metadata: {
      pageCount: Math.ceil(rawText.split('\n').length / 45), // Estimate
      wordCount: rawText.split(/\s+/).filter(Boolean).length,
      charCount: rawText.length,
      hasStructure: sections.filter(s => s.type !== 'unknown').length >= 2,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// SECTION DETECTOR
// Uses heading heuristics to split resume into named sections
// ─────────────────────────────────────────────────────────────

// Ordered patterns: more specific first
const SECTION_PATTERNS: Array<{ type: SectionType; patterns: RegExp[] }> = [
  {
    type: 'contact',
    patterns: [/^contact(\s+info(rmation)?)?$/i, /^personal\s+info/i],
  },
  {
    type: 'summary',
    patterns: [
      /^(professional\s+)?summary$/i,
      /^(career\s+)?objective$/i,
      /^profile$/i,
      /^about\s+(me)?$/i,
      /^overview$/i,
    ],
  },
  {
    type: 'experience',
    patterns: [
      /^(work\s+|professional\s+)?experience$/i,
      /^employment(\s+history)?$/i,
      /^work\s+history$/i,
      /^career\s+history$/i,
      /^positions?\s+held$/i,
    ],
  },
  {
    type: 'education',
    patterns: [
      /^education(\s+&\s+training)?$/i,
      /^academic(\s+background)?$/i,
      /^qualifications?$/i,
    ],
  },
  {
    type: 'skills',
    patterns: [
      /^(technical\s+|core\s+|key\s+)?skills?$/i,
      /^competenc(y|ies)$/i,
      /^expertise$/i,
      /^technologies$/i,
      /^technical\s+expertise$/i,
    ],
  },
  {
    type: 'certifications',
    patterns: [
      /^certifications?$/i,
      /^licenses?\s*(&|and)\s*certifications?$/i,
      /^credentials?$/i,
      /^professional\s+certifications?$/i,
    ],
  },
  {
    type: 'projects',
    patterns: [
      /^(personal\s+|side\s+)?projects?$/i,
      /^open.?source$/i,
      /^portfolio$/i,
    ],
  },
  {
    type: 'languages',
    patterns: [/^languages?$/i, /^spoken\s+languages?$/i],
  },
  {
    type: 'awards',
    patterns: [/^awards?$/i, /^honors?\s*(&|and)\s*awards?$/i, /^achievements?$/i],
  },
  {
    type: 'publications',
    patterns: [/^publications?$/i, /^research$/i, /^papers?$/i],
  },
  {
    type: 'volunteer',
    patterns: [/^volunteer(ing)?$/i, /^community\s+(service|involvement)$/i],
  },
];

function detectSections(text: string): ResumeSection[] {
  const lines = text.split('\n');
  const sections: ResumeSection[] = [];
  let currentSection: { title: string; type: SectionType; lines: string[] } | null = null;

  // Heuristics for a section header line:
  // - Relatively short (< 60 chars)
  // - ALL CAPS or Title Case
  // - Followed by non-empty content
  // - Matches known patterns OR is short + bold-like

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    const isHeaderCandidate =
      line.length < 60 &&
      (
        line === line.toUpperCase() ||           // ALL CAPS
        /^[A-Z][a-zA-Z\s&\/()-]+$/.test(line) || // Title Case
        line.startsWith('## ') ||                 // Markdown heading
        line.startsWith('# ')
      );

    if (isHeaderCandidate) {
      const cleanLine = line.replace(/^#+\s*/, '').trim();
      const sectionType = classifySectionHeader(cleanLine);

      // Check next lines have content (not another header immediately)
      const nextContent = lines.slice(i + 1, i + 4).filter(l => l.trim()).join(' ');

      if (nextContent.length > 20 || sectionType !== 'unknown') {
        // Save previous section
        if (currentSection && currentSection.lines.length > 0) {
          sections.push({
            title: currentSection.title,
            content: currentSection.lines.join('\n').trim(),
            type: currentSection.type,
          });
        }

        currentSection = { title: cleanLine, type: sectionType, lines: [] };
        continue;
      }
    }

    if (currentSection) {
      currentSection.lines.push(line);
    } else {
      // Content before first detected header — treat as contact/summary
      if (!currentSection && line.length > 0) {
        currentSection = { title: 'Header', type: 'contact', lines: [line] };
      }
    }
  }

  // Push last section
  if (currentSection && currentSection.lines.length > 0) {
    sections.push({
      title: currentSection.title,
      content: currentSection.lines.join('\n').trim(),
      type: currentSection.type,
    });
  }

  // If no sections detected, return entire text as one unknown section
  if (sections.length === 0) {
    sections.push({ title: 'Resume', content: text, type: 'unknown' });
  }

  return sections;
}

function classifySectionHeader(header: string): SectionType {
  for (const { type, patterns } of SECTION_PATTERNS) {
    if (patterns.some(p => p.test(header))) return type;
  }
  return 'unknown';
}

// ── Text cleanup ──────────────────────────────────────────────
function cleanExtractedText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[ ]{3,}/g, '  ')           // Collapse 3+ spaces → 2
    .replace(/\n{4,}/g, '\n\n\n')        // Max 3 consecutive newlines
    .replace(/[^\x20-\x7E\n\u00C0-\u024F\u0400-\u04FF]/g, ' ') // Remove non-printable
    .trim();
}

// ── DOCX HTML → structured text ──────────────────────────────
function enhanceDocxText(plainText: string, html: string): string {
  // Extract headings from HTML to use as section markers
  const headingRegex = /<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi;
  const headings = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(html)) !== null) {
    const headingText = match[1]!.replace(/<[^>]+>/g, '').trim();
    if (headingText) headings.add(headingText.toUpperCase());
  }

  // Annotate headings in plain text
  const lines = plainText.split('\n');
  return lines.map(line => {
    if (headings.has(line.trim().toUpperCase())) {
      return `\n${line.trim().toUpperCase()}\n`;
    }
    return line;
  }).join('\n');
}

// ── Dispatcher ────────────────────────────────────────────────
export async function parseResume(
  s3Url: string,
  fileType: 'pdf' | 'docx',
): Promise<RawResumeText> {
  if (fileType === 'pdf') return parsePdf(s3Url);
  if (fileType === 'docx') return parseDocx(s3Url);
  throw new Error(`Unsupported file type: ${fileType}`);
}
