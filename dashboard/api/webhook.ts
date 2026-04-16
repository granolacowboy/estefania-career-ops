/**
 * Vercel serverless function — webhook for Make/Zapier automation.
 *
 * Accepts status updates triggered by external systems (e.g., Gmail
 * detecting an application confirmation or interview invite).
 *
 * POST with Authorization: Bearer <WEBHOOK_SECRET>
 *
 * Body options:
 *   { jobNum: "001", status: "Applied" }              — direct update by job number
 *   { company: "HubSpot", status: "Interview" }       — fuzzy match by company name
 *   { company: "HubSpot", role: "Brand Manager", status: "Interview" }  — precise match
 *
 * Env vars:
 *   GH_TOKEN        — GitHub PAT with "contents:write" scope
 *   GH_REPO         — "owner/repo" format
 *   WEBHOOK_SECRET   — shared secret for authentication
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const VALID_STATUSES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'Skip'];
const FILE_PATH = 'data/applications.md';

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

function fuzzyMatch(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  // Authenticate
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'WEBHOOK_SECRET not configured' });
  }

  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ghToken = process.env.GH_TOKEN;
  const repo = process.env.GH_REPO;
  if (!ghToken || !repo) {
    return res.status(500).json({ error: 'GH_TOKEN or GH_REPO not configured' });
  }

  const { jobNum, company, role, status, notes } = req.body || {};

  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  if (!jobNum && !company) {
    return res.status(400).json({ error: 'Either jobNum or company is required' });
  }

  try {
    const file = await ghGet(repo, ghToken, FILE_PATH);
    if (!file) {
      return res.status(500).json({ error: 'Could not read applications.md' });
    }

    const lines = file.content.split('\n');
    let matchedIndex = -1;
    let matchedNum = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const rowMatch = line.match(/^\|\s*(\d+)\s*\|/);
      if (!rowMatch) continue;

      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length < 6) continue;

      const rowNum = cells[0];
      const rowCompany = cells[2];
      const rowRole = cells[3];

      // Match by jobNum (exact)
      if (jobNum && rowNum === String(jobNum).padStart(3, '0')) {
        matchedIndex = i;
        matchedNum = rowNum;
        break;
      }

      // Match by company (+ optional role)
      if (company && fuzzyMatch(rowCompany, company)) {
        if (role) {
          if (fuzzyMatch(rowRole, role)) {
            matchedIndex = i;
            matchedNum = rowNum;
            break;
          }
        } else {
          matchedIndex = i;
          matchedNum = rowNum;
          break;
        }
      }
    }

    if (matchedIndex === -1) {
      return res.status(404).json({
        error: 'No matching job found',
        searched: { jobNum, company, role },
      });
    }

    // Update the status column
    const cells = lines[matchedIndex].split('|').slice(1, -1);
    if (cells.length >= 6) {
      cells[5] = ` ${status} `;

      // Optionally append to notes
      if (notes && typeof notes === 'string' && cells.length >= 9) {
        const existing = cells[8].trim();
        cells[8] = ` ${existing ? existing + '; ' : ''}${notes.slice(0, 80)} `;
      }

      lines[matchedIndex] = '|' + cells.join('|') + '|';
    }

    // Commit
    const newContent = Buffer.from(lines.join('\n')).toString('base64');
    const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${FILE_PATH}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `Webhook: job #${matchedNum} → ${status}`,
        content: newContent,
        sha: file.sha,
      }),
    });

    if (putRes.ok) {
      return res.status(200).json({
        ok: true,
        jobNum: matchedNum,
        status,
        message: `Job #${matchedNum} updated to ${status}`,
      });
    }

    const err = await putRes.text();
    return res.status(putRes.status).json({ error: err });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
