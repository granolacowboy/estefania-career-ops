/**
 * Vercel serverless function — creates a GitHub issue for feedback/feature requests.
 *
 * Env vars (set in Vercel project settings):
 *   GH_TOKEN  — GitHub personal access token with "issues:write" scope
 *   GH_REPO   — "owner/repo" format
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

  const { message, type } = req.body || {};

  if (!message || typeof message !== 'string' || message.trim().length < 3) {
    return res.status(400).json({ error: 'Message is required (min 3 characters)' });
  }

  const label = type === 'feature' ? 'enhancement' : 'feedback';
  const title = `[${label}] ${message.trim().slice(0, 80)}`;

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title,
          body: `**From:** Dashboard user\n**Type:** ${label}\n\n${message.trim()}`,
          labels: [label, 'dashboard'],
        }),
      }
    );

    if (response.status === 201) {
      return res.status(200).json({ ok: true, message: 'Feedback sent' });
    }

    const body = await response.text();
    return res.status(response.status).json({ error: body });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
