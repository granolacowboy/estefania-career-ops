#!/usr/bin/env node

/**
 * generate-drafts.mjs — Generate application drafts for high-scoring jobs
 *
 * Reads evaluation reports + candidate context, calls Gemini Flash to generate
 * cover letter, application Q&A, and LinkedIn outreach messages.
 * Writes to data/drafts/{jobNum}-drafts.md.
 *
 * Requires: GEMINI_API_KEY env var (free at https://aistudio.google.com/apikey)
 *
 * Usage:
 *   node generate-drafts.mjs --job 5        # single job by number
 *   node generate-drafts.mjs --pending      # all 4.0+ jobs without drafts
 *   node generate-drafts.mjs --dry-run      # preview without writing
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from 'fs';
import { join } from 'path';

// ── Config ─────────────────────────────────────────────────────────

const CV_PATH = 'cv.md';
const PROFILE_PATH = 'config/profile.yml';
const PROFILE_MD_PATH = 'modes/_profile.md';
const PREFERENCES_PATH = 'data/preferences.yml';
const APPLICATIONS_PATH = 'data/applications.md';
const REPORTS_DIR = 'reports';
const DRAFTS_DIR = 'data/drafts';

const MODEL = 'gemini-2.0-flash';
const MAX_TOKENS = 4096;
const FETCH_TIMEOUT_MS = 45_000;
const MIN_SCORE = 3.5;

// ── Args ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const pendingMode = args.includes('--pending');
const jobIdx = args.indexOf('--job');
const singleJob = jobIdx !== -1 ? args[jobIdx + 1] : null;

if (!singleJob && !pendingMode) {
  console.log('Usage:');
  console.log('  node generate-drafts.mjs --job 5     # single job');
  console.log('  node generate-drafts.mjs --pending   # all 4.0+ without drafts');
  console.log('  node generate-drafts.mjs --dry-run   # preview');
  process.exit(0);
}

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

async function callGemini(apiKey, systemPrompt, userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.4 },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── Load applications tracker ──────────────────────────────────────

function loadApplications() {
  if (!existsSync(APPLICATIONS_PATH)) return [];
  const raw = readFileSync(APPLICATIONS_PATH, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().startsWith('|'));
  const dataLines = lines.slice(2);

  return dataLines
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length < 8) return null;
      const [num, date, company, role, score, status, , report, ...rest] = cells;
      const scoreMatch = score.match(/([\d.]+)/);
      const scoreNum = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
      const reportMatch = report.match(/\(([^)]+)\)/);
      const reportPath = reportMatch ? reportMatch[1] : '';
      return { num, date, company, role, score, scoreNum, status, reportPath, notes: rest.join(' ').trim() };
    })
    .filter((j) => j !== null);
}

// ── Load report content ────────────────────────────────────────────

function loadReport(reportPath) {
  const fullPath = reportPath.startsWith('reports/') ? reportPath : join(REPORTS_DIR, reportPath);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, 'utf-8');
}

// ── Check if draft already exists ──────────────────────────────────

function draftExists(jobNum) {
  const padded = String(jobNum).padStart(3, '0');
  const path = join(DRAFTS_DIR, `${padded}-drafts.md`);
  return existsSync(path);
}

// ── Load learned preferences ───────────────────────────────────────

function loadPreferences() {
  if (!existsSync(PREFERENCES_PATH)) return null;
  const raw = readFileSync(PREFERENCES_PATH, 'utf-8');

  const parseList = (key) => {
    const match = raw.match(new RegExp(`${key}:\\s*\\n((?:\\s*-\\s*.+\\n)*)`, 'm'));
    if (!match) return [];
    return match[1]
      .split('\n')
      .map((l) => l.replace(/^\s*-\s*/, '').trim())
      .filter(Boolean);
  };

  return {
    tonePreferences: parseList('tone_preferences'),
    avoid: parseList('avoid'),
    languagePatterns: parseList('language_patterns'),
  };
}

// ── Detect language from job context ───────────────────────────────

function detectLanguage(job, reportContent) {
  const text = `${job.company} ${job.role} ${reportContent || ''}`.toLowerCase();
  const spanishSignals = ['.mx', 'occ', 'computrabajo', 'indeed.com.mx', 'los cabos', 'cdmx', 'méxico'];
  if (spanishSignals.some((s) => text.includes(s))) return 'es';
  return 'en';
}

// ── Build draft generation prompt ──────────────────────────────────

