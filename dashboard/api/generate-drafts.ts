/**
 * Vercel serverless function — generates application drafts via Gemini Flash.
 *
 * Reads the evaluation report + candidate files from GitHub,
 * calls Gemini to generate cover letter / Q&A / LinkedIn messages,
 * writes the result to data/drafts/{jobNum}-drafts.md.
 *
 * Env vars:
 *   GH_TOKEN       — GitHub PAT with "contents:write" scope
 *   GH_REPO        — "owner/repo" format
 *   GEMINI_API_KEY  — Free key from https://aistudio.google.com/apikey
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_MAX_TOKENS = 4096;
const FETCH_TIMEOUT_MS = 45_000;

// Simple rate limiting: track last generation time in memory
let lastGenerationTime = 0;
const RATE_LIMIT_MS = 60_000;

// ── GitHub helpers ──────────────────────────────────────────────────

async function ghGet(
  repo: string,
  token: string,
  filePath: string
): Promise<{ content: string; sha: string; status?: number; error?: string } | null> {
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) {
    let bodyHint = '';
    try {
      const errJson = (await res.json()) as { message?: string };
      bodyHint = errJson?.message ? ` — ${errJson.message}` : '';
    } catch {
      // ignore body parse failure
    }
    return { content: '', sha: '', status: res.status, error: `HTTP ${res.status}${bodyHint}` };
  }
  const data = await res.json();
  return {
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
    sha: data.sha,
  };
}

async function ghPut(repo: string, token: string, filePath: string, content: string, message: string, sha?: string) {
  const body: Record<string, string> = {
    message,
    content: Buffer.from(content).toString('base64'),
  };
  if (sha) body.sha = sha;

  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res;
}

// ── Gemini helper ───────────────────────────────────────────────────

async function callGemini(apiKey: string, systemPrompt: string, userMessage: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userMessage }] }],
          generationConfig: { maxOutputTokens: GEMINI_MAX_TOKENS, temperature: 0.4 },
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini API ${res.status}: ${err}`);
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } finally {
    clearTimeout(timer);
  }
}

// ── Prompt builder ──────────────────────────────────────────────────

function buildSystemPrompt(cv: string, profile: string, profileMd: string, preferences: string, language: string): string {
  const lang = language === 'es' ? 'Spanish' : 'English';

  return `You are an expert career coach drafting application materials for a candidate.
Write ALL output in ${lang}.

## Candidate CV
${cv}

## Candidate Profile
${profile}

## Candidate Archetypes & Narrative
${profileMd}

${preferences}

## Tone Rules — "I'm choosing you"

The candidate has options and is choosing this company for concrete reasons.

Rules:
- Confident without arrogance
- Selective without snobbery
- Specific and concrete: Always reference something REAL from the JD/company AND from the candidate's experience
- Direct, no fluff: 2-4 sentences per answer. No "I'm passionate about..." or "I would love the opportunity to..."
- The hook is the proof, not the claim

## Output Format

Output ONLY the markdown content below, no preamble:

## Cover Letter

[200-300 word cover letter — specific hook, 2-3 proof points, clear CTA]

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

// ── Parse preferences YAML (lightweight) ────────────────────────────

function parsePreferences(raw: string): string {
  const parseList = (key: string): string[] => {
    const match = raw.match(new RegExp(`${key}:\\s*\\n((?:\\s*-\\s*.+\\n)*)`, 'm'));
    if (!match) return [];
    return match[1]
      .split('\n')
      .map((l) => l.replace(/^\s*-\s*/, '').trim())
      .filter(Boolean);
  };

  const tone = parseList('tone_preferences');
  const avoid = parseList('avoid');
  const lang = parseList('language_patterns');

  const parts: string[] = [];
  if (tone.length > 0) parts.push(`The candidate prefers:\n${tone.map((p) => `- ${p}`).join('\n')}`);
  if (avoid.length > 0) parts.push(`The candidate does NOT like:\n${avoid.map((p) => `- ${p}`).join('\n')}`);
  if (lang.length > 0) parts.push(`Language notes:\n${lang.map((p) => `- ${p}`).join('\n')}`);

  return parts.length > 0 ? `## Learned Preferences\n${parts.join('\n\n')}` : '';
}

