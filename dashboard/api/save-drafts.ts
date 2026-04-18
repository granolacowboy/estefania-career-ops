/**
 * Vercel serverless function — saves edited draft application materials.
 *
 * POST { jobNum, coverLetter, questions: [{q, a}], linkedin: {hiringManager, recruiter} }
 * Updates data/drafts/{jobNum}-drafts.md via GitHub Contents API.
 *
 * Env vars:
 *   GH_TOKEN  — GitHub PAT with "contents:write" scope
 *   GH_REPO   — "owner/repo" format
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const token = process.env.GH_TOKEN?.trim();
  const repo = process.env.GH_REPO?.trim();

  if (!token || !repo) {
    return res.status(500).json({ error: 'GH_TOKEN or GH_REPO not configured' });
  }

  const { jobNum, coverLetter, questions, linkedin } = req.body || {};

  if (!jobNum || typeof jobNum !== 'string') {
    return res.status(400).json({ error: 'jobNum is required' });
  }

  const padded = jobNum.padStart(3, '0');
  const draftPath = `data/drafts/${padded}-drafts.md`;

  try {
    // Read existing draft to preserve frontmatter and get sha
    const existing = await ghGet(repo, token, draftPath);
    if (!existing) {
      return res.status(404).json({ error: `No draft found for job #${padded}` });
    }

    // Extract and update frontmatter
    const fmMatch = existing.content.match(/^(---[\s\S]*?---)/);
    let frontmatter = fmMatch ? fmMatch[1] : '---\n---';
    // Update status to "edited"
    frontmatter = frontmatter.replace(/status:\s*"[^"]*"/, 'status: "edited"');

    // Rebuild markdown body from structured data
    let body = '\n\n## Cover Letter\n\n';
    body += (coverLetter || '').trim();

    body += '\n\n## Application Q&A\n\n';
    if (Array.isArray(questions)) {
      for (const { q, a } of questions) {
        body += `### ${q}\n${a}\n\n`;
      }
    }

    body += '## LinkedIn Outreach\n\n';
    if (linkedin) {
      body += `### Hiring Manager\n${(linkedin.hiringManager || '').trim()}\n\n`;
      body += `### Recruiter\n${(linkedin.recruiter || '').trim()}\n`;
    }

    const newContent = frontmatter + body;

    // Write back to GitHub
    const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${draftPath}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `Update drafts for job #${padded}`,
        content: Buffer.from(newContent).toString('base64'),
        sha: existing.sha,
      }),
    });

    if (putRes.ok) {
      return res.status(200).json({ ok: true, message: `Borradores guardados para #${padded}` });
    }

    const err = await putRes.text();
    return res.status(putRes.status).json({ error: err });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
