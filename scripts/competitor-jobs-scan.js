/**
 * competitor-jobs-scan.js — Daily scan of open roles, based in Belgium or
 * remote, at Elsevier's tracked competitors, scoped to a Belgium account
 * manager's specific interest: go-to-market and customer-facing hiring —
 * Strategic/Senior Account Management (SAM), Sales Development (SDR/BDR),
 * Channel/Partnerships, and the full customer-lifecycle line (Customer
 * Success, pre-sales/solution consulting, implementation/onboarding,
 * technical/product support, customer service & licence admin, training &
 * customer education, usage/reporting analytics, product marketing) — not
 * engineering, core product/eng management, editorial, finance, HR, or an
 * unrelated business line like a diversified competitor's IP/patent or
 * clinical-regulatory arm. See classifyRole() below for the exact title
 * patterns per category.
 *
 * Covers every company tracked elsewhere in this app as an Elsevier
 * competitor (e.g. in news-scan.js's Competitor Announcements) that also has
 * a usable public ATS API — see SOURCES below for the full list and what
 * each one competes with. A handful of tracked competitors have no usable
 * public API and can't be scanned at all (LinkedIn-only postings, static
 * pages, session-based ATS) — see UNTRACKED_COMPANIES.
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
 *     only), SciSpace (no ATS found on Ashby/Greenhouse/Lever), Paperguide
 *     (no formal ATS), IGI Global (email-only), IEEE (Taleo, session-based),
 *     Google (proprietary/internal API). These are listed in
 *     UNTRACKED_COMPANIES so the UI can be upfront about the gap instead of
 *     silently omitting them.
 *
 * Like news-scan.js, this now accumulates rather than fully resyncing: a
 * role no longer returned by a company's ATS is marked closed (status:
 * 'closed', closedDate set) but stays visible in the live list for
 * ARCHIVE_AGE_DAYS — only after a role has been closed for a full month
 * does it move out to ARCHIVE_FILE. This was a deliberate fix: the old
 * full-resync-every-run behavior dropped a role from the UI the instant a
 * company's ATS stopped listing it (even a same-day repost gap), which
 * both under-counted real opportunities and gave an account manager no
 * chance to still see/reference a role they'd already started on. A role
 * that reappears in the ATS after being marked closed is un-closed
 * (status back to 'open', closedDate cleared) rather than treated as new.
 * foundDate/lastSeenDate are preserved across runs for a role that's still
 * open, so "open since"/"last confirmed" stay visible.
 *
 * salary/applicationDeadline are best-effort text extraction (see
 * extractSalary/extractDeadline) from whatever description text is
 * available for a role that already passed the location/role filters —
 * most postings don't have a hard application deadline at all (rolling/
 * open-until-filled is the norm), and salary disclosure depends on the
 * company and jurisdiction, so both are frequently null. That's an honest
 * "not stated," not a bug.
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
const ARCHIVE_FILE = 'data/archive/competitor-jobs.json';

// ── Private "roles for you" feed ──────────────────────────────────────────
// A shortlist for the person who runs this CRM, not competitor intelligence:
// roles at the tracked competitors that they could actually take — anywhere in
// the three territories they cover, or genuinely remote-eligible. Written to
// its own file and surfaced on a dashboard card only their account can see.
// Never written to disk in this repo: it goes to Supabase, behind RLS.
const PERSONAL_OWNER = 'venturino.dino@gmail.com';
const PERSONAL_TABLE = 'personal_roles';
const SUPA_URL = 'https://cfhljbexesdrabmadpcc.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REGION = 'belgium';
// All three covered territories, because the shortlist is the person's, not
// this repo's region.
const PERSONAL_PLACES = [
  ['Netherlands', /netherlands|nederland|amsterdam|utrecht|rotterdam|the hague|den haag|eindhoven|groningen|delft|leiden|maastricht|\bnld\b/i],
  ['Belgium',     /belgium|belgi[e\u00eb]|belgique|brussels|brussel|bruxelles|antwerp|antwerpen|ghent|\bgent\b|leuven|louvain|li[e\u00e8]ge|\bbel\b/i],
  ['Denmark',     /denmark|danmark|copenhagen|k[\u00f8o]benhavn|aarhus|odense|aalborg|\bdnk\b/i],
];
// Senior individual contributor or first-line manager carrying a quota.
// classifyRole() has already discarded everything non-commercial; this narrows
// what is left to the seniority band worth a move.
const PERSONAL_TITLE_RE = /\b(strategic|senior|key|enterprise|global|named|major|regional)?\s*account\s+(manager|director|executive|lead)\b|\baccount management\b|\bclient (director|partner|manager)\b|\bcustomer success manager\b|\bbusiness development (manager|director|lead)\b|\b(sales|commercial) (manager|director|lead|executive)\b|\b(channel|partner|partnership|alliance)s?\s*(manager|director|lead)\b|\bpartnerships lead\b|\brenewals? (manager|specialist)\b/i;
const PERSONAL_EXCLUDE_RE = /\b(intern|internship|graduate|apprentice|working student|sdr|bdr|sales development representative|engineer|developer|scientist|recruit\w*|editor|editorial)\b/i;
// Their own patch — research intelligence, scholarly publishing, libraries.
const PERSONAL_DOMAIN_RE = /research|academic|scholarly|librar|higher education|university|institutional|life science|pharma/i;

function personalFit(title, location) {
  if (!PERSONAL_TITLE_RE.test(title) || PERSONAL_EXCLUDE_RE.test(title)) return null;
  const loc = location || '';
  for (const [place, re] of PERSONAL_PLACES) if (re.test(loc)) return { place, remote: false };
  if (!/\bremote\b/i.test(loc) || NON_EUROPE_REMOTE_RE.test(loc)) return null;
  // "Remote, FRA | Remote, DEU" is a closed list of the countries the role can
  // actually be worked from. If it names countries and none of them is one of
  // ours, it is still worth knowing about but it cannot be taken from here.
  const named = loc.split('|').map(s => s.trim()).filter(l => /^remote,/i.test(l));
  const reachable = !named.length || named.some(l => PERSONAL_PLACES.some(([, re]) => re.test(l)));
  return { place: 'Remote', remote: true, reachable };
}
// A closed role lingers in the live list for a full month before moving to
// the archive — see the file header for why. Kept in sync with
// news-scan.js's ARCHIVE_AGE_DAYS concept, just a longer window: a closed
// job posting is still useful reference material for a month (was the AM
// already in conversation with someone there?), unlike a week-old news story.
const ARCHIVE_AGE_DAYS = 30;
const REQUEST_TIMEOUT_MS = 20000;

// Belgium-or-remote location match. Deliberately not widened to "any
// European country/city" — that surfaces roles based in London, Berlin,
// Paris, etc that have nothing to do with Belgium specifically (confirmed
// as a real problem on the Netherlands sibling app's identical feature). The
// two things that actually matter here: the role is based in Belgium, or
// it's remote (and therefore fillable from Belgium) — not "somewhere in
// Europe" generally. A bare "EMEA"/"Europe" location with no "remote"
// qualifier is deliberately NOT matched, since that names a whole region,
// not Belgium. Covers both national languages (Dutch/French) plus the
// English forms these ATSes actually use.
const BE_CITY_COUNTRY_RE = /belgium|belgie|belgië|belgique|brussels|brussel|bruxelles|antwerp|antwerpen|ghent|\bgent\b|leuven|louvain|liege|liège|charleroi|bruges|brugge|namur|\bmons\b|hasselt|kortrijk|\bbe\b|\bbel\b/i;

// A bare "remote" match is not enough on its own: ATS location fields almost
// always pair "Remote" with a specific country ("Remote, United States of
// America", "Australia, Remote") or a closed list of specific eligible
// countries that may not include Belgium at all — a globally-remote US or
// Australian role, or one remote-eligible only from France/Germany/Spain/UK,
// has nothing to do with Belgium. Only exclude on an explicit non-European
// qualifier; a bare "Remote" with no country named, or one paired with
// Belgium/EMEA/Europe/another EU country, still passes — see
// isTrackedLocation() and the closed-enumerated-list check in main() for the
// second case. Same exclusion list as the Netherlands sibling app (country
// names, ISO codes, and major non-Europe hub cities) — this class of false
// positive doesn't depend on which EU country is being tracked.
const NON_EUROPE_REMOTE_RE = /united states|\bu\.?s\.?a?\.?\b|canada|australia|new zealand|\bapac\b|\blatam\b|brazil|mexico|argentina|colombia|\bindia\b|china|japan|singapore|hong kong|south korea|philippines|indonesia|vietnam|thailand|malaysia|south africa|nigeria|kenya|\buae\b|united arab emirates|saudi arabia|\bisrael\b|\bidn\b|\busa\b|\baus\b|\bnzl\b|\bcan\b|\bbra\b|\bmex\b|\bind\b|\bchn\b|\bjpn\b|\bkor\b|\bsgp\b|\bphl\b|\bvnm\b|\btha\b|\bmys\b|\bzaf\b|\bnga\b|\bken\b|\bare\b|\bsau\b|san francisco|silicon valley|new york|\bnyc\b|los angeles|chicago|boston|seattle|austin|denver|atlanta|washington,? d\.?c\.?|toronto|vancouver|montreal|sydney|melbourne|tokyo|bangalore|bengaluru|mumbai|new delhi|shanghai|beijing|shenzhen|seoul|manila|jakarta/i;

function isTrackedLocation(location) {
  const loc = location || '';
  if (BE_CITY_COUNTRY_RE.test(loc)) return true;
  return /\bremote\b/i.test(loc) && !NON_EUROPE_REMOTE_RE.test(loc);
}

// Role families that get their own named category, for a sales agent
// tracking competitor go-to-market and customer-facing headcount:
// Strategic/Senior Account Management, Sales Development (SDR/BDR outbound
// prospecting), Renewals, Channel/Partnerships, and the full customer-
// lifecycle line (Customer Success, pre-sales/solution consulting,
// implementation/onboarding, technical/product support, customer service &
// licence admin, training & customer education, usage/reporting analytics,
// and product marketing). A role that doesn't match one of these named
// categories is not shown — this list is deliberately the specific set of
// roles being tracked, not a general "any hiring at a competitor" feed.
// All of these match the bare noun phrase (or an explicit reversed-order
// alternative) rather than a fixed "noun + level-word" suffix — confirmed
// live that real titles put the level word before the department just as
// often as after ("Director, Field Marketing" vs "Field Marketing
// Director"), and a fixed-suffix-only regex was silently dropping real
// matches in every single category tested. Each bare phrase was checked
// against real non-GTM titles (engineering, research, finance, HR) pulled
// from live ATS data to confirm it doesn't over-match.
const SAM_TITLE_RE = /\b(strategic account(s)?|key account(s)?|enterprise account(s)?|senior account(s)?|regional sales|account (manager|executive|director))\b/i;
const SDR_TITLE_RE = /\b(sales development rep(resentative)?|business development rep(resentative)?|inside sales (rep(resentative)?|executive)|sdr|bdr)\b/i;
// Renewals is its own line of work at most of these companies (a
// subscription/licence business needs dedicated headcount just to retain
// existing accounts) and is a natural adjacent role for an Elsevier account
// manager — checked before SAM so a "Renewal Account Manager" (a real,
// observed title) lands in renewals rather than the broader SAM bucket.
const RENEWALS_TITLE_RE = /\brenewal(s)?\s*(manager|specialist|representative|executive|account manager)\b/i;
const CSM_TITLE_RE = /\b(customer success|client success)\b/i;
const CHANNEL_TITLE_RE = /\b(channel (manager|director|sales|partnerships?)|partnership(s)?|alliance(s)?|business development)\b/i;
const PRESALES_TITLE_RE = /\b(customer consultant|solutions? consult(ant|ing)|pre-?sales|sales engineer)\b/i;
const IMPLEMENTATION_TITLE_RE = /\b(implementation|onboarding)\b/i;
const SUPPORT_TITLE_RE = /\b(technical support|product support|support analyst)\b/i;
const SERVICE_TITLE_RE = /\b(customer service|licen[cs]e administrator|licen[cs]ing administrator)\b/i;
const TRAINING_TITLE_RE = /\b(training specialist|customer education|training (manager|lead|coordinator|director)|(manager|lead|coordinator|director)[,\s]+(of\s+)?training)\b/i;
const ANALYTICS_TITLE_RE = /\b(usage (&|and) reporting analyst|usage analyst|reporting analyst|usage \& reporting)\b/i;
const MARKETING_TITLE_RE = /\b(product marketing|market development manager|field marketing|customer marketing)\b/i;

// Once a title matches one of the role families above, exclude it if it's
// clearly scoped to a business line that doesn't compete with Elsevier's
// Research Intelligence / scholarly-publishing solutions — e.g. a
// diversified competitor's IP/patent, life-sciences-regulatory, or
// clinical-consulting arm. Title/department-only data means this is a
// best-effort keyword check, not a guarantee.
const NON_RESEARCH_VERTICAL_RE = /\b(patent|trademark|intellectual property|ip (services|management|licensing)|regulatory affairs|clinical trial|pharmacovigilance|drug safety|life sciences consulting)\b/i;

function classifyRole(title, department) {
  const text = `${title} ${department || ''}`;
  if (NON_RESEARCH_VERTICAL_RE.test(text)) return null;
  if (RENEWALS_TITLE_RE.test(title)) return 'renewals';
  if (SAM_TITLE_RE.test(title)) return 'sam';
  // SDR/BDR checked before the broader CHANNEL "business development" match
  // so a "Business Development Representative" — an outbound prospecting
  // role, not a partnerships role — lands in sdr, not channel.
  if (SDR_TITLE_RE.test(title)) return 'sdr';
  if (CSM_TITLE_RE.test(title)) return 'csm';
  if (CHANNEL_TITLE_RE.test(title)) return 'channel';
  if (PRESALES_TITLE_RE.test(title)) return 'presales';
  if (IMPLEMENTATION_TITLE_RE.test(title)) return 'implementation';
  if (SUPPORT_TITLE_RE.test(title)) return 'support';
  if (SERVICE_TITLE_RE.test(title)) return 'service';
  if (TRAINING_TITLE_RE.test(title)) return 'training';
  if (ANALYTICS_TITLE_RE.test(title)) return 'analytics';
  if (MARKETING_TITLE_RE.test(title)) return 'marketing';
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
function isOlderThanDays(dateStr, days) {
  if (!dateStr) return false; // no date info — keep it live rather than guess
  const d = new Date(dateStr);
  if (isNaN(d)) return false;
  return (Date.now() - d.getTime()) / 86400000 > days;
}

// Best-effort text extraction — most ATS postings simply don't carry
// structured salary/deadline fields, so this looks for common phrasing in
// whatever description text is available and returns null rather than
// guessing when nothing matches. Salary catches currency-amount ranges and
// "OTE" (on-target earnings — the standard way sales-role total comp,
// including commission, is quoted). Deadline catches explicit
// apply-by/closing-date phrasing; most tech-sales roles are "open until
// filled" with no deadline at all, so null here is the common, correct case.
function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
function extractSalary(html) {
  const text = stripHtml(html);
  if (!text) return null;
  const m = text.match(/(?:salary|compensation|base pay|OTE|on-target earnings)[^.\n]{0,40}?([€£$]\s?\d[\d.,]*\s?[kK]?(?:\s?(?:-|–|to)\s?[€£$]?\s?\d[\d.,]*\s?[kK]?)?(?:\s?(?:per|\/)\s?(?:year|annum|yr))?)/i)
    || text.match(/([€£$]\s?\d{2,3}[,.]\d{3}(?:\s?(?:-|–)\s?[€£$]?\s?\d{2,3}[,.]\d{3})?)/);
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 80) : null;
}
function extractDeadline(html) {
  const text = stripHtml(html);
  if (!text) return null;
  const m = text.match(/(?:apply by|application deadline|applications close|closing date|deadline for applications)[:\s]{0,10}(?:on |of )?([A-Za-z0-9,./ -]{4,30})/i);
  return m ? m[1].trim().replace(/[.,]$/, '').slice(0, 60) : null;
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
    descriptionHtml: j.content || '',
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
  // Confirmed live shape (2026-09-02): { data: [...] }, not { postings }
  // or { jobs } — those two were guessed at build time and never actually
  // matched, so this fetch silently returned zero jobs on every run.
  const list = Array.isArray(data) ? data : (data.data || data.postings || data.jobs || []);
  return list.map(p => ({
    company,
    title: String(p.title || '').trim(),
    location: (p.location && (p.location.name || p.location)) || p.location_name || '',
    // Confirmed live shape: department lives at job.department.name, not a
    // top-level field — the old fallback always came back blank.
    department: (p.job && p.job.department && p.job.department.name) || (p.department && (p.department.name || p.department)) || '',
    url: p.url || p.absolute_url || '',
    postedDate: toISODate(p.published_at || p.created_at),
    source: 'Pinpoint',
    // Pinpoint's list endpoint doesn't document a guaranteed description
    // field — take whatever's present defensively rather than a second
    // per-posting fetch to an unconfirmed detail endpoint.
    descriptionHtml: p.description || p.content || p.description_html || '',
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
        // No description AND no reliable location in the list response —
        // Workday's list-level locationsText is often a bare internal region
        // code with no country ("517- Victoria", confirmed live on the
        // Netherlands sibling app to actually be Australia) or an unhelpful
        // "N Locations" placeholder — see fetchWorkdayJobDetail() below,
        // called for every role-matching Workday posting (title checked
        // first, before this fetch, so this never runs for the large
        // majority of postings that aren't a tracked GTM role at all).
        workdayDetail: j.externalPath ? { base, tenant, site, externalPath: j.externalPath } : null,
      });
    }
    if (postings.length < limit) break;
    offset += limit;
  }
  return jobs;
}

// Workday CXS job-detail endpoint — GET (not POST, unlike the list search)
// returns the full posting: description HTML, plus a resolved location and
// a real country descriptor that the list endpoint never provides (see the
// comment on `workdayDetail` above). Only called for jobs whose title
// already matched a tracked GTM role category — never for the full
// unfiltered per-company list — so this stays a handful of calls per
// company per run, not one per open role. externalPath from the list
// response already starts with "/job/..." — confirmed live (2026-09-05) that
// prepending another literal "/job" segment double-nests the path and the
// endpoint 422s on every single request. No extra segment needed.
async function fetchWorkdayJobDetail({ base, tenant, site, externalPath }) {
  const data = await fetchJSON(`${base}/wday/cxs/${tenant}/${site}${externalPath}`);
  const info = data.jobPostingInfo || {};
  return {
    description: info.jobDescription || '',
    location: info.location || '',
    country: (info.country && info.country.descriptor) || '',
    additionalLocations: Array.isArray(info.additionalLocations) ? info.additionalLocations : [],
  };
}

// Every company already tracked elsewhere in this app as an Elsevier
// competitor (e.g. in news-scan.js's Competitor Announcements) that also has
// a usable public ATS API gets scanned here — this used to be narrowed
// further to only the 3 companies selling a product that directly competes
// with a named Elsevier RI solution (Scopus, SciVal, Pure, Insight Graph,
// 4GU reports, Digital Commons), but that hid real, live, Belgium/remote-
// relevant roles at companies like Anthropic simply because their core
// product isn't a Scopus/SciVal-type tool (confirmed as a real gap on the
// Netherlands sibling app's identical feature). Broad competitive/hiring
// intel on any of these companies is useful regardless of exactly which
// Elsevier product they compete with.
//   - Clarivate: Web of Science (Scopus), InCites (SciVal), Converis (Pure)
//   - Digital Science: Dimensions (Scopus/SciVal), Figshare (Digital
//     Commons), Symplectic Elements (Pure)
//   - Allen Institute for AI: Semantic Scholar (Scopus's discovery/
//     citation-graph function)
//   - Springer Nature, Wiley: publishers competing more broadly
//   - OpenAI, Anthropic, Elicit: AI tools competing with Elsevier's
//     AI-assisted research products
// Endpoints below verified by hand (see git history for the research this
// was built from; do not guess new endpoints without verifying the same
// way) — see UNTRACKED_COMPANIES for the companies with no usable API found.
const SOURCES = [
  { company: 'Digital Science', fetch: () => fetchPinpoint('Digital Science', 'digitalscience') },
  { company: 'Allen Institute for AI', fetch: () => fetchGreenhouse('Allen Institute for AI', 'thealleninstitute') },
  { company: 'Clarivate', fetch: () => fetchWorkday('Clarivate', 'wd3', 'clarivate', 'Clarivate_Careers') },
  { company: 'Springer Nature', fetch: () => fetchWorkday('Springer Nature', 'wd3', 'springernature', 'SpringerNatureCareers') },
  { company: 'Wiley', fetch: () => fetchWorkday('Wiley', 'wd1', 'wiley', 'wiley_careers') },
  { company: 'OpenAI', fetch: () => fetchAshby('OpenAI', 'openai') },
  { company: 'Anthropic', fetch: () => fetchGreenhouse('Anthropic', 'anthropic') },
  { company: 'Elicit', fetch: () => fetchAshby('Elicit', 'elicit') },
];

// Companies with no usable public API found — surfaced in scan state so the
// UI can be upfront about the gap instead of silently omitting them.
const UNTRACKED_COMPANIES = [
  { company: 'scite', reason: 'Not currently hiring (applications by email)', url: 'https://scite.ai/jobs' },
  { company: 'Consensus', reason: 'Roles posted only to LinkedIn, no ATS board found', url: 'https://consensus.app/home/careers/' },
  { company: 'SciSpace', reason: 'No formal careers-page ATS found (Ashby/Greenhouse/Lever all checked)', url: 'https://typeset.io/careers' },
  { company: 'Paperguide', reason: 'No formal careers page/ATS (small team, hires ad hoc via LinkedIn)', url: 'https://linkedin.com/company/paperguideai' },
  { company: 'IGI Global Scientific Publishing', reason: 'Static list, applications by email', url: 'https://www.igi-global.com/about/staff/job-opportunities/' },
  { company: 'IEEE', reason: 'Oracle Taleo, session-based, no public JSON API', url: 'https://ieee.taleo.net/careersection/2/jobsearch.ftl' },
  { company: 'Google', reason: 'Proprietary/internal API, not public', url: 'https://careers.google.com/' },
];

// Hand the new roles to the workflow as a file outside the workspace, so the
// email step can read them without them ever being echoed or committed.
function writeRolesDigest(fresh) {
  const out = process.env.ROLES_DIGEST_PATH;
  if (!out || !fresh.length) return;
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const row = r => `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb">
        <a href="${esc(r.url)}" style="color:#0f172a;font-weight:600;text-decoration:none">${esc(r.title)}</a>
        <div style="color:#64748b;font-size:13px;margin-top:3px">${esc(r.company)} &middot; ${esc(r.place)}${r.reachable ? '' : ' &middot; <span style="color:#b91c1c">not open from your countries</span>'}${r.domain_match ? ' &middot; <span style="color:#4338ca">your domain</span>' : ''}</div>
        <div style="color:#94a3b8;font-size:12px;margin-top:2px">${esc(r.location)}</div>
      </td>
    </tr>`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px">
    <p style="font-size:15px;color:#0f172a">${fresh.length} new role${fresh.length === 1 ? '' : 's'} matching your profile:</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px">${fresh.map(row).join('')}</table>
    <p style="color:#94a3b8;font-size:12px;margin-top:14px">From the daily competitor hiring scan. The full shortlist lives on the Roles for You page in your CRM.</p>
  </div>`;
  try {
    writeFileSync(out, html, 'utf8');
  } catch (e) {
    console.warn(`[competitor-jobs] roles-for-you: could not write the digest — ${e.message}`);
  }
}

async function supaRequest(method, pathAndQuery, body) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: {
      apikey: SUPA_SERVICE_KEY,
      Authorization: `Bearer ${SUPA_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'resolution=merge-duplicates,return=representation' : 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${pathAndQuery}: ${res.status} ${await res.text()}`);
  return method === 'POST' ? res.json() : null;
}

async function pushPersonalRoles(roles, today) {
  // Only the repo that sets PERSONAL_SHORTLIST maintains the list. It searches
  // all three territories regardless of which repo it runs in, so one owner is
  // full coverage — and the row id is company+url, which three concurrent
  // scans would otherwise overwrite each other on.
  if (process.env.PERSONAL_SHORTLIST !== '1') return;
  if (!SUPA_SERVICE_KEY) {
    console.warn('[competitor-jobs] roles-for-you: SUPABASE_SERVICE_ROLE_KEY not set — skipping the private shortlist.');
    return;
  }
  try {
    const existing = await (await fetch(
      `${SUPA_URL}/rest/v1/${PERSONAL_TABLE}?select=id,first_seen&owner_email=eq.${encodeURIComponent(PERSONAL_OWNER)}&region=eq.${REGION}`,
      { headers: { apikey: SUPA_SERVICE_KEY, Authorization: `Bearer ${SUPA_SERVICE_KEY}` } })).json();
    const firstSeenById = new Map((existing || []).map(r => [r.id, r.first_seen]));

    const rows = roles.map(r => ({
      id: r.id,
      owner_email: PERSONAL_OWNER,
      company: r.company,
      title: r.title,
      location: r.location,
      place: r.place,
      reachable: r.reachable,
      domain_match: r.domainMatch,
      role_category: r.roleCategory,
      url: r.url,
      posted_date: r.postedDate,
      source: r.source,
      region: REGION,
      first_seen: firstSeenById.get(r.id) || today,
      last_seen: today,
      updated_at: new Date().toISOString(),
    }));
    if (rows.length) await supaRequest('POST', PERSONAL_TABLE, rows);

    // Anything we no longer see is off the market — drop it.
    const keep = new Set(rows.map(r => r.id));
    const stale = [...firstSeenById.keys()].filter(id => !keep.has(id));
    if (stale.length) {
      const list = stale.map(encodeURIComponent).join(',');
      await supaRequest('DELETE', `${PERSONAL_TABLE}?id=in.(${list})&owner_email=eq.${encodeURIComponent(PERSONAL_OWNER)}`);
    }
    // Counts only. Actions logs are public on a public repo, so naming the
    // roles here would undo the whole reason this list is not a file in it.
    const fresh = rows.filter(r => r.first_seen === today);
    console.log(`[competitor-jobs] roles-for-you: ${rows.length} on the shortlist, ${fresh.length} new, ${stale.length} removed.`);
    writeRolesDigest(fresh);
  } catch (e) {
    // Never fail the whole scan over the private extra.
    console.warn(`[competitor-jobs] roles-for-you: could not sync to Supabase — ${e.message}`);
  }
}

async function main() {
  const existing = readJSON(DATA_FILE, []);
  const existingByKey = new Map(existing.map(j => [j.company + '|' + j.url, j]));
  const today = new Date().toISOString().slice(0, 10);

  const seenThisRun = new Map(); // key -> freshly-built job record
  const personalSeen = new Map(); // key -> role for the private shortlist
  const perCompanyCounts = {};
  const errors = {};

  for (const src of SOURCES) {
    try {
      const jobs = await src.fetch();
      perCompanyCounts[src.company] = { total: jobs.length, beOrRemote: 0 };
      for (const j of jobs) {
        if (!j.title || !j.url) continue;
        const roleCategory = classifyRole(j.title, j.department);
        if (!roleCategory) continue; // excluded business vertical (patent/IP/clinical-regulatory etc) — see NON_RESEARCH_VERTICAL_RE

        // Workday's list response gives no reliable location (see
        // workdayDetail comment above) — for a role that already matches a
        // tracked category, fetch the real detail first so the location
        // check runs against an actual country, not a bare internal region
        // code or an unhelpful "N Locations" placeholder. Non-Workday
        // sources already carry a usable location string from their list
        // fetch, so this only adds a request for Workday-sourced candidates.
        let displayLocation = j.location;
        let personalLocation = j.location;
        let matchLocation = j.location;
        let descriptionHtml = j.descriptionHtml || '';
        if (j.workdayDetail) {
          try {
            const detail = await fetchWorkdayJobDetail(j.workdayDetail);
            descriptionHtml = detail.description || descriptionHtml;
            displayLocation = detail.country ? `${detail.location || j.location} — ${detail.country}` : (detail.location || j.location);
            matchLocation = [displayLocation, ...detail.additionalLocations].filter(Boolean).join(' | ');
            // Captured before the Netherlands-only override below can blank
            // matchLocation out — the personal feed wants the full picture.
            personalLocation = matchLocation;

            // additionalLocations is sometimes a CLOSED enumerated list of
            // specific remote-eligible countries ("Remote, FRA" / "Remote,
            // DEU" / "Remote, ESP" / "Remote, GBR") rather than an open-ended
            // "remote, Europe" — confirmed live (2026-09-11) on a Wiley
            // posting remote-eligible from exactly those four countries,
            // none of which is Belgium, even though every one of them is
            // European and so none trips NON_EUROPE_REMOTE_RE. When every
            // remote entry names a specific country and none names Belgium,
            // the role genuinely can't be filled from Belgium no matter how
            // "European" the list looks overall — this overrides the
            // generic bare-remote-not-excluded rule.
            const remoteEntries = detail.additionalLocations.filter(l => /^remote,/i.test(l));
            if (remoteEntries.length && remoteEntries.length === detail.additionalLocations.length
                && !BE_CITY_COUNTRY_RE.test(displayLocation)
                && !remoteEntries.some(l => BE_CITY_COUNTRY_RE.test(l))) {
              matchLocation = '';
            }
          } catch (e) {
            console.warn(`[competitor-jobs] Could not fetch job detail for "${j.title}" (${j.company}): ${e.message} — falling back to the list location text for this role.`);
          }
        }
        const fit = personalFit(j.title, personalLocation);
        if (fit) personalSeen.set(j.company + '|' + j.url, {
          id: makeId(j.company, j.url),
          company: j.company,
          title: j.title.slice(0, 200),
          location: String(personalLocation || j.location || '').slice(0, 220),
          place: fit.place,
          reachable: fit.remote ? fit.reachable !== false : true,
          domainMatch: PERSONAL_DOMAIN_RE.test(j.title),
          roleCategory,
          url: j.url.slice(0, 500),
          postedDate: j.postedDate,
          source: j.source,
        });
        if (!isTrackedLocation(matchLocation)) continue;
        perCompanyCounts[src.company].beOrRemote++;
        const key = j.company + '|' + j.url;
        const prior = existingByKey.get(key);

        seenThisRun.set(key, {
          id: makeId(j.company, j.url),
          company: j.company,
          title: j.title.slice(0, 200),
          location: String(displayLocation || j.location || '').slice(0, 150),
          department: String(j.department || '').slice(0, 100),
          roleCategory,
          url: j.url.slice(0, 500),
          postedDate: j.postedDate,
          foundDate: (prior && prior.foundDate) || today,
          lastSeenDate: today,
          status: 'open',
          closedDate: null,
          source: j.source,
          salary: extractSalary(descriptionHtml),
          applicationDeadline: extractDeadline(descriptionHtml),
        });
      }
      console.log(`[competitor-jobs] ${src.company}: ${jobs.length} open role(s), ${perCompanyCounts[src.company].beOrRemote} Belgium/remote tracked-role match(es)`);
    } catch (e) {
      errors[src.company] = e.message;
      console.warn(`[competitor-jobs] ${src.company} failed: ${e.message}`);
    }
  }

  // Merge freshly-seen roles with the existing live list rather than fully
  // resyncing — see the file header for why. A role missing from this run's
  // results is marked closed (or left closed if it already was) instead of
  // being dropped outright; a role that reappears after being marked closed
  // is un-closed. Only a company whose fetch itself failed this run (see
  // `errors` above) is exempted from closing its existing roles, since a
  // fetch failure means "unknown," not "confirmed gone."
  const live = [];
  const newlyArchived = [];
  let newCount = 0;
  let reopenedCount = 0;
  let closedCount = 0;
  for (const key of new Set([...existingByKey.keys(), ...seenThisRun.keys()])) {
    const fresh = seenThisRun.get(key);
    const prior = existingByKey.get(key);

    if (fresh) {
      if (!prior) newCount++;
      else if (prior.status === 'closed') reopenedCount++;
      live.push(fresh);
      continue;
    }

    // No longer returned by its company's ATS this run.
    const company = prior.company;
    if (errors[company]) { live.push(prior); continue; } // fetch failed — treat as unknown, not closed
    if (prior.status === 'closed') {
      if (isOlderThanDays(prior.closedDate, ARCHIVE_AGE_DAYS)) { newlyArchived.push(prior); continue; }
      live.push(prior);
    } else {
      closedCount++;
      live.push({ ...prior, status: 'closed', closedDate: today });
    }
  }

  if (newlyArchived.length) {
    const archive = readJSON(ARCHIVE_FILE, []);
    const archivedIds = new Set(archive.map(a => a.id));
    for (const a of newlyArchived) if (!archivedIds.has(a.id)) archive.unshift(a);
    saveJSON(ARCHIVE_FILE, archive);
  }

  live.sort((a, b) => (b.postedDate || b.foundDate || '').localeCompare(a.postedDate || a.foundDate || ''));
  saveJSON(DATA_FILE, live);

  // Private shortlist -> Supabase. first_seen is preserved by the upsert (the
  // column keeps its existing value because we only send it for rows we have
  // not seen before), so the dashboard can still say what is new. Roles that
  // drop off the boards are deleted: this is a live shortlist, not a record of
  // everything ever advertised. A missing service-role key is not an error —
  // the scan still does its main job, it just skips the private part.
  await pushPersonalRoles([...personalSeen.values()], today);

  saveJSON(STATE_FILE, {
    lastRun: new Date().toISOString(),
    totalOpenRoles: live.filter(j => j.status !== 'closed').length,
    totalListed: live.length,
    newCount,
    reopenedCount,
    closedCount,
    archivedCount: newlyArchived.length,
    perCompanyCounts,
    errors,
    untracked: UNTRACKED_COMPANIES,
    source: 'Company career-page ATS APIs (Greenhouse/Ashby/SmartRecruiters/Pinpoint/Workday) — not LinkedIn, see file header',
  });
  console.log(`[competitor-jobs] Done — ${live.length} Belgium/remote tracked role(s) listed (${newCount} new, ${reopenedCount} reopened, ${closedCount} newly closed, ${newlyArchived.length} archived) across ${SOURCES.length - Object.keys(errors).length}/${SOURCES.length} tracked companies.`);
}

main().catch(e => {
  console.error('[competitor-jobs] Failed:', e.message);
  try {
    saveJSON(STATE_FILE, { lastRun: new Date().toISOString(), totalOpenRoles: 0, error: e.message, untracked: UNTRACKED_COMPANIES });
  } catch { /* ignore */ }
  process.exit(1);
});
