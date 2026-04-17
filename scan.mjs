#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Web search via DuckDuckGo HTML (free, no API key) ──────────────

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; career-ops-scanner/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function searchDuckDuckGo(query) {
  const encoded = encodeURIComponent(query);
  const html = await fetchHtml(`https://html.duckduckgo.com/html/?q=${encoded}`);

  // Parse results from DDG HTML — each result is in <a class="result__a" href="...">title</a>
  const results = [];
  const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    let url = match[1];
    const title = match[2].replace(/<[^>]+>/g, '').trim();

    // DDG wraps URLs in a redirect — extract the actual URL
    const uddgMatch = url.match(/uddg=([^&]+)/);
    if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);

    if (url && title) results.push({ title, url, snippet: '' });
  }

  return results;
}

// Track which DDG queries have been run (rotate across daily runs)
const DDG_STATE_PATH = 'data/ddg-offset.txt';
const DDG_BATCH_SIZE = 8; // stay well under DDG rate limit

function getDdgOffset() {
  if (existsSync(DDG_STATE_PATH)) {
    return parseInt(readFileSync(DDG_STATE_PATH, 'utf-8').trim(), 10) || 0;
  }
  return 0;
}

function saveDdgOffset(offset) {
  writeFileSync(DDG_STATE_PATH, String(offset), 'utf-8');
}

// ── Free job board APIs (no keys required) ─────────────────────────

async function fetchRemoteOK(titleFilter) {
  const data = await fetchJson('https://remoteok.com/api', {
    headers: { 'User-Agent': 'career-ops-scanner/1.0 (job search tool)' },
  });
  // First element is API legal notice, skip it
  const jobs = Array.isArray(data) ? data.slice(1) : [];
  return jobs
    .filter(j => j.position && j.url)
    .filter(j => titleFilter(j.position))
    .map(j => ({
      title: j.position,
      url: j.url.startsWith('http') ? j.url : `https://remoteok.com${j.url}`,
      company: j.company || 'Unknown',
      location: j.location || 'Remote',
      source: 'remoteok-api',
    }));
}

async function fetchWeWorkRemotely(categories, titleFilter) {
  const jobs = [];
  for (const cat of categories) {
    try {
      const html = await fetchHtml(`https://weworkremotely.com/categories/remote-${cat}-jobs.rss`);
      // Parse RSS items: <item>...<title>...<link>...</item>
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(html)) !== null) {
        const block = match[1];
        const titleMatch = block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
        const linkMatch = block.match(/<link>(.*?)<\/link>/);
        const title = (titleMatch?.[1] || titleMatch?.[2] || '').trim();
        const url = (linkMatch?.[1] || '').trim();
        if (!title || !url) continue;
        // Extract company from "Company: Title" format
        const parts = title.split(/:\s*/);
        const company = parts.length > 1 ? parts[0] : 'Unknown';
        const role = parts.length > 1 ? parts.slice(1).join(': ') : title;
        if (!titleFilter(role) && !titleFilter(title)) continue;
        jobs.push({ title: role, url, company, location: 'Remote', source: `wwr-${cat}` });
      }
    } catch {
      // Category might not exist, skip silently
    }
  }
  return jobs;
}

// ── Mexican portals (HTML scrapers — SSR/public endpoints) ─────────

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchHtmlBrowserLike(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü',
};

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => HTML_ENTITIES[name] ?? m);
}

async function fetchComputrabajo(keywords, titleFilter) {
  const jobs = [];
  for (const kw of keywords) {
    const slug = slugify(kw);
    const url = `https://mx.computrabajo.com/trabajo-de-${slug}`;
    try {
      const html = await fetchHtmlBrowserLike(url);
      // Match job links: /ofertas-de-trabajo/oferta-de-trabajo-de-<slug>-<hex-id>
      const linkRegex = /<a[^>]+href="(\/ofertas-de-trabajo\/oferta-de-trabajo-de-[^"#]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
      const seen = new Set();
      let m;
      while ((m = linkRegex.exec(html)) !== null) {
        const path = m[1];
        if (seen.has(path)) continue;
        seen.add(path);
        const title = decodeEntities(m[2].replace(/<[^>]+>/g, '').trim());
        if (!title) continue;
        if (!titleFilter(title)) continue;

        // Try to find nearby company name (Computrabajo uses <p class="dIB fs16"> or similar)
        const ctxStart = Math.max(0, m.index - 400);
        const ctxEnd = Math.min(html.length, m.index + m[0].length + 600);
        const ctx = html.slice(ctxStart, ctxEnd);
        const companyMatch = ctx.match(/<(?:p|span|a)[^>]*class="[^"]*(?:it-blank|fs16|dFlex)[^"]*"[^>]*>([^<]{2,60})</);
        const locMatch = ctx.match(/<(?:p|span)[^>]*class="[^"]*(?:fs14|location|place)[^"]*"[^>]*>([^<]{2,80})</);

        jobs.push({
          title,
          url: `https://mx.computrabajo.com${path}`,
          company: decodeEntities(companyMatch?.[1].trim() || 'Unknown'),
          location: decodeEntities(locMatch?.[1].trim() || 'México'),
          source: `computrabajo:${slug}`,
        });
      }
      // polite delay between keywords
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      throw new Error(`Computrabajo '${kw}': ${err.message}`);
    }
  }
  return jobs;
}

