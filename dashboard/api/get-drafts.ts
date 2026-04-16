/**
 * Vercel serverless function — reads draft application materials for a job.
 *
 * GET ?jobNum=005
 * Returns JSON with coverLetter, questions, linkedin sections.
 *
 * Env vars:
 *   GH_TOKEN  — GitHub PAT with "contents:read" scope
 *   GH_REPO   — "owner/repo" format
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

async function ghGet(repo: string, token: string, filePath: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return Buffer.from(data.content, 'base64').toString('utf-8');
}

function parseDraftMarkdown(raw: string) {
  // Strip frontmatter
  const body = raw.replace(/^---[\s\S]*?---\s*/, '');
  const sections = body.split(/^## /m).filter(Boolean);

  let coverLetter = '';
  const questions: { q: string; a: string }[] = [];
  const linkedin: { hiringManager: string; recruiter: string } = { hiringManager: '', recruiter: '' };
  let status = 'draft';
  let language = 'en';

  // Parse frontmatter for status and language
  const statusMatch = raw.match(/status:\s*"([^"]+)"/);
  if (statusMatch) status = statusMatch[1];
  const langMatch = raw.match(/language:\s*"([^"]+)"/);
  if (langMatch) language = langMatch[1];

  for (const section of sections) {
    const lines = section.trim();

    if (lines.startsWith('Cover Letter')) {
      coverLetter = lines.replace(/^Cover Letter\s*\n/, '').trim();
    } else if (lines.startsWith('Application Q&A')) {
      const qaParts = lines.split(/^### /m).slice(1);
      for (const qa of qaParts) {
        const [qLine, ...aLines] = qa.trim().split('\n');
        questions.push({
          q: qLine.trim(),
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

  return { coverLetter, questions, linkedin, status, language };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const token = process.env.GH_TOKEN;
  const repo = process.env.GH_REPO;

  if (!token || !repo) {
    return res.status(500).json({ error: 'GH_TOKEN or GH_REPO not configured' });
  }

  const jobNum = typeof req.query.jobNum === 'string' ? req.query.jobNum : '';
  if (!jobNum) {
    return res.status(400).json({ error: 'jobNum query parameter is required' });
  }

  const padded = jobNum.padStart(3, '0');
  const draftPath = `data/drafts/${padded}-drafts.md`;

  try {
    const content = await ghGet(repo, token, draftPath);
    if (!content) {
      return res.status(404).json({ error: 'No drafts found for this job', exists: false });
    }

    const parsed = parseDraftMarkdown(content);
    return res.status(200).json({ ok: true, jobNum: padded, exists: true, ...parsed });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
