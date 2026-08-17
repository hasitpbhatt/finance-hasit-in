// Hiring signals from free ATS boards (Greenhouse primary, Lever secondary).

import { cachedJson } from './cache.js';
import { HIRING_SOURCES } from './hiring-sources.js';

// Fetch open jobs from Greenhouse public API
async function getGreenhouseJobs(slug, signal = null) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
  const { data } = await cachedJson(url, 21600, {
    'User-Agent': 'InvestmentFinder/1.0 (contact@example.com)',
  }, null, signal);
  return data?.jobs || [];
}

// Fetch department-level job counts from Greenhouse
async function getGreenhouseDepartments(slug, signal = null) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/departments`;
  const { data } = await cachedJson(url, 21600, {
    'User-Agent': 'InvestmentFinder/1.0 (contact@example.com)',
  }, null, signal);
  return (data?.departments || []).filter(d => Array.isArray(d.jobs) && d.jobs.length > 0);
}

// Fetch open jobs from Lever public API
// Lever's postings endpoint returns a plain JSON array (or 404), not an
// object with a `jobs` key — handle both so the path isn't dead.
async function getLeverJobs(slug, signal = null) {
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  const { data } = await cachedJson(url, 21600, {
    'User-Agent': 'InvestmentFinder/1.0 (contact@example.com)',
  }, null, signal);
  return Array.isArray(data) ? data : data?.jobs || [];
}

// Normalize job shape to common fields
function normalizeJob(j) {
  return {
    title: j.title || '',
    department: j.department?.name || j.departments?.[0]?.name || j.categories?.team || '',
    location: j.location?.name || j.categories?.workplaceType || '',
    remote: String(j.location?.name || '').toLowerCase().includes('remote') || String(j.categories?.workplaceType || '').toLowerCase().includes('remote'),
    updatedAt: j.updated_at || j.updatedAt || j.posted_at || null,
    url: j.absolute_url || '',
  };
}

// Main export: returns { available: true, ... } or { available: false, reason }
export async function getHiring(ticker, signal = null) {
  const src = HIRING_SOURCES[ticker];
  if (!src) {
    return { available: false, reason: 'no_ats' };
  }

  let jobs = [];
  let departments = [];
  try {
    if (src.greenhouse) {
      [jobs, departments] = await Promise.all([
        getGreenhouseJobs(src.greenhouse, signal),
        getGreenhouseDepartments(src.greenhouse, signal),
      ]);
    } else if (src.lever) {
      jobs = await getLeverJobs(src.lever, signal);
    } else {
      return { available: false, reason: 'no_ats' };
    }
  } catch (e) {
    return { available: false, reason: 'source_error', error: e.message };
  }

  if (!jobs.length) {
    return { available: false, reason: 'no_openings' };
  }

  // Open jobs count
  const openJobs = jobs.length;

  // Earliest opening date
  const earliest = jobs.reduce((min, j) => {
    const d = new Date(j.updated_at || j.updatedAt || j.posted_at || 0).getTime();
    return d > 0 && d < min ? d : min;
  }, Infinity);

  // Top departments from departments endpoint
  const topDepts = departments
    .sort((a, b) => b.jobs.length - a.jobs.length)
    .slice(0, 3)
    .map(d => d.name);

  // Remote share from jobs
  const remoteCount = jobs.filter((j) => {
    const loc = (j.location?.name || j.categories?.workplaceType || '').toLowerCase();
    return loc.includes('remote') || loc.includes('work from home');
  }).length;
  const remoteShare = openJobs ? Math.round((remoteCount / openJobs) * 100) : 0;

  // Sample postings (first 5)
  const sample = jobs.slice(0, 5).map(normalizeJob);

  return {
    available: true,
    openJobs,
    earliestOpening: earliest === Infinity ? null : new Date(earliest).toISOString().split('T')[0],
    topDepartments: topDepts,
    remoteShare,
    posted: sample,
  };
}