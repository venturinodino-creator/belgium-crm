/**
 * competitor-jobs-scan.js — Daily scan of open roles at companies that sell
 * a product directly competing with one of Elsevier's named RI solutions
 * (Scopus, SciVal, Pure, Insight Graph, 4GU reports, Digital Commons),
 * scoped to a Belgium account manager's specific interest:
 * Strategic/Senior Account Management (SAM), Customer Success (CSM), and
 * Channel/Partnerships hiring tied to that competing product line (not
 * engineering, product, editorial, ops, or an unrelated business line like
 * a diversified competitor's IP/patent or clinical-regulatory arm).
 *
 * Only 3 of the companies tracked elsewhere in this app (e.g. in
 * news-scan.js's Competitor Announcements) actually qualify — see SOURCES
 * below for the product-competitor mapping (Clarivate/Web of Science vs
 * Scopus, etc). Companies that are broadly "an Elsevier competitor" but
 * don't sell a Scopus/SciVal/Pure/Digital Commons-type product (OpenAI,
 * Anthropic, Elicit, SciSpace, Springer Nature, Wiley) are deliberately
 * excluded here even though they have a working ATS — see
 * NOT_PRODUCT_COMPETITOR below.
 *
 * Deliberately NOT LinkedIn: LinkedIn requires login for job search and
 * actively blocks automated access, so there is no reliable or
 * ToS-compliant way to scrape it from a script (and no free public API —
 * LinkedIn's Jobs/Talent API is enterprise/partnership-only). Instead this
 * pulls straight from each company's own careers-page ATS, whose public
 * JSON API is meant for exactly this kind of programmatic read — and since
 * a LinkedIn job post is near-always just a syndicated copy of the ATS
 * listing, this captures the same signal without the ToS problem.
 *
 * Per-company ATS coverage (verified by hand — see git history for the
 * research this was built from; do not guess new endpoints without
 * verifying the same way):
 *   - Greenhouse, Ashby, SmartRecruiters, Pinpoint: simple GET, no auth.
 *   - Workday (CXS API): requires a POST with a JSON search body — see
 *     fetchWorkday() below.
 *   - No usable public API found: scite (not hiring), Consensus (LinkedIn
 *     only), Paperguide (no formal ATS), IGI Global (email-only), IEEE
 *     (Taleo, session-based), Google (proprietary/internal API). These are
 *     listed in UNTRACKED_COMPANIES so the UI can be upfront about the gap
 *     instead of silently omitting them.
 *
 * Unlike news-scan.js, this does a full resync each run rather than an
 * accumulating feed: a role no longer returned by a company's ATS has
 * presumably closed, so it's dropped from the live list. foundDate is
 * preserved across runs for a role that's still open, so "open since" is
 * still visible.
 *
 * No ANTHROPIC_API_KEY needed — ATS results are already precise structured
 * data, no relevance judgement call required, just deterministic
 * location/title filtering.
 *
 * Run: node scripts/competitor-jobs-scan.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const DATA_FILE = 'data/competitor-jobs.json';
const STATE_FILE = 'data/competitor-jobs-scan-state.json';
const REQUEST_TIMEOUT_MS = 20000;

// Netherlands-relevant location match — Dutch city names + country
// name/abbrev, plus EMEA/Europe-remote and the specific European hub
// cities these companies actually staff EMEA sales/CSM/channel roles
// out of (London, Dublin, Berlin, Paris, etc). A SAM/CSM/Channel role
// based in one of those hubs, or explicitly remote-EMEA, plausibly
// covers Dutch accounts even without a Dutch city in the listing — ATS
// location fields are almost never literally "EMEA", they name a city,
// so the city list matters more than the EMEA/Europe tokens alone.
const NL_LOCATION_RE = /netherlands|nederland|amsterdam|utrecht|rotterdam|the hague|den haag|eindhoven|groningen|delft|leiden|maastricht|\bnl\b|\bemea\b|remote[\s,-]*europe|europe[\s,-]*remote|london|dublin|berlin|munich|frankfurt|paris|madrid|barcelona|lisbon|stockholm|copenhagen|zurich|milan|brussels|dubai/i;

// Only three role families matter to a sales agent tracking competitor
// go-to-market headcount: Strategic/Senior Account Management, Customer
// Success, and Channel/Partnerships. Everything else (engineering, product,
// ops, editorial, support, etc.) is excluded entirely rather than tagged
// "other" — a role that doesn't match one of these is not shown.
const SAM_TITLE_RE = /\b(strategic account (manager|director|executive)|senior account (manager|executive)|key account (manager|director)|enterprise account (manager|executive)|account (manager|executive|director)|regional sales (manager|director))\b/i;
const CSM_TITLE_RE = /\b(customer success (manager|director|lead)|client success (manager|director)|customer success)\b/i;
const CHANNEL_TITLE_RE = /\b(channel (manager|director|sales|partnerships?)|partner(ship)? (manager|director|lead)|alliance(s)? (manager|director)|business development (manager|director))\b/i;

// Once a title matches one of the three role families above, exclude it if
// it's clearly scoped to a business line that doesn't compete with
// Elsevier's Research Intelligence / scholarly-publishing solutions — e.g.
// a diversified competitor's IP/patent, life-sciences-regulatory, or
// clinical-consulting arm. Title/department-only data means this is a
// best-effort keyword check, not a guarantee.
const NON_RESEARCH_VERTICAL_RE = /\b(patent|trademark|intellectual property|ip (services|management|licensing)|regulatory affairs|clinical trial|pharmacovigilance|drug safety|life sciences consulting)\b/i;

function classifyRole(title, department) {
  const text = `${title} ${department || ''}`;
  if (NON_RESEARCH_VERTICAL_RE.test(text)) return null;
  if (SAM_TITLE_RE.test(title)) return 'sam';
  if (CSM_TITLE_RE.test(title)) return 'csm';
  if (CHANNEL_TITLE_RE.test(title)) return 'channel';
  return null;
}

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function saveJSON(path, data) {
  const dir = path.split('/').slice(0, -1).join('/');
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}
function makeId(company, url) {
  let hash = 0;
  const s = company + '|' + url;
  for (let i = 0; i < s.length; i++) { hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0; }
  return 'job-' + Math.abs(hash).toString(36);
}
function toISODate(d) {
  const dt = new Date(d);
  return isNaN(dt) ? null : dt.toISOString().slice(0, 10);
}

async function fetchJSON(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// -- Greenhouse: GET https://boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true
async function fetchGreenhouse(company, boardToken) {
  const data = await fetchJSON(`https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs?content=true`);
  return (data.jobs || []).map(j => ({
    company,
    title: String(j.title || '').trim(),
    location: (j.location && j.location.name) || '',
    department: (j.departments && j.departments[0] && j.departments[0].name) || '',
    url: j.absolute_url || '',
    postedDate: toISODate(j.updated_at || j.first_published),
    source: 'Greenhouse',
  }));
}

// -- Ashby: GET https://api.ashbyhq.com/posting-api/job-board/<boardName>
async function fetchAshby(company, boardName) {
  const data = await fetchJSON(`https://api.ashbyhq.com/posting-api/job-board/${boardName}`);
  return (data.jobs || []).map(j => ({
    company,
    title: String(j.title || '').trim(),
    location: j.location || (j.address && j.address.postalAddress && [j.address.postalAddress.addressLocality, j.address.postalAddress.addressCountry].filter(Boolean).join(', ')) || '',
    department: j.department || j.team || '',
    url: j.jobUrl || j.applyUrl || '',
    postedDate: toISODate(j.publishedAt || j.publishedDate),
    source: 'Ashby',
  }));
}

// -- SmartRecruiters: GET https://api.smartrecruiters.com/v1/companies/<id>/postings
async function fetchSmartRecruiters(company, companyId) {
  const data = await fetchJSON(`https://api.smartrecruiters.com/v1/companies/${companyId}/postings`);
  return (data.content || []).map(p => ({
    company,
    title: String(p.name || '').trim(),
    location: p.location ? [p.location.city, p.location.region, p.location.country].filter(Boolean).join(', ') : '',
    department: (p.department && p.department.label) || '',
    url: p.applyUrl || p.postingUrl || `https://jobs.smartrecruiters.com/${companyId}/${p.id}`,
    postedDate: toISODate(p.releasedDate),
    source: 'SmartRecruiters',
  }));
}

// -- Pinpoint: GET https://<slug>.pinpointhq.com/postings.json
async function fetchPinpoint(company, slug) {
  const data = await fetchJSON(`https://${slug}.pinpointhq.com/postings.json`);
  const list = Array.isArray(data) ? data : (data.postings || data.jobs || []);
  return list.map(p => ({
    company,
    title: String(p.title || '').trim(),
    location: (p.location && (p.location.name || p.location)) || p.location_name || '',
    department: (p.department && (p.department.name || p.department)) || '',
    url: p.url || p.absolute_url || '',
    postedDate: toISODate(p.published_at || p.created_at),
    source: 'Pinpoint',
  }));
}

// -- Workday CXS API: POST https://<tenant>.wd<N>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs
// Paginates in pages of `limit`; loops until a page returns fewer than
// requested or a safety cap is hit. postedOn is a relative string ("Posted
// 3 Days Ago"), not a real date, so postedDate is left null — foundDate
// covers it. Wrapped defensively since this is POST-based and its exact
// response shape wasn't confirmed against live data before shipping.
async function fetchWorkday(company, host, tenant, site) {
  const base = `https://${tenant}.${host}.myworkdayjobs.com`;
  const jobs = [];
  const limit = 20;
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const data = await fetchJSON(`${base}/wday/cxs/${tenant}/${site}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText: '' }),
    });
    const postings = data.jobPostings || [];
    for (const j of postings) {
      jobs.push({
        company,
        title: String(j.title || '').trim(),
        location: j.locationsText || '',
        department: '',
        url: j.externalPath ? `${base}/${site}${j.externalPath}` : '',
        postedDate: null,
        source: 'Workday',
      });
    }
    if (postings.length < limit) break;
    offset += limit;
  }
  return jobs;
}

// Only companies that actually sell a product directly competing with one
// of Elsevier's named RI solutions (Scopus, SciVal, Pure, Insight Graph,
// 4GU reports, Digital Commons) are scanned for hiring roles — a company
// being a broad "Elsevier competitor" (tracked elsewhere, e.g. in
// news-scan.js's Competitor Announcements) is not enough on its own:
//   - Clarivate: Web of Science (Scopus), InCites (SciVal), Converis (Pure)
//   - Digital Science: Dimensions (Scopus/SciVal), Figshare (Digital
//     Commons), Symplectic Elements (Pure)
//   - Allen Institute for AI: Semantic Scholar (Scopus's discovery/
//     citation-graph function)
// Companies deliberately excluded even though they have a working ATS —
// see NOT_PRODUCT_COMPETITOR below for why each one doesn't qualify.
const SOURCES = [
  { company: 'Digital Science', fetch: () => fetchPinpoint('Digital Science', 'digitalscience') },
  { company: 'Allen Institute for AI', fetch: () => fetchGreenhouse('Allen Institute for AI', 'thealleninstitute') },
  { company: 'Clarivate', fetch: () => fetchWorkday('Clarivate', 'wd3', 'clarivate', 'Clarivate_Careers') },
];

// Companies with no usable public API — surfaced in scan state so the UI
// can be upfront about the gap instead of silently omitting them.
const UNTRACKED_COMPANIES = [
  { company: 'scite', reason: 'Not currently hiring (applications by email)', url: 'https://scite.ai/jobs' },
  { company: 'Consensus', reason: 'Roles posted only to LinkedIn, no ATS board found', url: 'https://consensus.app/home/careers/' },
  { company: 'Paperguide', reason: 'No formal careers page/ATS (small team, hires ad hoc via LinkedIn)', url: 'https://linkedin.com/company/paperguideai' },
  { company: 'IGI Global Scientific Publishing', reason: 'Static list, applications by email', url: 'https://www.igi-global.com/about/staff/job-opportunities/' },
  { company: 'IEEE', reason: 'Oracle Taleo, session-based, no public JSON API', url: 'https://ieee.taleo.net/careersection/2/jobsearch.ftl' },
  { company: 'Google', reason: 'Proprietary/internal API, not public', url: 'https://careers.google.com/' },
];

// Companies that DO have a usable ATS but are excluded on purpose: nothing
// they sell directly competes with Scopus/SciVal/Pure/Digital Commons, so
// their SAM/CSM/Channel hiring isn't a signal for this feature even though
// they're tracked elsewhere as broader Elsevier competitors.
const NOT_PRODUCT_COMPETITOR = [
  { company: 'OpenAI', reason: "General-purpose AI platform (Claude/GPT-style API) — no discrete product competing with Scopus/SciVal/Pure/Digital Commons", url: 'https://openai.com/careers/' },
  { company: 'Anthropic', reason: "General-purpose AI platform — no discrete product competing with Scopus/SciVal/Pure/Digital Commons", url: 'https://anthropic.com/careers' },
  { company: 'Elicit', reason: 'AI research-assistant tool, not a Scopus/SciVal/Pure/Digital Commons-type institutional platform', url: 'https://elicit.com/careers' },
  { company: 'SciSpace', reason: 'AI research-assistant tool, not a Scopus/SciVal/Pure/Digital Commons-type institutional platform', url: 'https://typeset.io/careers' },
  { company: 'Springer Nature', reason: 'Publisher — no discrete analytics/CRIS/repository product competing with Scopus/SciVal/Pure/Digital Commons', url: 'https://springernature.wd3.myworkdayjobs.com/SpringerNatureCareers' },
  { company: 'Wiley', reason: 'Publisher — no discrete analytics/CRIS/repository product competing with Scopus/SciVal/Pure/Digital Commons', url: 'https://wiley.wd1.myworkdayjobs.com/wiley_careers' },
];

async function main() {
  const existing = readJSON(DATA_FILE, []);
  const existingByKey = new Map(existing.map(j => [j.company + '|' + j.url, j]));

  const allJobs = [];
  const perCompanyCounts = {};
  const errors = {};

  for (const src of SOURCES) {
    try {
      const jobs = await src.fetch();
      perCompanyCounts[src.company] = { total: jobs.length, nl: 0 };
      for (const j of jobs) {
        if (!j.title || !j.url) continue;
        if (!NL_LOCATION_RE.test(j.location || '')) continue;
        const roleCategory = classifyRole(j.title, j.department);
        if (!roleCategory) continue; // not a SAM/CSM/Channel role in the research-solutions line
        perCompanyCounts[src.company].nl++;
        const key = j.company + '|' + j.url;
        const prior = existingByKey.get(key);
        allJobs.push({
          id: makeId(j.company, j.url),
          company: j.company,
          title: j.title.slice(0, 200),
          location: String(j.location || '').slice(0, 150),
          department: String(j.department || '').slice(0, 100),
          roleCategory,
          url: j.url.slice(0, 500),
          postedDate: j.postedDate,
          foundDate: (prior && prior.foundDate) || new Date().toISOString().slice(0, 10),
          source: j.source,
        });
      }
      console.log(`[competitor-jobs] ${src.company}: ${jobs.length} open role(s), ${perCompanyCounts[src.company].nl} Netherlands SAM/CSM/Channel matches`);
    } catch (e) {
      errors[src.company] = e.message;
      console.warn(`[competitor-jobs] ${src.company} failed: ${e.message}`);
    }
  }

  allJobs.sort((a, b) => (b.postedDate || b.foundDate || '').localeCompare(a.postedDate || a.foundDate || ''));
  saveJSON(DATA_FILE, allJobs);

  saveJSON(STATE_FILE, {
    lastRun: new Date().toISOString(),
    totalOpenRoles: allJobs.length,
    perCompanyCounts,
    errors,
    untracked: [...UNTRACKED_COMPANIES, ...NOT_PRODUCT_COMPETITOR],
    source: 'Company career-page ATS APIs (Greenhouse/Ashby/SmartRecruiters/Pinpoint/Workday) — not LinkedIn, see file header',
  });
  console.log(`[competitor-jobs] Done — ${allJobs.length} Netherlands SAM/CSM/Channel role(s) across ${SOURCES.length - Object.keys(errors).length}/${SOURCES.length} tracked companies.`);
}

main().catch(e => {
  console.error('[competitor-jobs] Failed:', e.message);
  try {
    saveJSON(STATE_FILE, { lastRun: new Date().toISOString(), totalOpenRoles: 0, error: e.message, untracked: [...UNTRACKED_COMPANIES, ...NOT_PRODUCT_COMPETITOR] });
  } catch { /* ignore */ }
  process.exit(1);
});