// ── Detect language ─────────────────────────────────────────────────

function detectLanguage(company: string, role: string, reportContent: string): string {
  const text = `${company} ${role} ${reportContent}`.toLowerCase();
  const spanishSignals = ['.mx', 'occ', 'computrabajo', 'indeed.com.mx', 'los cabos', 'cdmx', 'méxico'];
  return spanishSignals.some((s) => text.includes(s)) ? 'es' : 'en';
}

// ── Find report path for a job number ───────────────────────────────

function findReportPath(applicationsContent: string, jobNum: string): string | null {
  const padded = jobNum.padStart(3, '0');
  for (const line of applicationsContent.split('\n')) {
    const match = line.match(/^\|\s*(\d+)\s*\|/);
    if (match && match[1] === padded) {
      const reportMatch = line.match(/\(([^)]+)\)/);
      return reportMatch ? reportMatch[1] : null;
    }
  }
  return null;
}

// ── Extract company and role from tracker ────────────────────────────

function extractJobInfo(applicationsContent: string, jobNum: string): { company: string; role: string; score: string } | null {
  const padded = jobNum.padStart(3, '0');
  for (const line of applicationsContent.split('\n')) {
    const match = line.match(/^\|\s*(\d+)\s*\|/);
    if (match && match[1] === padded) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length >= 5) {
        return { company: cells[2], role: cells[3], score: cells[4] };
      }
    }
  }
  return null;
}

