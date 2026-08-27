/**
 * extract-crm-data.js — pulls together everything the daily summary report
 * needs into one JSON blob, printed to stdout.
 *
 * Institutions/contacts are seeded as JS array literals directly inside
 * index.html (SEED_INSTITUTIONS / SEED_CONTACTS) rather than a data file, so
 * this extracts and evaluates just those two literals out of the page
 * source — same values the app itself renders with, no separate copy to
 * keep in sync.
 *
 * pending_contacts lives only in Supabase (writes require the service-role
 * key). When SUPABASE_SERVICE_ROLE_KEY is set (the daily workflow run) this
 * fetches the live table; otherwise it falls back to data/pending-contacts.json,
 * the local audit trail discover.js also writes on every scrape, and flags
 * the fallback so the report can footnote it.
 */
import { readFileSync } from 'fs';

const SUPA_URL = 'https://cfhljbexesdrabmadpcc.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function extractArrayLiteral(src, varName) {
  const marker = `const ${varName} = [`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`Could not find ${varName} in index.html`);
  const openBracket = start + marker.length - 1;
  let depth = 0, i = openBracket, inStr = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { i++; break; } }
  }
  const literal = src.slice(openBracket, i);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${literal};`)();
}

function extractObjectLiteral(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) return null;
  const openBrace = start + marker.length - 1;
  let depth = 0, i = openBrace, inStr = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const literal = src.slice(openBrace, i);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${literal};`)();
}

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

async function fetchLivePending() {
  if (!SUPA_SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/pending_contacts?select=id,first,last,institution_id,institution_name,department,created_at,status&region=eq.belgium`, {
      headers: { apikey: SUPA_SERVICE_KEY, Authorization: `Bearer ${SUPA_SERVICE_KEY}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error('Could not fetch live pending_contacts, falling back to local file:', e.message);
    return null;
  }
}

async function fetchLiveContacts() {
  if (!SUPA_SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/crm_contacts?select=id,status,priority,quality,inst_id&region=eq.belgium`, {
      headers: { apikey: SUPA_SERVICE_KEY, Authorization: `Bearer ${SUPA_SERVICE_KEY}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error('Could not fetch live crm_contacts, falling back to seed data:', e.message);
    return null;
  }
}

// crm_institutions in Supabase only ever holds admin edits/overrides (warmth,
// renewal date, contract value, products, ...) keyed by id — the master list
// lives in SEED_INSTITUTIONS. Same merge the app itself does client-side in
// load(), needed here so the report's warmth/renewals/pipeline sections
// reflect real data instead of always reading blank seed defaults.
async function fetchInstitutionOverrides() {
  if (!SUPA_SERVICE_KEY) return {};
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/crm_institutions?select=id,warmth,contract_value,renewal_date,products&region=eq.belgium`, {
      headers: { apikey: SUPA_SERVICE_KEY, Authorization: `Bearer ${SUPA_SERVICE_KEY}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    return Object.fromEntries(rows.map(r => [r.id, r]));
  } catch (e) {
    console.error('Could not fetch crm_institutions overrides:', e.message);
    return {};
  }
}

async function fetchOpportunities() {
  if (!SUPA_SERVICE_KEY) return [];
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/crm_opportunities?select=id,inst_id,name,stage,value,close_date&region=eq.belgium`, {
      headers: { apikey: SUPA_SERVICE_KEY, Authorization: `Bearer ${SUPA_SERVICE_KEY}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error('Could not fetch crm_opportunities:', e.message);
    return [];
  }
}

async function fetchInteractions() {
  if (!SUPA_SERVICE_KEY) return [];
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/crm_interactions?select=id,inst_id,contact_id,date,type&region=eq.belgium`, {
      headers: { apikey: SUPA_SERVICE_KEY, Authorization: `Bearer ${SUPA_SERVICE_KEY}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error('Could not fetch crm_interactions:', e.message);
    return [];
  }
}

async function main() {
  const html = readFileSync('index.html', 'utf8');
  const seedInstitutions = extractArrayLiteral(html, 'SEED_INSTITUTIONS');
  const instOverrides = await fetchInstitutionOverrides();
  const institutions = seedInstitutions.map(seed => {
    const o = instOverrides[seed.id];
    if (!o) return seed;
    return {
      ...seed,
      warmth: o.warmth || '',
      contractValue: o.contract_value != null ? o.contract_value : null,
      renewalDate: o.renewal_date || '',
      products: o.products || '',
    };
  });
  const seedContacts = extractArrayLiteral(html, 'SEED_CONTACTS').filter(c => c.quality === 'verified');
  // Per-institution Elsevier (Scopus/SciVal/Pure) vs Clarivate (Web of
  // Science) subscription status — same object the Competitor Matrix page
  // renders from, reused here so the daily report's charts reflect real
  // subscription intelligence instead of a generic CRM metric.
  const competitorMatrix = extractObjectLiteral(html, 'window.COMP_DATA = {') || {};

  const liveContacts = await fetchLiveContacts();
  const contactsSource = liveContacts ? 'supabase' : 'seed';
  const contacts = (liveContacts || seedContacts).map(c => ({
    id: c.id, instId: c.inst_id || c.instId || '',
    status: c.status || 'active', priority: c.priority || 'medium',
    quality: c.quality || 'verified',
  }));

  const opportunitiesRaw = await fetchOpportunities();
  const opportunities = opportunitiesRaw.map(o => ({
    id: o.id, instId: o.inst_id, name: o.name || '',
    stage: o.stage || 'prospect', value: o.value != null ? Number(o.value) : 0,
    closeDate: o.close_date || '',
  }));

  const interactionsRaw = await fetchInteractions();
  const interactions = interactionsRaw.map(n => ({
    id: n.id, instId: n.inst_id, contactId: n.contact_id || '',
    date: n.date || '', type: n.type || 'other',
  }));

  const livePending = await fetchLivePending();
  const localPending = readJSON('data/pending-contacts.json', []);
  const pendingSource = livePending ? 'supabase' : 'local-audit-trail';
  const rawPending = livePending
    ? livePending.filter(c => (c.status || 'pending') === 'pending')
    : localPending;
  // Normalize the two shapes (Supabase snake_case vs local audit trail) so
  // the report generator doesn't need to know which source it came from.
  const pending = rawPending.map(c => ({
    id: c.id, first: c.first || '', last: c.last || '',
    instId: c.institution_id || c.instId || '',
    instName: c.institution_name || c.instName || '',
    dept: c.department || c.dept || '',
    createdAt: c.created_at || null,
  }));

  const news = readJSON('data/news.json', []);
  const tenders = readJSON('data/tenders.json', []);
  const competitors = readJSON('data/leapspace-competitors.json', []);
  const openalexSubs = readJSON('data/openalex-subscriptions.json', []);
  const discoveryState = readJSON('data/discovery-state.json', {});
  const newsScanState = readJSON('data/news-scan-state.json', {});

  const out = {
    generatedAt: new Date().toISOString(),
    institutions,
    competitorMatrix,
    contacts,
    contactsSource,
    opportunities,
    interactions,
    pending,
    pendingSource,
    news,
    tenders,
    competitors,
    openalexSubs,
    discoveryState,
    newsScanState,
  };

  process.stdout.write(JSON.stringify(out));
}

main().catch(e => { console.error(e); process.exit(1); });
