/**
 * Vercel serverless function — records thumbs up/down feedback on drafts.
 *
 * POST { jobNum, section, signal: "up"|"down", note? }
 * Appends to raw_feedback in data/preferences.yml.
 * After 5+ new entries, triggers Gemini to distill patterns.
 *
 * Env vars:
 *   GH_TOKEN       — GitHub PAT with "contents:write" scope
 *   GH_REPO        — "owner/repo" format
 *   GEMINI_API_KEY  — For distillation calls
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const VALID_SECTIONS = ['cover_letter', 'questions', 'linkedin_hm', 'linkedin_rec'];
const VALID_SIGNALS = ['up', 'down'];
const DISTILL_THRESHOLD = 5;
const GEMINI_MODEL = 'gemini-2.0-flash';
const MAX_RAW_FEEDBACK = 20;

// ── GitHub helpers ──────────────────────────────────────────────────

async function ghGet(repo: string, token: string, filePath: string): Promise<{ content: string; sha: string } | null> {
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return {
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
    sha: data.sha,
  };
}

async function ghPut(repo: string, token: string, filePath: string, content: string, message: string, sha: string) {
  return fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, content: Buffer.from(content).toString('base64'), sha }),
  });
}

// ── Lightweight YAML helpers ─────────────────────────────────────────

function parseList(raw: string, key: string): string[] {
  const match = raw.match(new RegExp(`${key}:\\s*\\n((?:\\s*-\\s*.+\\n)*)`, 'm'));
  if (!match) return [];
  return match[1]
    .split('\n')
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
}

function parseFeedbackCount(raw: string): number {
  const match = raw.match(/feedback_count:\s*(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

interface FeedbackEntry {
  jobNum: string;
  date: string;
  signal: string;
  section: string;
  note: string;
}

function parseRawFeedback(raw: string): FeedbackEntry[] {
  const entries: FeedbackEntry[] = [];
  const feedbackSection = raw.match(/raw_feedback:\s*\n([\s\S]*?)(?=\n\w|\n*$)/);
  if (!feedbackSection) return entries;

  const items = feedbackSection[1].split(/\n\s*-\s*jobNum:/);
  for (const item of items) {
    if (!item.trim()) continue;
    const block = 'jobNum:' + item;
    const jn = block.match(/jobNum:\s*"?([^"\n]+)"?/)?.[1]?.trim() || '';
    const dt = block.match(/date:\s*"?([^"\n]+)"?/)?.[1]?.trim() || '';
    const sig = block.match(/signal:\s*"?([^"\n]+)"?/)?.[1]?.trim() || '';
    const sec = block.match(/section:\s*"?([^"\n]+)"?/)?.[1]?.trim() || '';
    const nt = block.match(/note:\s*"?([^"\n]*)"?/)?.[1]?.trim() || '';
    if (jn) entries.push({ jobNum: jn, date: dt, signal: sig, section: sec, note: nt });
  }
  return entries;
}

function buildPreferencesYaml(
  tonePreferences: string[],
  avoid: string[],
  languagePatterns: string[],
  feedbackCount: number,
  rawFeedback: FeedbackEntry[]
): string {
  const date = new Date().toISOString().slice(0, 10);
  const fmtList = (items: string[]) =>
    items.length === 0 ? ' []' : '\n' + items.map((i) => `  - "${i.replace(/"/g, '\\"')}"`).join('\n');

  const fmtFeedback = rawFeedback
    .map(
      (f) =>
        `  - jobNum: "${f.jobNum}"\n    date: "${f.date}"\n    signal: "${f.signal}"\n    section: "${f.section}"\n    note: "${f.note.replace(/"/g, '\\"')}"`
    )
    .join('\n');

  return `# Apply Assistant — Learned Preferences
# Updated automatically as Estefanía gives feedback on drafts.

updated: "${date}"
feedback_count: ${feedbackCount}

tone_preferences:${fmtList(tonePreferences)}

avoid:${fmtList(avoid)}

language_patterns:${fmtList(languagePatterns)}

raw_feedback:
${fmtFeedback || '  []'}
`;
}

// ── Distillation via Gemini ──────────────────────────────────────────

async function distillPreferences(
  geminiKey: string,
  rawFeedback: FeedbackEntry[],
  currentTone: string[],
  currentAvoid: string[],
  currentLang: string[]
): Promise<{ tone: string[]; avoid: string[]; lang: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  const prompt = `You are analyzing job application feedback for a candidate named Estefanía.

Recent feedback signals:
${rawFeedback.map((f) => `- Job #${f.jobNum}, section: ${f.section}, signal: ${f.signal}${f.note ? `, note: "${f.note}"` : ''}`).join('\n')}

Current known preferences:
Tone preferences: ${currentTone.length > 0 ? currentTone.join('; ') : 'none yet'}
Avoid: ${currentAvoid.length > 0 ? currentAvoid.join('; ') : 'none yet'}
Language patterns: ${currentLang.length > 0 ? currentLang.join('; ') : 'none yet'}

Based on the new feedback, update the preference lists.
Only add patterns you're confident about (2+ signals in same direction).
Remove patterns contradicted by new signals.

Output ONLY valid JSON (no markdown fences):
{"tone_preferences": ["..."], "avoid": ["..."], "language_patterns": ["..."]}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 1024, temperature: 0.2 },
        }),
      }
    );

    if (!res.ok) return { tone: currentTone, avoid: currentAvoid, lang: currentLang };

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    // Extract JSON from response (may have markdown fences)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { tone: currentTone, avoid: currentAvoid, lang: currentLang };

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      tone: Array.isArray(parsed.tone_preferences) ? parsed.tone_preferences : currentTone,
      avoid: Array.isArray(parsed.avoid) ? parsed.avoid : currentAvoid,
      lang: Array.isArray(parsed.language_patterns) ? parsed.language_patterns : currentLang,
    };
  } catch {
    return { tone: currentTone, avoid: currentAvoid, lang: currentLang };
  } finally {
    clearTimeout(timer);
  }
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

  const { jobNum, section, signal, note } = req.body || {};

  if (!jobNum || typeof jobNum !== 'string') {
    return res.status(400).json({ error: 'jobNum is required' });
  }
  if (!VALID_SECTIONS.includes(section)) {
    return res.status(400).json({ error: `section must be one of: ${VALID_SECTIONS.join(', ')}` });
  }
  if (!VALID_SIGNALS.includes(signal)) {
    return res.status(400).json({ error: 'signal must be "up" or "down"' });
  }

  try {
    const prefsFile = await ghGet(repo, ghToken, 'data/preferences.yml');
    if (!prefsFile) {
      return res.status(500).json({ error: 'Could not read preferences.yml' });
    }

    const currentTone = parseList(prefsFile.content, 'tone_preferences');
    const currentAvoid = parseList(prefsFile.content, 'avoid');
    const currentLang = parseList(prefsFile.content, 'language_patterns');
    let feedbackCount = parseFeedbackCount(prefsFile.content) + 1;
    const rawFeedback = parseRawFeedback(prefsFile.content);

    // Add new feedback entry
    const newEntry: FeedbackEntry = {
      jobNum: jobNum.padStart(3, '0'),
      date: new Date().toISOString().slice(0, 10),
      signal,
      section,
      note: typeof note === 'string' ? note.slice(0, 200) : '',
    };
    rawFeedback.push(newEntry);

    // Keep only last MAX_RAW_FEEDBACK entries
    while (rawFeedback.length > MAX_RAW_FEEDBACK) {
      rawFeedback.shift();
    }

    // Check if we should distill patterns
    let tone = currentTone;
    let avoid = currentAvoid;
    let lang = currentLang;
    let distilled = false;

    if (geminiKey && feedbackCount % DISTILL_THRESHOLD === 0 && rawFeedback.length >= DISTILL_THRESHOLD) {
      const result = await distillPreferences(geminiKey, rawFeedback, currentTone, currentAvoid, currentLang);
      tone = result.tone;
      avoid = result.avoid;
      lang = result.lang;
      distilled = true;
    }

    // Write updated preferences
    const newYaml = buildPreferencesYaml(tone, avoid, lang, feedbackCount, rawFeedback);
    const putRes = await ghPut(
      repo, ghToken,
      'data/preferences.yml',
      newYaml,
      `Record draft feedback #${feedbackCount}${distilled ? ' + distill patterns' : ''}`,
      prefsFile.sha
    );

    if (!putRes.ok) {
      const err = await putRes.text();
      return res.status(500).json({ error: `Failed to save feedback: ${err}` });
    }

    return res.status(200).json({
      ok: true,
      feedbackCount,
      distilled,
      message: distilled
        ? '¡Gracias! He actualizado mis patrones con tu feedback.'
        : '¡Gracias! Aprendo de cada interacción.',
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
