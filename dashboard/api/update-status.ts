/**
 * Vercel serverless function — updates a job's status in applications.md
 * via the GitHub Contents API (commit directly).
 *
 * Env vars:
 *   GH_TOKEN  — GitHub PAT with "contents:write" scope
 *   GH_REPO   — "owner/repo" format
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const VALID_STATUSES = ['Evaluated', 'Applied', 'Interview', 'Offer', 'Rejected', 'Skip'];
const FILE_PATH = 'data/applications.md';

async function ghApi(repo: string, token: string, path: string, options: RequestInit = {}) {
  const res = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  return res;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const token = process.env.GH_TOKEN;
  const repo = process.env.GH_REPO;

  if (!token || !repo) {
    return res.status(500).json({ error: 'GH_TOKEN or GH_REPO not configured' });
  }

  const { jobNum, status } = req.body || {};

  if (!jobNum || typeof jobNum !== 'string') {
    return res.status(400).json({ error: 'jobNum is required' });
  }

  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  try {
    // 1. Get current file content + sha
    const getRes = await ghApi(repo, token, `contents/${FILE_PATH}`);
    if (!getRes.ok) {
      return res.status(500).json({ error: 'Could not read applications.md' });
    }

    const fileData = await getRes.json();
    const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
    const sha = fileData.sha;

    // 2. Find and update the row matching jobNum
    const lines = content.split('\n');
    let updated = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match table row: | 001 | ... | Status | ...
      const match = line.match(/^\|\s*(\d+)\s*\|/);
      if (match && match[1] === jobNum.padStart(3, '0')) {
        const cells = line.split('|').slice(1, -1);
        if (cells.length >= 6) {
          cells[5] = ` ${status} `; // Status is the 6th column (index 5)
          lines[i] = '|' + cells.join('|') + '|';
          updated = true;
          break;
        }
      }
    }

    if (!updated) {
      return res.status(404).json({ error: `Job #${jobNum} not found` });
    }

    // 3. Commit the updated file
    const newContent = Buffer.from(lines.join('\n')).toString('base64');
    const putRes = await ghApi(repo, token, `contents/${FILE_PATH}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `Update job #${jobNum} status to ${status}`,
        content: newContent,
        sha,
      }),
    });

    if (putRes.ok) {
      return res.status(200).json({ ok: true, message: `Job #${jobNum} → ${status}` });
    }

    const body = await putRes.text();
    return res.status(putRes.status).json({ error: body });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
