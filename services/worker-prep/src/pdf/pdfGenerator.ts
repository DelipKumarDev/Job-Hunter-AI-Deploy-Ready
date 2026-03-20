// ============================================================
// PDF Generator
// Produces two PDFs per prep package:
//
//  1. Interview Prep Guide
//     • Cover page (role + company + date)
//     • Company overview
//     • Questions by category (with answer guidance)
//     • Technical prep topics with subtopics
//     • Pre-interview checklist
//
//  2. Tailored Resume
//     • Professional layout matching original style
//     • Summary, experience (with tailored bullets), skills
//     • ATS score and keyword injection notes (footer)
//
// Uses pdfkit (pure JS, no Chromium dependency).
// Outputs Buffer → uploaded to S3 by processor.
// ============================================================

import type { PrepPackage } from '../types/prepTypes.js';
import { logger } from '../utils/logger.js';

// PDFKit is optional — graceful fallback if not installed
type PDFDoc = {
  on: (event: string, cb: (chunk?: Buffer) => void) => void;
  end: () => void;
  fontSize: (n: number) => PDFDoc;
  font: (f: string) => PDFDoc;
  fillColor: (c: string) => PDFDoc;
  text: (t: string, opts?: object) => PDFDoc;
  moveDown: (n?: number) => PDFDoc;
  addPage: () => PDFDoc;
  rect: (x: number, y: number, w: number, h: number) => PDFDoc;
  fill: () => PDFDoc;
  y: number;
  page: { margins: { top: number; left: number; right: number; bottom: number }; width: number };
};