async function fetchLinkedInMX(queries, titleFilter) {
  // queries = [{ keywords: 'marketing', location: 'Mexico', geoId?: string }]
  // Use the public guest endpoint that serves HTML fragments without login.
  const jobs = [];
  for (const q of queries) {
    const params = new URLSearchParams({
      keywords: q.keywords,
      location: q.location || 'Mexico',
      start: '0',
    });
    if (q.geoId) params.set('geoId', q.geoId);
    const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`;
    try {
      const html = await fetchHtmlBrowserLike(url);
      // Guest API returns <li>s with base-card__full-link anchors. Be permissive.
      const cardRegex = /<a[^>]+href="(https:\/\/[^"]*linkedin\.com\/jobs\/view\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      const seen = new Set();
      while ((m = cardRegex.exec(html)) !== null) {
        const rawUrl = m[1];
        // Normalize: strip query params after job id for dedup
        const idMatch = rawUrl.match(/jobs\/view\/[^?#]*?(\d{6,})/);
        const canonical = idMatch ? `https://www.linkedin.com/jobs/view/${idMatch[1]}/` : rawUrl;
        if (seen.has(canonical)) continue;
        seen.add(canonical);

        const inner = m[2];
        const titleMatch = inner.match(/<(?:h3|span)[^>]*>([\s\S]*?)<\/(?:h3|span)>/);
        const title = decodeEntities((titleMatch?.[1] || '').replace(/<[^>]+>/g, '').trim());
        if (!title || !titleFilter(title)) continue;

        // Look ahead/behind for company name + location
        const ctxStart = Math.max(0, m.index - 100);
        const ctxEnd = Math.min(html.length, m.index + m[0].length + 500);
        const ctx = html.slice(ctxStart, ctxEnd);
        const companyMatch = ctx.match(/base-search-card__subtitle[^>]*>[\s\S]*?<a[^>]*>([^<]+)</)
          || ctx.match(/job-search-card__subtitle[^>]*>([^<]+)</);
        const locMatch = ctx.match(/job-search-card__location[^>]*>([^<]+)</);

        jobs.push({
          title,
          url: canonical,
          company: decodeEntities(companyMatch?.[1].trim() || 'Unknown'),
          location: decodeEntities(locMatch?.[1].trim() || q.location || 'México'),
          source: `linkedin-mx:${slugify(q.keywords)}`,
        });
      }
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      throw new Error(`LinkedIn MX '${q.keywords}': ${err.message}`);
    }
  }
  return jobs;
}

// Domains that are never job postings
const NOISE_DOMAINS = /amazon\.|mercadolibre\.|ebay\.|walmart\.|aliexpress\.|facebook\.com(?!\/jobs)|twitter\.com|instagram\.com|youtube\.com|wikipedia\.org|pinterest\.|tiktok\./i;
const NOISE_PATHS = /\/privacy|\/terms|\/about-us|\/legal|\/blog\/|\/article\/|\/cart|\/product|\/dp\/|\/review/i;

// Domains that ARE job boards — boost these
const JOB_DOMAINS = /occ\.com\.mx|computrabajo\.com|indeed\.com|linkedin\.com\/jobs|bumeran\.com|glassdoor\.com|greenhouse\.io|lever\.co|ashbyhq\.com|jobs\.|careers\.|vacantes|weworkremotely\.com|remoteok\.com/i;