// ── Handler ─────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const ghToken = process.env.GH_TOKEN;
  const repo = process.env.GH_REPO;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!ghToken || !repo) {
    return res.status(500).json({ error: 'GH_TOKEN or GH_REPO not configured' });
  }
  if (!geminiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  const { jobNum } = req.body || {};
  if (!jobNum || typeof jobNum !== 'string') {
    return res.status(400).json({ error: 'jobNum is required' });
  }

  // Rate limit
  const now = Date.now();
  if (now - lastGenerationTime < RATE_LIMIT_MS) {
    const waitSec = Math.ceil((RATE_LIMIT_MS - (now - lastGenerationTime)) / 1000);
    return res.status(429).json({ error: `Espera ${waitSec} segundos antes de generar otro borrador.` });
  }

  try {
    // Load all context from GitHub
    const [appFile, cvFile, profileFile, profileMdFile, prefsFile] = await Promise.all([
      ghGet(repo, ghToken, 'data/applications.md'),
      ghGet(repo, ghToken, 'cv.md'),
      ghGet(repo, ghToken, 'config/profile.yml'),
      ghGet(repo, ghToken, 'modes/_profile.md'),
      ghGet(repo, ghToken, 'data/preferences.yml'),
    ]);

    const ghCheck = (file: { status?: number; error?: string } | null, path: string) => {
      if (!file) return `No se pudo leer ${path} (GitHub API respondió null)`;
      if (file.status) {
        const hint =
          file.status === 401 ? ' — verifica que GH_TOKEN no haya expirado'
          : file.status === 403 ? ' — el token no tiene permiso Contents:Read'
          : file.status === 404 ? ` — ¿el archivo existe en ${repo}? revisa GH_REPO`
          : '';
        return `No se pudo leer ${path}: ${file.error}${hint}`;
      }
      return null;
    };
    const appErr = ghCheck(appFile, 'data/applications.md');
    if (appErr) return res.status(500).json({ error: appErr, repo });
    const cvErr = ghCheck(cvFile, 'cv.md');
    if (cvErr) return res.status(500).json({ error: cvErr, repo });

    // Find the job's report
    const jobInfo = extractJobInfo(appFile.content, jobNum);
    if (!jobInfo) return res.status(404).json({ error: `Job #${jobNum} not found` });

    const reportPath = findReportPath(appFile.content, jobNum);
    if (!reportPath) return res.status(404).json({ error: `No report found for job #${jobNum}` });

    const reportFile = await ghGet(repo, ghToken, reportPath);
    if (!reportFile || reportFile.status) {
      const detail = reportFile?.error ? ` (${reportFile.error})` : '';
      return res.status(404).json({ error: `Report file not found: ${reportPath}${detail}` });
    }

    // Optional files: treat any HTTP error as "missing"
    const optional = <T extends { content: string; status?: number }>(f: T | null) =>
      (f && !f.status ? f.content : '');

    const language = detectLanguage(jobInfo.company, jobInfo.role, reportFile.content);
    const prefsSection = prefsFile && !prefsFile.status ? parsePreferences(prefsFile.content) : '';
    const systemPrompt = buildSystemPrompt(
      cvFile.content,
      optional(profileFile),
      optional(profileMdFile),
      prefsSection,
      language
    );

    const userMessage = `Generate application materials for this job:

**Company:** ${jobInfo.company}
**Role:** ${jobInfo.role}
**Score:** ${jobInfo.score}

## Evaluation Report
${reportFile.content}`;

    // Call Gemini
    lastGenerationTime = Date.now();
    const content = await callGemini(geminiKey, systemPrompt, userMessage);

    // Write draft to GitHub
    const padded = jobNum.padStart(3, '0');
    const draftPath = `data/drafts/${padded}-drafts.md`;
    const nowISO = new Date().toISOString();

    const frontmatter = `---
jobNum: "${padded}"
company: "${jobInfo.company.replace(/"/g, '\\"')}"
role: "${jobInfo.role.replace(/"/g, '\\"')}"
generatedAt: "${nowISO}"
language: "${language}"
status: "draft"
---

`;

    // Check if draft already exists (to get sha for update)
    const existingDraft = await ghGet(repo, ghToken, draftPath);
    const existingSha = existingDraft && !existingDraft.status ? existingDraft.sha : undefined;
    const putRes = await ghPut(
      repo, ghToken, draftPath,
      frontmatter + content,
      `Generate application drafts for job #${padded}`,
      existingSha
    );

    if (!putRes.ok) {
      const err = await putRes.text();
      return res.status(500).json({ error: `Failed to save draft: ${err}` });
    }

    // Parse the generated content into structured JSON for the UI
    const parsed = parseDraftContent(content, jobInfo.company);

    return res.status(200).json({
      ok: true,
      jobNum: padded,
      language,
      ...parsed,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}

// ── Parse generated markdown into structured JSON ───────────────────

function parseDraftContent(content: string, company: string) {
  const sections = content.split(/^## /m).filter(Boolean);

  let coverLetter = '';
  const questions: { q: string; a: string }[] = [];
  const linkedin: { hiringManager: string; recruiter: string } = { hiringManager: '', recruiter: '' };

  for (const section of sections) {
    const lines = section.trim();

    if (lines.startsWith('Cover Letter')) {
      coverLetter = lines.replace(/^Cover Letter\s*\n/, '').trim();
    } else if (lines.startsWith('Application Q&A')) {
      const qaParts = lines.split(/^### /m).slice(1);
      for (const qa of qaParts) {
        const [qLine, ...aLines] = qa.trim().split('\n');
        questions.push({
          q: qLine.replace(company, '[Company]').trim(),
          a: aLines.join('\n').trim(),
        });
      }
    } else if (lines.startsWith('LinkedIn Outreach')) {
      const parts = lines.split(/^### /m).slice(1);
      for (const part of parts) {
        const [label, ...msgLines] = part.trim().split('\n');
        const msg = msgLines.join('\n').trim();
        if (label.toLowerCase().includes('hiring')) {
          linkedin.hiringManager = msg;
        } else if (label.toLowerCase().includes('recruiter')) {
          linkedin.recruiter = msg;
        }
      }
    }
  }

  return { coverLetter, questions, linkedin };
}
