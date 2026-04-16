#!/usr/bin/env node

/**
 * evaluate-pipeline.mjs — Auto-evaluate pending pipeline entries
 *
 * Reads data/pipeline.md for unchecked entries, fetches job descriptions,
 * calls Claude API to evaluate against cv.md + profile, writes reports
 * and tracker entries.
 *
 * Requires: ANTHROPIC_API_KEY env var
 *
 * Usage:
 *   node evaluate-pipeline.mjs              # evaluate all pending
 *   node evaluate-pipeline.mjs --limit 5    # evaluate max 5
 *   node evaluate-pipeline.mjs --dry-run    # preview without writing
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from 'fs';

// ── Config ─────────────────────────────────────────────────────────

const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const REPORTS_DIR = 'reports';
const CV_PATH = 'cv.md';
const PROFILE_PATH = 'config/profile.yml';
const PROFILE_MD_PATH = 'modes/_profile.md';

const MODEL = 'gemini-2.0-flash';
const MAX_TOKENS = 4096;
const FETCH_TIMEOUT_MS = 30_000;

// ── Args ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 10;

// ── Helpers ────────────────────────────────────────────────────────

function getApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error('Error: GEMINI_API_KEY environment variable is required');
    console.error('Get a free key at: https://aistudio.google.com/apikey');
    process.exit(1);
  }
  return key;
}

function getNextReportNumber() {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const files = readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.md'));
  let max = 0;
  for (const f of files) {
    const match = f.match(/^(\d+)-/);
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return max + 1;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── Fetch job description from URL ─────────────────────────────────

async function fetchJobDescription(url) {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const html = await res.text();

    // Extract text content from HTML (simple approach)
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000); // Limit to avoid huge context

    return text;
  } catch {
    return null;
  }
}

// ── Call Gemini API (free tier: 15 RPM, 1M tokens/day) ────────────

async function callGemini(apiKey, systemPrompt, userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.3 },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── Parse pipeline.md ──────────────────────────────────────────────

function loadPendingEntries() {
  if (!existsSync(PIPELINE_PATH)) return [];
  const text = readFileSync(PIPELINE_PATH, 'utf-8');
  const entries = [];

  for (const match of text.matchAll(
    /- \[ \] (https?:\/\/\S+)\s*\|\s*([^|]+)\s*\|\s*([^\n]+)/g
  )) {
    entries.push({
      url: match[1].trim(),
      company: match[2].trim(),
      title: match[3].trim(),
    });
  }

  return entries;
}

function markPipelineEntryDone(url) {
  if (!existsSync(PIPELINE_PATH)) return;
  let text = readFileSync(PIPELINE_PATH, 'utf-8');
  text = text.replace(`- [ ] ${url}`, `- [x] ${url}`);
  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

// ── Build evaluation prompt ────────────────────────────────────────

function buildSystemPrompt(cv, profile, profileMd) {
  return `You are an expert career coach evaluating job opportunities for a candidate.

## Candidate CV
${cv}

## Candidate Profile
${profile}

## Candidate Archetypes & Narrative
${profileMd}

## Your Task
Evaluate the job posting against this candidate's profile. Produce a structured evaluation report in markdown with these blocks:

# Evaluation — {Company}: {Role Title}

**Score:** X.X/5
**URL:** {job_url}

## Block A — Role Summary
2-3 sentence summary of what the role involves.

## Block B — CV Match
**Match: X.X/5**
- Bullet points of alignment
**Gaps:**
- Bullet points of gaps

## Block C — Level Strategy
Is this role at the right level? Over/under? Brief assessment.

## Block D — Compensation Research
Estimated comp range in MXN for this role/market. How it aligns with candidate targets.

## Block E — Personalization
How should the candidate position themselves for this specific role? What to emphasize.

## Block F — Interview Prep (STAR+R)
One relevant STAR+R story from the candidate's experience.

## Score Guidelines
- 4.5+ → Strong match, recommend applying immediately
- 4.0-4.4 → Good match, worth applying
- 3.5-3.9 → Decent but not ideal
- Below 3.5 → Recommend against applying

Be honest and calibrated. A 4.0+ should mean genuine fit, not flattery.
Output ONLY the markdown report, no preamble.`;
}

// ── Write report and tracker entry ─────────────────────────────────

function writeReport(num, company, role, date, content) {
  const slug = slugify(company);
  const filename = `${String(num).padStart(3, '0')}-${slug}-${date}.md`;
  const filepath = `${REPORTS_DIR}/${filename}`;
  writeFileSync(filepath, content, 'utf-8');
  return filename;
}

function appendToTracker(num, date, company, role, score, reportFilename, notes) {
  if (!existsSync(APPLICATIONS_PATH)) {
    writeFileSync(
      APPLICATIONS_PATH,
      `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n`,
      'utf-8'
    );
  }

  const paddedNum = String(num).padStart(3, '0');
  const row = `| ${paddedNum} | ${date} | ${company} | ${role} | ${score} | Evaluated | ❌ | [${paddedNum}](reports/${reportFilename}) | ${notes} |`;

  let text = readFileSync(APPLICATIONS_PATH, 'utf-8');
  // Append to end of table
  if (text.endsWith('\n')) {
    text += row + '\n';
  } else {
    text += '\n' + row + '\n';
  }
  writeFileSync(APPLICATIONS_PATH, text, 'utf-8');
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  const apiKey = getApiKey();

  // Load candidate context
  const cv = existsSync(CV_PATH) ? readFileSync(CV_PATH, 'utf-8') : '';
  const profile = existsSync(PROFILE_PATH)
    ? readFileSync(PROFILE_PATH, 'utf-8')
    : '';
  const profileMd = existsSync(PROFILE_MD_PATH)
    ? readFileSync(PROFILE_MD_PATH, 'utf-8')
    : '';

  if (!cv) {
    console.error('Error: cv.md not found. Cannot evaluate without CV.');
    process.exit(1);
  }

  const systemPrompt = buildSystemPrompt(cv, profile, profileMd);

  // Load pending pipeline entries
  const pending = loadPendingEntries();
  const toProcess = pending.slice(0, limit);

  if (toProcess.length === 0) {
    console.log('No pending pipeline entries to evaluate.');
    process.exit(0);
  }

  console.log(`\nEvaluating ${toProcess.length} pending entries...\n`);

  const date = new Date().toISOString().slice(0, 10);
  let nextNum = getNextReportNumber();
  let evaluated = 0;
  let errors = 0;

  for (const entry of toProcess) {
    const num = nextNum++;
    console.log(
      `[${num}] ${entry.company} — ${entry.title}`
    );

    try {
      // Fetch the job description
      const jd = await fetchJobDescription(entry.url);
      const jdContext = jd
        ? `Job Description (extracted from ${entry.url}):\n${jd}`
        : `Could not fetch full JD. Evaluate based on title only.\nURL: ${entry.url}`;

      const userMessage = `Evaluate this job opportunity:\n\n**Company:** ${entry.company}\n**Role:** ${entry.title}\n**URL:** ${entry.url}\n\n${jdContext}`;

      if (dryRun) {
        console.log(`  → [dry-run] Would evaluate and write report #${num}`);
        continue;
      }

      // Call Gemini (free tier)
      const report = await callGemini(apiKey, systemPrompt, userMessage);

      // Extract score from report
      const scoreMatch = report.match(/\*\*Score:\*\*\s*([\d.]+\/5)/);
      const score = scoreMatch ? scoreMatch[1] : '?/5';

      // Extract a one-line note from Block A
      const blockAMatch = report.match(
        /## Block A[^\n]*\n+([\s\S]*?)(?=\n## Block|$)/
      );
      const note = blockAMatch
        ? blockAMatch[1].trim().split('\n')[0].slice(0, 80)
        : '';

      // Write report
      const reportFilename = writeReport(num, entry.company, entry.title, date, report);
      console.log(`  → Score: ${score} → ${reportFilename}`);

      // Append to tracker
      appendToTracker(
        num,
        date,
        entry.company,
        entry.title,
        score,
        reportFilename,
        note
      );

      // Mark pipeline entry as done
      markPipelineEntryDone(entry.url);

      evaluated++;

      // Small delay to avoid rate limits
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.error(`  ✗ Error: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Evaluation complete — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Evaluated:  ${evaluated}`);
  console.log(`Errors:     ${errors}`);
  console.log(`Remaining:  ${pending.length - toProcess.length}`);
  if (!dryRun && evaluated > 0) {
    console.log(`\nReports written to ${REPORTS_DIR}/`);
    console.log(`Tracker updated in ${APPLICATIONS_PATH}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