function extractJobsFromSearchResults(results, companyHint, titleFilter) {
  const jobs = [];
  for (const r of results) {
    if (NOISE_DOMAINS.test(r.url)) continue;
    if (NOISE_PATHS.test(r.url)) continue;

    // Try to extract company from title or use hint
    const company = companyHint || r.title.split(/\s*[-–—|]\s*/)[0].trim();
    const title = r.title;
    if (titleFilter && !titleFilter(title)) continue;

    // Boost score for known job domains
    const isJobSite = JOB_DOMAINS.test(r.url);
    jobs.push({ title, url: r.url, company, location: '', _priority: isJobSite ? 1 : 0 });
  }
  // Job board URLs first
  return jobs.sort((a, b) => b._priority - a._priority);
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  const tasks = targets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      const jobs = PARSERS[type](json, company.name);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 4b. Free job board APIs (RemoteOK, WeWorkRemotely)
  console.log('\nScanning free job board APIs...');

  try {
    const rokJobs = await fetchRemoteOK(titleFilter);
    totalFound += rokJobs.length;
    let rokNew = 0;
    for (const job of rokJobs) {
      if (seenUrls.has(job.url)) { totalDupes++; continue; }
      const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
      if (seenCompanyRoles.has(key)) { totalDupes++; continue; }
      seenUrls.add(job.url);
      seenCompanyRoles.add(key);
      newOffers.push(job);
      rokNew++;
    }
    console.log(`  RemoteOK: ${rokJobs.length} found, ${rokNew} new`);
  } catch (err) {
    errors.push({ company: 'RemoteOK', error: err.message });
  }

  try {
    const wwrJobs = await fetchWeWorkRemotely(['design', 'copywriting', 'marketing'], titleFilter);
    totalFound += wwrJobs.length;
    let wwrNew = 0;
    for (const job of wwrJobs) {
      if (seenUrls.has(job.url)) { totalDupes++; continue; }
      const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
      if (seenCompanyRoles.has(key)) { totalDupes++; continue; }
      seenUrls.add(job.url);
      seenCompanyRoles.add(key);
      newOffers.push(job);
      wwrNew++;
    }
    console.log(`  WeWorkRemotely: ${wwrJobs.length} found, ${wwrNew} new`);
  } catch (err) {
    errors.push({ company: 'WeWorkRemotely', error: err.message });
  }

  // 4d. Mexican portals (opt-in via portals.yml `mx_feeds` section)
  const mxFeeds = config.mx_feeds || {};

  if (mxFeeds.computrabajo?.enabled && Array.isArray(mxFeeds.computrabajo.keywords)) {
    console.log('\nScanning Mexican portals...');
    try {
      const ctJobs = await fetchComputrabajo(mxFeeds.computrabajo.keywords, titleFilter);
      totalFound += ctJobs.length;
      let ctNew = 0;
      for (const job of ctJobs) {
        if (seenUrls.has(job.url)) { totalDupes++; continue; }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) { totalDupes++; continue; }
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push(job);
        ctNew++;
      }
      console.log(`  Computrabajo MX: ${ctJobs.length} found, ${ctNew} new`);
    } catch (err) {
      errors.push({ company: 'Computrabajo', error: err.message });
    }
  }

  if (mxFeeds.linkedin_mx?.enabled && Array.isArray(mxFeeds.linkedin_mx.queries)) {
    try {
      const liJobs = await fetchLinkedInMX(mxFeeds.linkedin_mx.queries, titleFilter);
      totalFound += liJobs.length;
      let liNew = 0;
      for (const job of liJobs) {
        if (seenUrls.has(job.url)) { totalDupes++; continue; }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) { totalDupes++; continue; }
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push(job);
        liNew++;
      }
      console.log(`  LinkedIn MX: ${liJobs.length} found, ${liNew} new`);
    } catch (err) {
      errors.push({ company: 'LinkedIn MX', error: err.message });
    }
  }

  // 4c. DuckDuckGo web search (opt-in with --ddg flag — rate-limited from servers)
  const useDdg = args.includes('--ddg');
  let webSearchCount = 0;
  let webSearchFound = 0;

  if (useDdg) {
    const searchQueries = (config.search_queries || []).filter(q => q.enabled !== false);
    const webSearchCompanies = companies
      .filter(c => c.enabled !== false && c.scan_method === 'websearch' && c.scan_query)
      .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany));

    const allWebQueries = [
      ...searchQueries.map(q => ({ query: q.query, name: q.name, companyHint: null })),
      ...webSearchCompanies.map(c => ({ query: c.scan_query, name: c.name, companyHint: c.name })),
    ];

    const offset = getDdgOffset();
    const batch = allWebQueries.slice(offset, offset + DDG_BATCH_SIZE);
    const nextOffset = (offset + DDG_BATCH_SIZE) >= allWebQueries.length ? 0 : offset + DDG_BATCH_SIZE;

    console.log(`\nSearching ${batch.length}/${allWebQueries.length} web queries via DuckDuckGo (batch ${Math.floor(offset / DDG_BATCH_SIZE) + 1})...`);

    for (const wq of batch) {
      try {
        const results = await searchDuckDuckGo(wq.query);
        webSearchCount++;
        const jobs = extractJobsFromSearchResults(results, wq.companyHint, titleFilter);
        webSearchFound += results.length;
        totalFound += results.length;

        for (const job of jobs) {
          if (seenUrls.has(job.url)) { totalDupes++; continue; }
          const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
          if (seenCompanyRoles.has(key)) { totalDupes++; continue; }
          seenUrls.add(job.url);
          seenCompanyRoles.add(key);
          newOffers.push({ ...job, source: `websearch:${wq.name}` });
        }

        await new Promise(r => setTimeout(r, 3000));
      } catch (err) {
        errors.push({ company: `search:${wq.name}`, error: err.message });
      }
    }

    if (!dryRun) saveDdgOffset(nextOffset);
  }

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length} (API) + ${webSearchCount} (web search)`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
