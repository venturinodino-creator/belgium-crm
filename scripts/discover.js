/**
 * discover.js — Daily contact discovery scan.
 * Free, zero-Claude-cost: scrapes OpenAlex for researchers at each enabled
 * institution and constructs a plausible institutional email per contact
 * (OpenAlex itself never provides one), flagging it for manual verification.
 * Writes new candidates straight into Supabase's pending_contacts table
 * (requires SUPABASE_SERVICE_ROLE_KEY — RLS restricts inserts to admins,
 * which the service key bypasses). Run: node scripts/discover.js
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const PENDING_FILE = 'data/pending-contacts.json'; // local audit trail only — the app no longer reads this
const STATE_FILE   = 'data/discovery-state.json';
const CONFIG_FILE  = 'data/scrape-config.json';
const TARGET       = 20;

const SUPA_URL = 'https://cfhljbexesdrabmadpcc.supabase.co';
const SUPA_KEY = 'sb_publishable_PE2Yc0ivOT4F4fE80CXJUw_kbch9TpZ'; // publishable key — read-only here, safe to embed
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // required to write pending_contacts (RLS: insert requires is_admin())

// The admin sets scrape targets from the CRM's "New Contacts" page, which
// writes to this table. Falls back to the local CONFIG_FILE if Supabase is
// unreachable, so a scan never silently fails from a transient network issue.
async function fetchScrapeConfig() {
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/scrape_config?select=types&region=eq.belgium`, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    if (rows[0] && Array.isArray(rows[0].types) && rows[0].types.length) return rows[0].types;
  } catch (e) {
    console.warn('Could not fetch scrape_config from Supabase, falling back to local file:', e.message);
  }
  return null;
}

// Existing pending_contacts (any status) — used to dedup against what the
// service role key can see. RLS blocks the publishable key from reading this,
// so this always uses the service key.
async function fetchExistingPending() {
  if (!SUPA_SERVICE_KEY) return [];
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/pending_contacts?select=first,last,email&region=eq.belgium`, {
      headers: { apikey: SUPA_SERVICE_KEY, Authorization: `Bearer ${SUPA_SERVICE_KEY}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn('Could not fetch existing pending_contacts:', e.message);
    return [];
  }
}

async function insertPendingContacts(rows) {
  if (!rows.length) return 0;
  if (!SUPA_SERVICE_KEY) {
    console.warn('SUPABASE_SERVICE_ROLE_KEY not set — skipping Supabase insert (add it as a GitHub Actions secret).');
    return 0;
  }
  const res = await fetch(`${SUPA_URL}/rest/v1/pending_contacts`, {
    method: 'POST',
    headers: {
      apikey: SUPA_SERVICE_KEY,
      Authorization: `Bearer ${SUPA_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase insert failed: HTTP ${res.status} ${body}`);
  }
  return rows.length;
}

// ── Institution definitions by type ────────────────────────────────────────
// emailDomain is used to construct a plausible (unverified) email since
// OpenAlex never provides one — flagged in `notes` for the user to confirm.
const INSTITUTIONS = {
  research: [
    { key: 'imec', name: 'imec', instId: 'imec', dept: 'Scientific Research', emailDomain: 'imec-int.com' },
    { key: 'vib', name: 'VIB (Vlaams Instituut voor Biotechnologie)', instId: 'vib', dept: 'Scientific Research', emailDomain: 'vib.be' },
    { key: 'flandersmake', name: 'Flanders Make', instId: 'flandersmake', dept: 'Scientific Research', emailDomain: 'flandersmake.be' },
    { key: 'sciensano', name: 'Sciensano', instId: 'sciensano', dept: 'Scientific Research', emailDomain: 'sciensano.be' },
    { key: 'rbins', name: 'Royal Belgian Institute of Natural Sciences', instId: 'rbins', dept: 'Scientific Research', emailDomain: 'naturalsciences.be' },
    { key: 'rmi', name: 'Royal Meteorological Institute of Belgium', instId: 'rmi', dept: 'Scientific Research', emailDomain: 'meteo.be' },
    { key: 'rob', name: 'Royal Observatory of Belgium', instId: 'rob', dept: 'Scientific Research', emailDomain: 'astro.oma.be' },
    { key: 'solvay', name: 'International Solvay Institutes for Physics and Chemistry', instId: 'solvay', dept: 'Scientific Research', emailDomain: 'solvayinstitutes.be' },
    { key: 'vito', name: 'VITO (Flemish Institute for Technological Research)', instId: 'vito', dept: 'Scientific Research', emailDomain: 'vito.be' },
    { key: 'royalacademiesbelgium', name: 'Royal Academies for Science and the Arts of Belgium', instId: 'royalacademiesbelgium', dept: 'Scientific Research', emailDomain: 'academieroyale.be' },
    { key: 'bira', name: 'Royal Belgian Institute for Space Aeronomy', instId: 'bira', dept: 'Scientific Research', emailDomain: 'aeronomie.be' },
    { key: 'egmont', name: 'Egmont Institute (Royal Institute for International Relations)', instId: 'egmont', dept: 'Scientific Research', emailDomain: 'egmontinstitute.be' },
    { key: 'bruegel', name: 'Bruegel', instId: 'bruegel', dept: 'Scientific Research', emailDomain: 'bruegel.org' },
    { key: 'itinera', name: 'Itinera Institute', instId: 'itinera', dept: 'Scientific Research', emailDomain: 'itinerainstitute.org' },
  ],
  university: [
    { key: 'kuleuven', name: 'KU Leuven', instId: 'kuleuven', dept: 'Research', emailDomain: 'kuleuven.be' },
    { key: 'ugent', name: 'Ghent University', instId: 'ugent', dept: 'Research', emailDomain: 'ugent.be' },
    { key: 'uantwerpen', name: 'University of Antwerp', instId: 'uantwerpen', dept: 'Research', emailDomain: 'uantwerpen.be' },
    { key: 'vub', name: 'Vrije Universiteit Brussel', instId: 'vub', dept: 'Research', emailDomain: 'vub.be' },
    { key: 'uhasselt', name: 'Hasselt University', instId: 'uhasselt', dept: 'Research', emailDomain: 'uhasselt.be' },
    { key: 'uclouvain', name: 'UCLouvain', instId: 'uclouvain', dept: 'Research', emailDomain: 'uclouvain.be' },
    { key: 'uliege', name: 'Université de Liège', instId: 'uliege', dept: 'Research', emailDomain: 'uliege.be' },
    { key: 'ulb', name: 'Université libre de Bruxelles', instId: 'ulb', dept: 'Research', emailDomain: 'ulb.be' },
    { key: 'unamur', name: 'University of Namur', instId: 'unamur', dept: 'Research', emailDomain: 'unamur.be' },
    { key: 'umons', name: 'Université de Mons', instId: 'umons', dept: 'Research', emailDomain: 'web.umons.ac.be' },
  ],
  medical: [
    { key: 'uzleuven', name: 'UZ Leuven (University Hospitals Leuven)', instId: 'uzleuven', dept: 'Medical Research', emailDomain: 'uzleuven.be' },
    { key: 'uzgent', name: 'Ghent University Hospital', instId: 'uzgent', dept: 'Medical Research', emailDomain: 'uzgent.be' },
    { key: 'uza', name: 'Antwerp University Hospital', instId: 'uza', dept: 'Medical Research', emailDomain: 'uza.be' },
    { key: 'uzbrussel', name: 'UZ Brussel', instId: 'uzbrussel', dept: 'Medical Research', emailDomain: 'uzbrussel.be' },
    { key: 'chuliege', name: 'CHU de Liège', instId: 'chuliege', dept: 'Medical Research', emailDomain: 'chuliege.be' },
    { key: 'saintluc', name: 'Cliniques universitaires Saint-Luc', instId: 'saintluc', dept: 'Medical Research', emailDomain: 'saintluc.be' },
    { key: 'erasme', name: 'Hôpital Erasme', instId: 'erasme', dept: 'Medical Research', emailDomain: 'hopitalerasme.be' },
    { key: 'bordet', name: 'Institut Jules Bordet', instId: 'bordet', dept: 'Medical Research', emailDomain: 'bordet.be' },
    { key: 'chunamur', name: 'CHU UCL Namur (Godinne)', instId: 'chunamur', dept: 'Medical Research', emailDomain: 'chuuclnamur.be' },
  ],
  ngo: [
    { key: 'fwo', name: 'Research Foundation – Flanders', instId: 'fwo', dept: 'Research Funding', emailDomain: 'fwo.be' },
    { key: 'fnrs', name: 'F.R.S.-FNRS', instId: 'fnrs', dept: 'Research Funding', emailDomain: 'frs-fnrs.be' },
    { key: 'kbf', name: 'King Baudouin Foundation', instId: 'kbf', dept: 'Research Funding', emailDomain: 'kbs-frb.be' },
    { key: 'kotk', name: 'Kom op tegen Kanker', instId: 'kotk', dept: 'Research Funding', emailDomain: 'komoptegenkanker.be' },
    { key: 'fondationcontrelecancer', name: 'Fondation contre le Cancer / Stichting tegen Kanker', instId: 'fondationcontrelecancer', dept: 'Research Funding', emailDomain: 'cancer.be' },
  ],
};

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function saveJSON(path, data) {
  const dir = path.split('/').slice(0,-1).join('/');
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}
function makeId(key) {
  return `disc_${key}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
}
function slugifyNamePart(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase().replace(/[^a-z]/g, '');
}
function constructEmail(first, last, domain) {
  const f = slugifyNamePart(first), l = slugifyNamePart(last);
  if (!f || !l || !domain) return '';
  return `${f}.${l}@${domain}`;
}

async function get(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'NL-CRM-Bot/1.0 (mailto:venturino.dino@gmail.com)' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return r;
  } catch (e) { clearTimeout(timer); throw e; }
}

async function getJSON(url) {
  const r = await get(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}

async function getInstId(name) {
  const url = `https://api.openalex.org/institutions?search=${encodeURIComponent(name)}&per_page=1&mailto=venturino.dino@gmail.com`;
  const data = await getJSON(url);
  return data?.results?.[0]?.id || null;
}

async function scrapeOpenAlex(scraped, inst, needed) {
  const contacts = [];
  let oaId = scraped[`${inst.key}_oa_id`];
  if (!oaId) {
    oaId = await getInstId(inst.name);
    if (!oaId) { console.log(`  ⚠ Not found in OpenAlex: ${inst.name}`); return contacts; }
    scraped[`${inst.key}_oa_id`] = oaId;
  }
  const shortId = String(oaId).split('/').pop();
  const done = new Set(scraped[inst.key] || []);
  const page = scraped[`${inst.key}_page`] || 1;
  const cacheKey = `p${page}`;
  if (done.has(cacheKey)) { console.log(`  ↩ ${inst.name} page ${page} already done`); return contacts; }
  const url = `https://api.openalex.org/authors?filter=last_known_institutions.id:${shortId}&per_page=10&page=${page}&mailto=venturino.dino@gmail.com`;
  console.log(`  → ${inst.name} page ${page}`);
  const data = await getJSON(url);
  done.add(cacheKey);
  scraped[inst.key] = [...done];
  if (data?.results?.length) {
    for (const author of data.results) {
      if (contacts.length >= needed) break;
      const full = (author.display_name || '').trim().replace(/\s+/g, ' ');
      const parts = full.split(' ');
      if (parts.length < 2) continue;
      const first = parts[0], last = parts.slice(1).join(' ');
      const orcid = author.orcid ? `ORCID: ${author.orcid}` : '';
      const email = constructEmail(first, last, inst.emailDomain);
      contacts.push({
        first, last, title: 'Researcher', dept: inst.dept, email,
        instId: inst.instId, instName: inst.name, source: author.id || url, research: orcid,
        constructed: !!email,
      });
    }
    scraped[`${inst.key}_page`] = page + 1;
    console.log(`  ✓ ${contacts.length} contacts from ${inst.name}`);
  } else {
    console.log(`  ✗ No results for ${inst.name} page ${page} (resetting)`);
    scraped[`${inst.key}_page`] = 1;
    scraped[inst.key] = [];
  }
  return contacts;
}

async function main() {
  // Read config — Supabase first (set from the CRM UI), local file as fallback
  const remoteTypes = await fetchScrapeConfig();
  const config = remoteTypes ? { types: remoteTypes } : readJSON(CONFIG_FILE, { types: ['research'] });
  console.log(remoteTypes ? 'Using scrape target from Supabase' : 'Using scrape target from local config file');
  const enabledTypes = new Set(Array.isArray(config.types) ? config.types : ['research']);
  console.log('Enabled institution types:', [...enabledTypes].join(', '));

  // Build list of institutions to scrape (deduplicated)
  const seen = new Set();
  const toScrape = [];
  for (const type of ['research','university','medical','ngo']) {
    if (!enabledTypes.has(type)) continue;
    for (const inst of INSTITUTIONS[type] || []) {
      if (!seen.has(inst.key)) { seen.add(inst.key); toScrape.push(inst); }
    }
  }
  console.log(`Scraping ${toScrape.length} institutions: ${toScrape.map(i=>i.key).join(', ')}`);

  const state = readJSON(STATE_FILE, { scraped: {}, lastRun: null });

  const existingPendingRemote = await fetchExistingPending();
  const localPending = readJSON(PENDING_FILE, []);
  const existingEmails = new Set(
    [...existingPendingRemote, ...localPending].map(c=>(c.email||'').toLowerCase().trim()).filter(Boolean)
  );
  const existingNames = new Set(
    [...existingPendingRemote, ...localPending].map(c=>((c.first||'')+' '+(c.last||'')).toLowerCase().trim())
  );

  const scraped = state.scraped || {};
  const contacts = [];

  // Distribute target evenly across institutions
  const perInst = Math.max(3, Math.ceil(TARGET / toScrape.length));

  for (const inst of toScrape) {
    if (contacts.length >= TARGET) break;
    try {
      const newOnes = await scrapeOpenAlex(scraped, inst, perInst);
      contacts.push(...newOnes);
    } catch (e) {
      console.error(`  Error scraping ${inst.name}:`, e.message);
    }
  }

  // Dedup — email required (constructed emails count), matching the app's rule
  // that unverified contacts still need a starting point for outreach.
  const toInsert = [];
  const localPendingOut = [...localPending];
  let skippedNoEmail = 0;
  for (const c of contacts) {
    const el = (c.email||'').toLowerCase().trim();
    const nl = ((c.first||'')+' '+(c.last||'')).toLowerCase().trim();
    if (!el) { skippedNoEmail++; continue; }
    if (existingEmails.has(el)) continue;
    if (existingNames.has(nl)) continue;
    // id is local-only (audit trail): pending_contacts.id is a Postgres uuid
    // column with its own default, and this disc_<key>_<ts>_<rand> format
    // isn't a valid uuid — sending it as the row's id makes every insert
    // fail with 22P02 ("invalid input syntax for type uuid"). Let Postgres
    // generate the real id and keep this one only in the local JSON file.
    const id = makeId(c.instId || 'xx');
    toInsert.push({
      first: c.first, last: c.last, title: c.title, department: c.dept,
      institution_id: c.instId, institution_name: c.instName, email: c.email,
      research: c.research, source_url: c.source,
      notes: c.constructed ? 'Email constructed — please verify' : '',
      status: 'pending',
      region: 'belgium',
    });
    localPendingOut.push({ ...c, id });
    existingEmails.add(el); existingNames.add(nl);
  }
  if (skippedNoEmail) console.log(`Skipped ${skippedNoEmail} contact(s) with no email address`);

  let added = 0;
  try {
    added = await insertPendingContacts(toInsert);
  } catch (e) {
    console.error('Supabase insert error:', e.message);
  }

  state.scraped  = scraped;
  state.lastRun  = new Date().toISOString();
  state.lastTypes = [...enabledTypes];
  state.lastAddedCount = added;

  saveJSON(STATE_FILE, state);
  saveJSON(PENDING_FILE, localPendingOut); // local audit trail only
  console.log(`Done — added ${added} new contacts to Supabase pending_contacts (found ${toInsert.length} candidates)`);
}

main().catch(e => { console.error(e); process.exit(1); });
