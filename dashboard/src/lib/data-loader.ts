import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// process.cwd() is dashboard/ during build; career-ops data is one level up
const ROOT = resolve(process.cwd(), '..');

export interface Job {
  num: string;
  date: string;
  company: string;
  role: string;
  score: string;
  scoreNum: number;
  status: string;
  hasPdf: boolean;
  reportPath: string;
  notes: string;
}

export interface Report {
  slug: string;
  content: string;
  company: string;
  role: string;
}

export interface ProfileData {
  name: string;
  headline: string;
  location: string;
}

/** Parse the markdown table in data/applications.md into Job objects */
export function loadApplications(): Job[] {
  const filePath = join(ROOT, 'data', 'applications.md');
  if (!existsSync(filePath)) return [];

  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().startsWith('|'));

  // Skip header row and separator row
  const dataLines = lines.slice(2);

  return dataLines
    .map((line) => {
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.length < 8) return null;

      const [num, date, company, role, score, status, pdf, report, ...rest] =
        cells;
      const notes = rest.join(' ').trim();

      const scoreMatch = score.match(/([\d.]+)/);
      const scoreNum = scoreMatch ? parseFloat(scoreMatch[1]) : 0;

      // Extract report filename from markdown link [text](path)
      const reportMatch = report.match(/\(([^)]+)\)/);
      const reportPath = reportMatch ? reportMatch[1] : '';

      return {
        num,
        date,
        company,
        role,
        score,
        scoreNum,
        status,
        hasPdf: pdf.includes('✅'),
        reportPath,
        notes,
      } satisfies Job;
    })
    .filter((j): j is Job => j !== null);
}

/** Load all evaluation reports from reports/ */
export function loadReports(): Map<string, Report> {
  const reportsDir = join(ROOT, 'reports');
  if (!existsSync(reportsDir)) return new Map();

  const files = readdirSync(reportsDir).filter((f) => f.endsWith('.md'));
  const reports = new Map<string, Report>();

  for (const file of files) {
    const content = readFileSync(join(reportsDir, file), 'utf-8');
    const slug = file.replace('.md', '');

    // Try to extract company and role from report content
    const companyMatch = content.match(/\*\*Company:\*\*\s*(.+)/i);
    const roleMatch = content.match(/\*\*Role:\*\*\s*(.+)/i);

    reports.set(slug, {
      slug,
      content,
      company: companyMatch?.[1]?.trim() ?? slug,
      role: roleMatch?.[1]?.trim() ?? '',
    });
  }

  return reports;
}

/** Load basic profile info from config/profile.yml */
export function loadProfile(): ProfileData {
  const filePath = join(ROOT, 'config', 'profile.yml');
  if (!existsSync(filePath)) {
    return {
      name: 'Estefanía Rincón',
      headline: '',
      location: 'Los Cabos, BCS',
    };
  }

  const raw = readFileSync(filePath, 'utf-8');

  const nameMatch = raw.match(/full_name:\s*"([^"]+)"/);
  const headlineMatch = raw.match(/headline:\s*"([^"]+)"/);
  const locationMatch = raw.match(/city:\s*"([^"]+)"/);

  return {
    name: nameMatch?.[1] ?? 'Estefanía Rincón',
    headline: headlineMatch?.[1] ?? '',
    location: locationMatch?.[1] ?? 'Los Cabos, BCS',
  };
}

/** Get score badge color class */
export function scoreColor(score: number): string {
  if (score >= 4.5) return 'bg-emerald-100 text-emerald-800';
  if (score >= 4.0) return 'bg-teal-100 text-teal-800';
  if (score >= 3.5) return 'bg-amber-100 text-amber-800';
  return 'bg-red-100 text-red-800';
}

/** Load which jobs have existing drafts (by jobNum) */
export function loadDraftStatus(): Set<string> {
  const draftsDir = join(ROOT, 'data', 'drafts');
  if (!existsSync(draftsDir)) return new Set();

  const files = readdirSync(draftsDir).filter((f) => f.endsWith('-drafts.md'));
  const nums = new Set<string>();
  for (const f of files) {
    const match = f.match(/^(\d+)-drafts\.md$/);
    if (match) nums.add(match[1]);
  }
  return nums;
}

/** Get status badge color class */
export function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'evaluated') return 'bg-blue-100 text-blue-800';
  if (s === 'applied') return 'bg-indigo-100 text-indigo-800';
  if (s === 'interview') return 'bg-purple-100 text-purple-800';
  if (s === 'offer') return 'bg-emerald-100 text-emerald-800';
  if (s === 'responded') return 'bg-cyan-100 text-cyan-800';
  if (s === 'rejected') return 'bg-red-100 text-red-800';
  if (s === 'discarded' || s === 'skip') return 'bg-gray-100 text-gray-500';
  return 'bg-gray-100 text-gray-700';
}
