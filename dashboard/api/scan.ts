/**
 * Vercel serverless function — triggers the Daily Job Scan workflow
 * via GitHub Actions workflow_dispatch API.
 *
 * Env vars (set in Vercel project settings):
 *   GH_TOKEN  — GitHub personal access token with "actions:write" scope
 *   GH_REPO   — "owner/repo" format, e.g. "mhsb/estefania-career-ops"
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const token = process.env.GH_TOKEN?.trim();
  const repo = process.env.GH_REPO?.trim();

  if (!token || !repo) {
    return res.status(500).json({ error: 'GH_TOKEN or GH_REPO not configured' });
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/daily-scan.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: { limit: '10' },
        }),
      }
    );

    if (response.status === 204) {
      return res.status(200).json({ ok: true, message: 'Scan triggered' });
    }

    const body = await response.text();
    return res.status(response.status).json({ error: body });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