function buildSystemPrompt(cv, profile, profileMd, preferences, language) {
  const lang = language === 'es' ? 'Spanish' : 'English';

  let prefsSection = '';
  if (preferences) {
    const parts = [];
    if (preferences.tonePreferences.length > 0) {
      parts.push(`The candidate prefers:\n${preferences.tonePreferences.map((p) => `- ${p}`).join('\n')}`);
    }
    if (preferences.avoid.length > 0) {
      parts.push(`The candidate does NOT like:\n${preferences.avoid.map((p) => `- ${p}`).join('\n')}`);
    }
    if (preferences.languagePatterns.length > 0) {
      parts.push(`Language notes:\n${preferences.languagePatterns.map((p) => `- ${p}`).join('\n')}`);
    }
    if (parts.length > 0) {
      prefsSection = `\n## Learned Preferences\n${parts.join('\n\n')}`;
    }
  }

  return `You are an expert career coach drafting application materials for a candidate.
Write ALL output in ${lang}.

## Candidate CV
${cv}

## Candidate Profile
${profile}

## Candidate Archetypes & Narrative
${profileMd}
${prefsSection}

## Tone Rules — "I'm choosing you"

The candidate has options and is choosing this company for concrete reasons.

Rules:
- Confident without arrogance: "I've spent the past 10 years building brands — your role is where I want to apply that experience next"
- Selective without snobbery: "I've been intentional about finding a team where I can contribute meaningfully from day one"
- Specific and concrete: Always reference something REAL from the JD or company, and something REAL from the candidate's experience
- Direct, no fluff: 2-4 sentences per answer. No "I'm passionate about..." or "I would love the opportunity to..."
- The hook is the proof, not the claim: Instead of "I'm great at X", say "I built X that does Y"

## Your Task

Generate THREE sections of application materials:

### Section 1: Cover Letter
- 200-300 words
- Opening: specific hook connecting candidate to THIS role
- Middle: 2-3 proof points from CV that map to job requirements
- Closing: clear, confident close with a specific CTA
- DO NOT use generic openers like "Dear Hiring Manager" — use the company name

### Section 2: Application Q&A
Answer these 5 common application questions:
1. Why are you interested in this role?
2. Why do you want to work at [Company]?
3. Tell us about a relevant achievement
4. What makes you a good fit?
5. How did you hear about this role?

Each answer: 2-4 sentences, specific, proof-driven.

### Section 3: LinkedIn Outreach
Two message variants (MUST be under 300 characters each):

**Hiring Manager message:**
- Phrase 1: Specific challenge their team faces (from JD)
- Phrase 2: Candidate's biggest quantifiable achievement relevant to that challenge
- Phrase 3: Open-ended CTA about the challenge

**Recruiter message:**
- Phrase 1: Direct match criteria (role, experience, availability)
- Phrase 2: Screening-ready data point
- Phrase 3: "Happy to share my CV if this aligns"

## Output Format

Output ONLY the markdown content below, no preamble:

## Cover Letter

[cover letter text]

## Application Q&A

### Why are you interested in this role?
[answer]

### Why do you want to work at [Company]?
[answer]

### Tell us about a relevant achievement
[answer]

### What makes you a good fit?
[answer]

### How did you hear about this role?
[answer]

## LinkedIn Outreach

### Hiring Manager
[message under 300 chars]

### Recruiter
[message under 300 chars]`;
}

// ── Write draft file ───────────────────────────────────────────────

function writeDraft(jobNum, company, role, language, content) {
  mkdirSync(DRAFTS_DIR, { recursive: true });
  const padded = String(jobNum).padStart(3, '0');
  const filename = `${padded}-drafts.md`;
  const filepath = join(DRAFTS_DIR, filename);
  const now = new Date().toISOString();

  const frontmatter = `---
jobNum: "${padded}"
company: "${company.replace(/"/g, '\\"')}"
role: "${role.replace(/"/g, '\\"')}"
generatedAt: "${now}"
language: "${language}"
status: "draft"
---

`;

  writeFileSync(filepath, frontmatter + content, 'utf-8');
  return filename;
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  const apiKey = getApiKey();

  const cv = existsSync(CV_PATH) ? readFileSync(CV_PATH, 'utf-8') : '';
  const profile = existsSync(PROFILE_PATH) ? readFileSync(PROFILE_PATH, 'utf-8') : '';
  const profileMd = existsSync(PROFILE_MD_PATH) ? readFileSync(PROFILE_MD_PATH, 'utf-8') : '';
  const preferences = loadPreferences();

  if (!cv) {
    console.error('Error: cv.md not found. Cannot generate drafts without CV.');
    process.exit(1);
  }

  const applications = loadApplications();

  // Determine which jobs to process
  let jobs;
  if (singleJob) {
    const padded = String(singleJob).padStart(3, '0');
    jobs = applications.filter((j) => j.num === padded || j.num === singleJob);
    if (jobs.length === 0) {
      console.error(`Job #${singleJob} not found in applications tracker.`);
      process.exit(1);
    }
  } else {
    // --pending: all 4.0+ scored jobs without existing drafts
    jobs = applications.filter(
      (j) => j.scoreNum >= MIN_SCORE && !draftExists(j.num)
    );
  }

  if (jobs.length === 0) {
    console.log('No jobs to generate drafts for.');
    process.exit(0);
  }

  console.log(`\nGenerating drafts for ${jobs.length} job(s)...\n`);

  let generated = 0;
  let errors = 0;

  for (const job of jobs) {
    console.log(`[${job.num}] ${job.company} — ${job.role} (${job.score})`);

    try {
      const reportContent = loadReport(job.reportPath);
      if (!reportContent) {
        console.log(`  ⚠ No report found at ${job.reportPath}, skipping`);
        continue;
      }

      const language = detectLanguage(job, reportContent);
      const systemPrompt = buildSystemPrompt(cv, profile, profileMd, preferences, language);

      const userMessage = `Generate application materials for this job:

**Company:** ${job.company}
**Role:** ${job.role}
**Score:** ${job.score}

## Evaluation Report
${reportContent}`;

      if (dryRun) {
        console.log(`  → [dry-run] Would generate ${language.toUpperCase()} drafts for job #${job.num}`);
        continue;
      }

      const content = await callGemini(apiKey, systemPrompt, userMessage);
      const filename = writeDraft(job.num, job.company, job.role, language, content);
      console.log(`  → ${filename} (${language.toUpperCase()})`);
      generated++;

      // Rate limit: 1s delay between requests
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.error(`  ✗ Error: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Draft generation complete`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Generated: ${generated}`);
  console.log(`Errors:    ${errors}`);
  if (!dryRun && generated > 0) {
    console.log(`\nDrafts written to ${DRAFTS_DIR}/`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
