/**
 * Vercel serverless function — adds a job URL to the pipeline for evaluation.
 *
 * POST { url: "https://...", company?: "Stripe", role?: "Marketing Manager" }
 *
 * 1. Appends the URL to data/pipeline.md via GitHub Contents API
 * 2. Triggers the Daily Job Scan workflow to process it
 *
 * Env vars:
 *   GH_TOKEN  — GitHub PAT with "contents:write" + "actions:write"
 *   GH_REPO   — "owner/repo" format
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const PIPELINE_PATH = 'data/pipeline.md';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const token = process.env.GH_TOKEN;
  const repo = process.env.GH_REPO;
  if (!token || !repo) {
    return res.status(500).json({ error: 'GH_TOKEN or GH_REPO not configured' });
  }

  const { url, company, role } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  // Basic URL validation
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    // Read current pipeline.md
    const getRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${PIPELINE_PATH}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    let content = '';
    let sha: string | undefined;

    if (getRes.ok) {
      const data = await getRes.json();
      content = Buffer.from(data.content, 'base64').toString('utf-8');
      sha = data.sha;
    } else {
      // File doesn't exist yet — create with header
      content = '# Pipeline — Pending URLs\n\n## Pendientes\n\n';
    }

    // Check for duplicate
    if (content.includes(url)) {
      return res.status(409).json({ error: 'Esta oferta ya está en la lista', url });
    }

    // Build the pipeline entry
    const label = [company, role].filter(Boolean).join(' | ');
    const entry = label
      ? `- [ ] ${url} | ${label}`
      : `- [ ] ${url}`;

    // Append entry
    const updatedContent = content.trimEnd() + '\n' + entry + '\n';

    // Write back
    const putRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${PIPELINE_PATH}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `Pipeline: add ${company || 'job'} URL from dashboard`,
          content: Buffer.from(updatedContent).toString('base64'),
          ...(sha ? { sha } : {}),
        }),
      }
    );

    if (!putRes.ok) {
      const err = await putRes.text();
      return res.status(putRes.status).json({ error: err });
    }

    // Trigger the workflow to process it
    await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/daily-scan.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main', inputs: { limit: '5' } }),
      }
    );

    return res.status(200).json({
      ok: true,
      message: 'Oferta agregada. Evaluación en ~10 minutos.',
      url,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