// ─────────────────────────────────────────────────────────────
// GENERATE PREP GUIDE PDF
// ─────────────────────────────────────────────────────────────
export async function generatePrepPdf(pkg: PrepPackage): Promise<Buffer> {
  try {
    // Dynamic import so build doesn't fail if pdfkit not installed
    const PDFDocument = (await import('pdfkit')).default as new (opts: object) => PDFDoc;

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    return new Promise((resolve, reject) => {
      doc.on('end',   () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ── Cover Page ────────────────────────────────────────
      addCoverPage(doc, pkg);

      // ── Company Overview ──────────────────────────────────
      doc.addPage();
      addSection(doc, '🏢 Company Overview', pkg.companyAnalysis.productSummary);
      if (pkg.companyAnalysis.culture.length > 0) {
        addBulletList(doc, 'Culture Signals', pkg.companyAnalysis.culture);
      }
      if (pkg.companyAnalysis.interviewStyle) {
        addSection(doc, 'Interview Style', pkg.companyAnalysis.interviewStyle);
      }
      if (pkg.companyAnalysis.recentNews.length > 0) {
        addBulletList(doc, 'Recent News', pkg.companyAnalysis.recentNews);
      }

      // ── Questions by Category ─────────────────────────────
      const categories = [
        'behavioral', 'technical', 'system_design',
        'culture_fit', 'role_specific', 'situational',
      ] as const;

      for (const cat of categories) {
        const catQuestions = pkg.questions.filter(q => q.category === cat);
        if (catQuestions.length === 0) continue;

        doc.addPage();
        const label = cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        addCategoryHeader(doc, `${getCategoryEmoji(cat)} ${label} Questions`);

        for (const question of catQuestions.slice(0, 6)) {
          const answer = pkg.answers.find(a => a.questionId === question.id);
          addQuestionBlock(doc, question, answer);
          if (doc.y > 700) doc.addPage();
        }
      }

      // ── Questions TO ASK ──────────────────────────────────
      const closingQs = pkg.questions.filter(q => q.category === 'closing');
      if (closingQs.length > 0) {
        doc.addPage();
        addCategoryHeader(doc, '🙋 Questions to Ask the Interviewer');
        for (const q of closingQs) {
          addSmartQuestion(doc, q);
        }
      }

      // ── Technical Prep Topics ─────────────────────────────
      doc.addPage();
      addCategoryHeader(doc, '📚 Technical Preparation Plan');

      const totalHours = pkg.topics.reduce((sum, t) => sum + t.estimatedHours, 0);
      doc.fontSize(10).fillColor('#7a8899')
        .text(`Estimated total prep time: ${totalHours} hours`, { align: 'left' })
        .moveDown(0.5);

      for (const topic of pkg.topics) {
        if (doc.y > 680) doc.addPage();
        addTopicBlock(doc, topic);
      }

      // ── Pre-Interview Checklist ───────────────────────────
      doc.addPage();
      addChecklistPage(doc, pkg);

      doc.end();
    });

  } catch (err) {
    logger.warn('PDFKit not available — returning placeholder buffer', { error: String(err) });
    return Buffer.from(buildTextFallback(pkg));
  }
}

// ─────────────────────────────────────────────────────────────
// GENERATE TAILORED RESUME PDF
// ─────────────────────────────────────────────────────────────
export async function generateTailoredResumePdf(pkg: PrepPackage): Promise<Buffer | null> {
  if (!pkg.tailoredResume) return null;

  try {
    const PDFDocument = (await import('pdfkit')).default as new (opts: object) => PDFDoc;
    const doc    = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));

    return new Promise((resolve, reject) => {
      doc.on('end',   () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const tr = pkg.tailoredResume!;

      // ── Header ────────────────────────────────────────────
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#0f172a')
        .text(pkg.userId, { align: 'center' })
        .moveDown(0.2);

      // Targeted role line
      doc.fontSize(12).font('Helvetica').fillColor('#38bdf8')
        .text(`${tr.targetJobTitle} — ${tr.targetCompany}`, { align: 'center' })
        .moveDown(0.5);

      addHRule(doc);

      // ── Summary ───────────────────────────────────────────
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#0f172a').text('PROFESSIONAL SUMMARY').moveDown(0.3);
      doc.fontSize(10).font('Helvetica').fillColor('#334155').text(tr.tailoredSummary).moveDown(1);

      addHRule(doc);

      // ── Experience ────────────────────────────────────────
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#0f172a').text('EXPERIENCE').moveDown(0.3);

      for (const exp of tr.tailoredExperience) {
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e293b')
          .text(`${exp.title}`, { continued: true })
          .font('Helvetica').fillColor('#64748b')
          .text(`  •  ${exp.company}  •  ${exp.startDate} – ${exp.endDate ?? 'Present'}`)
          .moveDown(0.2);

        for (const bullet of exp.bullets) {
          doc.fontSize(10).font('Helvetica').fillColor('#334155')
            .text(`• ${bullet}`, { indent: 15 });
        }
        doc.moveDown(0.6);
      }

      // ── Skills ────────────────────────────────────────────
      addHRule(doc);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#0f172a').text('SKILLS').moveDown(0.3);

      for (const group of tr.tailoredSkills) {
        doc.fontSize(10)
          .font('Helvetica-Bold').fillColor('#334155').text(`${group.category}: `, { continued: true })
          .font('Helvetica').text(group.skills.join(' • '));
      }

      // ── ATS Footer ────────────────────────────────────────
      doc.moveDown(2);
      doc.fontSize(8).fillColor('#94a3b8')
        .text(`ATS Match Score: ${tr.atsScore}%  •  Tailored for ${tr.targetJobTitle} at ${tr.targetCompany}  •  Generated by Job Hunter AI`, { align: 'center' });

      doc.end();
    });
  } catch (err) {
    logger.warn('Tailored resume PDF generation failed', { error: String(err) });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// PDF HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────
function addCoverPage(doc: PDFDoc, pkg: PrepPackage): void {
  doc.moveDown(4);
  doc.fontSize(28).font('Helvetica-Bold').fillColor('#0f172a')
    .text('Interview Preparation Guide', { align: 'center' }).moveDown(0.5);

  doc.fontSize(18).font('Helvetica').fillColor('#38bdf8')
    .text(pkg.companyAnalysis.name, { align: 'center' }).moveDown(0.3);

  doc.fontSize(14).fillColor('#64748b')
    .text(`Role: ${pkg.questions[0]?.rationale.split('role')[0] ?? 'See package details'}`, { align: 'center' })
    .moveDown(0.5);

  doc.fontSize(11).fillColor('#94a3b8')
    .text(`Generated: ${pkg.generatedAt.toLocaleDateString('en-US', { dateStyle: 'long' })}`, { align: 'center' })
    .moveDown(0.3)
    .text(`${pkg.totalQuestions} questions  •  ${pkg.topics.length} prep topics`, { align: 'center' });
}

function addSection(doc: PDFDoc, title: string, body: string): void {
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1e293b').text(title).moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor('#334155').text(body).moveDown(1);
}

function addBulletList(doc: PDFDoc, title: string, items: string[]): void {
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e293b').text(title).moveDown(0.2);
  for (const item of items) {
    doc.fontSize(10).font('Helvetica').fillColor('#334155').text(`• ${item}`, { indent: 12 });
  }
  doc.moveDown(0.8);
}

function addCategoryHeader(doc: PDFDoc, title: string): void {
  doc.fontSize(16).font('Helvetica-Bold').fillColor('#0f172a').text(title).moveDown(0.5);
  addHRule(doc);
}

function addQuestionBlock(doc: PDFDoc, q: import('../types/prepTypes.js').InterviewQuestion, a?: import('../types/prepTypes.js').SuggestedAnswer): void {
  const diffColor = q.difficulty === 'hard' ? '#ef4444' : q.difficulty === 'medium' ? '#f59e0b' : '#22c55e';

  doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e293b').text(q.question).moveDown(0.2);

  doc.fontSize(9).font('Helvetica').fillColor(diffColor)
    .text(`${q.difficulty.toUpperCase()} • ${q.frequency}  `, { continued: true })
    .fillColor('#94a3b8').text(`~${Math.round(q.timeLimit / 60)} min  •  ${q.rationale}`)
    .moveDown(0.3);

  if (a) {
    doc.fontSize(9).font('Helvetica-Oblique').fillColor('#475569')
      .text(`Format: ${a.format}`, { continued: true })
      .font('Helvetica').text(`  |  ${a.customisedFor}`)
      .moveDown(0.2);

    doc.fontSize(10).font('Helvetica').fillColor('#334155').text(a.answer.slice(0, 400) + (a.answer.length > 400 ? '…' : '')).moveDown(0.3);

    if (a.keyPoints.length > 0) {
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#15803d').text('Key points: ', { continued: true })
        .font('Helvetica').text(a.keyPoints.slice(0, 3).join('  •  '));
    }
  }

  if (q.followUps.length > 0) {
    doc.fontSize(9).fillColor('#94a3b8').text(`Follow-ups: ${q.followUps.join('  /  ')}`);
  }

  doc.moveDown(1.2);
}

function addSmartQuestion(doc: PDFDoc, q: import('../types/prepTypes.js').InterviewQuestion): void {
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e293b').text(`"${q.question}"`).moveDown(0.2);
  doc.fontSize(10).font('Helvetica').fillColor('#64748b').text(q.rationale).moveDown(0.8);
}

function addTopicBlock(doc: PDFDoc, topic: import('../types/prepTypes.js').PrepTopic): void {
  const prioColor = {
    critical:     '#ef4444',
    high:         '#f59e0b',
    medium:       '#3b82f6',
    nice_to_have: '#94a3b8',
  }[topic.priority];

  doc.fontSize(12).font('Helvetica-Bold').fillColor(prioColor)
    .text(`${topic.area}  `, { continued: true })
    .fontSize(9).font('Helvetica').fillColor('#94a3b8')
    .text(`${topic.priority.toUpperCase().replace('_', ' ')} • ~${topic.estimatedHours}h`)
    .moveDown(0.2);

  doc.fontSize(10).font('Helvetica').fillColor('#334155').text(topic.description).moveDown(0.2);

  if (topic.subtopics.length > 0) {
    for (const sub of topic.subtopics.slice(0, 5)) {
      doc.fontSize(9).fillColor('#475569').text(`• ${sub}`, { indent: 12 });
    }
  }

  if (topic.resources.length > 0) {
    doc.fontSize(9).fillColor('#6366f1')
      .text(`Resources: ${topic.resources.map(r => r.title).join('  •  ')}`, { indent: 12 });
  }

  doc.moveDown(0.8);
}

function addChecklistPage(doc: PDFDoc, pkg: PrepPackage): void {
  addCategoryHeader(doc, '✅ Pre-Interview Checklist');

  const items = [
    { label: 'Research', checks: [
      `Research ${pkg.companyAnalysis.name}'s product — can you demo it?`,
      'Read their latest blog posts or press releases',
      `Know their competitors: ${pkg.companyAnalysis.competitors.slice(0, 2).join(', ')}`,
    ]},
    { label: 'Technical Prep', checks: [
      ...pkg.topics.filter(t => t.priority === 'critical').slice(0, 3).map(t => `Practice ${t.area} — ${t.estimatedHours}h`),
      'Do 5 LeetCode medium problems in your primary language',
    ]},
    { label: 'Behavioural Prep', checks: [
      'Prepare 5 STAR stories covering leadership, failure, conflict, impact, learning',
      'Know your "Why this company?" answer cold',
      'Prepare your 5 closing questions',
    ]},
    { label: 'Logistics', checks: [
      'Test your video/audio setup 30 min before',
      'Have water, resume, and notes visible but off-camera',
      'Block 30 min post-interview to write thank-you emails',
    ]},
  ];

  for (const group of items) {
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e293b').text(group.label).moveDown(0.2);
    for (const check of group.checks) {
      doc.fontSize(10).font('Helvetica').fillColor('#334155').text(`☐  ${check}`, { indent: 10 });
    }
    doc.moveDown(0.6);
  }
}

function addHRule(doc: PDFDoc): void {
  doc.moveDown(0.3)
    .rect(doc.page.margins.left, doc.y, doc.page.width - doc.page.margins.left - doc.page.margins.right, 1)
    .fill()
    .moveDown(0.5);
  doc.fillColor('#e2e8f0');
}

function getCategoryEmoji(cat: string): string {
  const map: Record<string, string> = {
    behavioral: '🧠', technical: '⚙️', system_design: '🏗️',
    culture_fit: '🌱', role_specific: '🎯', situational: '💭',
  };
  return map[cat] ?? '❓';
}

function buildTextFallback(pkg: PrepPackage): string {
  const lines = [
    `INTERVIEW PREP GUIDE — ${pkg.companyAnalysis.name}`,
    `Generated: ${pkg.generatedAt.toISOString()}`,
    `Total questions: ${pkg.totalQuestions}`,
    '',
    'QUESTIONS:',
    ...pkg.questions.map(q => `[${q.category.toUpperCase()}] ${q.question}`),
    '',
    'PREP TOPICS:',
    ...pkg.topics.map(t => `[${t.priority.toUpperCase()}] ${t.area} — ${t.estimatedHours}h`),
  ];
  return lines.join('\n');
}
