#!/usr/bin/env node
/**
 * discover-roles.js — Role-targeted contact discovery.
 *
 * discover-staff.js reads a fixed set of staff-directory pages and has, by
 * now, harvested everyone on them. This agent goes the other way round: for
 * each tracked institution it asks Claude, with web search, who currently
 * holds the roles a research-intelligence sale actually runs through —
 * vice-rector for research, e-resources/collections, research support and
 * grants, CIO/CISO/DPO, procurement, deans and research-group leads,
 * research integrity and doctoral schools, AI/digital strategy, research
 * support librarians — and files the people it can evidence into the same
 * pending_contacts review queue.
 *
 * It works through the region's institutions in a rotating batch (BATCH per
 * run, cursor kept in data/roles-scan-state.json), so a daily run covers the
 * whole territory every week or two without one giant API bill per day.
 *
 * Requires ANTHROPIC_API_KEY and SUPABASE_SERVICE_ROLE_KEY. Both missing is
 * reported, not fatal, so the workflow stays green and the state file says
 * why nothing happened.
 *
 * Flags:  --batch N   institutions this run (default 6)
 *         --inst IDS  only these institution ids, comma-separated (ignores the cursor)
 *         --dry-run   search and print, insert nothing
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const REGION = 'belgium';
const COUNTRY = 'Belgium';
const STATE_FILE = 'data/roles-scan-state.json';
const AUDIT_FILE = 'data/pending-role-contacts.json'; // local audit trail only
const SOURCES_FILE = 'data/staff-sources.json';       // for emailDomain hints
const SUPA_URL = 'https://cfhljbexesdrabmadpcc.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-opus-5';
const MAX_SEARCHES = 10;

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] ? args[i + 1] : dflt; };
const BATCH = Math.max(1, parseInt(flag('--batch', '6'), 10) || 6);
const ONLY_INST = flag('--inst', '').split(',').map(s => s.trim()).filter(Boolean);
const DRY_RUN = args.includes('--dry-run');

// The role families, in the words the institution itself is likely to use.
// Each entry is what the model is asked to find; the key is what lands in the
// queue's department field so the reviewer can sort by it.
const ROLE_FAMILIES = [
  ['Vice-Rector / Pro-Rector Research', 'vice-rector, pro-rector or vice-president for research; NL: vicerector / rector magnificus portefeuille onderzoek; DK: prorektor for forskning; FR: vice-recteur à la recherche'],
  ['E-resources / Collections', 'head or manager of e-resources, electronic resources, collections or acquisitions at the university library; NL: collectiemanager / e-resources; DK: samlingschef; FR: responsable des collections / ressources électroniques'],
  ['Research Support / Grants Office', 'head of research support, grants office, research services, funding office or valorisation; NL: hoofd research support / subsidies; DK: forskningsstøtte / fundraising; FR: appui à la recherche / cellule projets'],
  ['CIO', 'chief information officer, IT director or head of IT / digital services; NL: directeur ICT; DK: it-direktør / it-chef; FR: directeur informatique / DSI'],
  ['CISO / Information Security', 'chief information security officer or information security officer; NL: CISO / informatiebeveiliging; DK: informationssikkerhedschef; FR: RSSI'],
  ['DPO / Legal Counsel', 'data protection officer or head of legal affairs / general counsel; NL: functionaris gegevensbescherming / jurist; DK: databeskyttelsesrådgiver / juridisk chef; FR: délégué à la protection des données / juriste'],
  ['Procurement', 'head of procurement or purchasing, procurement officer for IT and library contracts; NL: hoofd inkoop; DK: indkøbschef; FR: responsable des achats'],
  ['Dean / Research Group Lead', 'deans of faculties and heads of large research groups, institutes or departments; NL: decaan; DK: dekan / institutleder; FR: doyen'],
  ['Research Integrity / Doctoral School', 'research integrity officer, ombudsperson for research, or director of the doctoral / graduate school; NL: vertrouwenspersoon wetenschappelijke integriteit / graduate school; DK: forskerskole / ph.d.-skoleleder; FR: intégrité scientifique / école doctorale'],
  ['AI Taskforce / Digital Strategy', 'lead of the AI taskforce, AI centre, digital strategy or digitalisation programme; NL: digitale strategie / AI-lead; DK: digitaliseringschef / AI-ansvarlig; FR: stratégie numérique / IA'],
  ['Research Support Librarian / Research Advisor', 'research support librarians, subject/liaison librarians for research, research advisors, information specialists, research data or open science advisors; NL: informatiespecialist / onderzoeksadviseur; DK: forskningsbibliotekar / informationsspecialist; FR: bibliothécaire de recherche'],
];

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function saveJSON(path, data) {
  const dir = path.split('/').slice(0, -1).join('/');
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Supabase ──────────────────────────────────────────────────────────────
const supaHeaders = () => ({ apikey: SUPA_SERVICE_KEY, Authorization: `Bearer ${SUPA_SERVICE_KEY}` });

// PostgREST caps a response at 1000 rows; page explicitly so a region with
// more than that never silently loses the tail of its dedup list.
async function supaAll(pathAndQuery) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${pathAndQuery}`, {
      headers: { ...supaHeaders(), Range: `${from}-${from + 999}`, 'Range-Unit': 'items' },
    });
    if (!res.ok) throw new Error(`Supabase GET ${pathAndQuery}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
async function supaInsert(rows) {
  if (!rows.length) return 0;
  const res = await fetch(`${SUPA_URL}/rest/v1/pending_contacts`, {
    method: 'POST',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase insert failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return rows.length;
}

// ── Names and emails ──────────────────────────────────────────────────────
function slugPart(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ø/gi, 'o').replace(/æ/gi, 'ae').replace(/å/gi, 'a').replace(/ß/g, 'ss')
    .toLowerCase().replace(/[^a-z]/g, '');
}
function splitName(name) {
  const clean = String(name || '').replace(/\b(prof|dr|ir|drs|mr|mrs|ms|phd|msc|ma|ba|dhr|mevr|em)\.?\s+/gi, '').replace(/,.*$/, '').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts.slice(1).join(' ') };
}
function constructEmail(first, last, domain) {
  const f = slugPart(first), l = slugPart(last.replace(/\s+/g, ''));
  return f && l && domain ? `${f}.${l}@${domain}` : '';
}
function domainFromWebsite(website) {
  try { return new URL(website.startsWith('http') ? website : 'https://' + website).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

// ── Claude with web search ────────────────────────────────────────────────
function extractText(response) {
  return (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}
function parseJSONL(text) {
  const items = [];
  for (const line of text.split('\n')) {
    const t = line.trim().replace(/^```(?:json)?|```$/g, '').trim();
    if (!t.startsWith('{')) continue;
    try { items.push(JSON.parse(t)); } catch { /* skip malformed line */ }
  }
  return items;
}

async function findRoles(inst) {
  const roles = ROLE_FAMILIES.map(([k, d], i) => `${i + 1}. ${k} — ${d}`).join('\n');
  const prompt = `You are building a contact list for an academic-publishing account manager who sells research-intelligence tools (Scopus, SciVal, Pure) into ${COUNTRY} institutions.

Institution: ${inst.name}${inst.short ? ` (${inst.short})` : ''}, ${inst.city || ''}, ${COUNTRY}. Website: ${inst.website || 'unknown'}.

Find the people who CURRENTLY hold these roles at this institution. Search the institution's own website first (organisation and management pages, staff directories, the university library, IT services, legal and privacy pages, procurement, the doctoral or graduate school, research support office), then press releases and professional profiles. Prefer named individuals on official pages; skip anyone whose page shows they have left.

Role families:
${roles}

Return ONLY JSON Lines — one JSON object per person, no prose, no markdown — with exactly these fields:
{"name": "First Last", "title": "their exact job title as published", "role_family": "<one of the 11 family names above, verbatim>", "department": "unit or faculty", "email": "published address or empty string", "source_url": "the page where you found them", "confidence": "high|medium"}

Rules: only people you found on a page you can cite; never invent an email — leave it empty if it is not published; at most 3 people per role family; up to ${MAX_SEARCHES} searches. If a role family has no identifiable holder, simply omit it.`;

  const ctrl = new AbortController();
  // Six minutes: an Opus call making ten web searches ran past four on the
  // first full Danish run and two institutions were skipped as aborted.
  const timer = setTimeout(() => ctrl.abort(), 360000);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES }],
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const response = await res.json();
  const usage = response.usage || {};
  const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  if (response.stop_reason === 'refusal') return { people: [], searches, refused: true };
  return { people: parseJSONL(extractText(response)), searches, refused: false };
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[discover-roles] ${new Date().toISOString().slice(0, 16)} starting (${COUNTRY}) — batch ${BATCH}${DRY_RUN ? ', dry run' : ''}`);
  const state = readJSON(STATE_FILE, {});
  if (!API_KEY || !SUPA_SERVICE_KEY) {
    const missing = [!API_KEY && 'ANTHROPIC_API_KEY', !SUPA_SERVICE_KEY && 'SUPABASE_SERVICE_ROLE_KEY'].filter(Boolean).join(', ');
    console.log(`[discover-roles] ${missing} not set — skipping.`);
    saveJSON(STATE_FILE, { ...state, lastRun: new Date().toISOString(), lastAddedCount: 0, error: `missing ${missing}` });
    return;
  }

  // Institutions for this region, universities and medical centres first —
  // that is where the eleven roles exist as named posts.
  const insts = (await supaAll(`crm_institutions?select=id,name,short,type,city,website&region=eq.${REGION}&order=name.asc`))
    .sort((a, b) => ({ university: 0, medical: 1, research: 2, ngo: 3 }[a.type] ?? 9) - ({ university: 0, medical: 1, research: 2, ngo: 3 }[b.type] ?? 9));
  if (!insts.length) { console.log('[discover-roles] No institutions for this region.'); return; }

  // Rotating cursor over a stable order; the order is re-derived each run so
  // a newly added institution slots in without resetting the cycle.
  const order = insts.map(i => i.id);
  let cursor = Number.isInteger(state.cursor) ? state.cursor % order.length : 0;
  let batch;
  if (ONLY_INST.length) batch = insts.filter(i => ONLY_INST.includes(i.id));
  else { batch = []; for (let n = 0; n < Math.min(BATCH, order.length); n++) batch.push(insts[(cursor + n) % order.length]); }
  if (!batch.length) { console.log(`[discover-roles] Institution(s) ${ONLY_INST.join(', ')} not found for this region.`); return; }

  // Dedup against everything already queued or in the CRM for this region.
  const pending = await supaAll(`pending_contacts?select=first,last,email,institution_id&region=eq.${REGION}`);
  const contacts = await supaAll(`crm_contacts?select=first,last,email,inst_id&region=eq.${REGION}`);
  const seenEmail = new Set([...pending, ...contacts].map(r => (r.email || '').toLowerCase()).filter(Boolean));
  const seenName = new Set([...pending, ...contacts].map(r => `${r.first || ''} ${r.last || ''}`.toLowerCase().trim()).filter(s => s.length > 3));
  console.log(`  Skipping ${seenEmail.size} known email(s) and ${seenName.size} known name(s) (${pending.length} queued, ${contacts.length} in the CRM).`);

  const domainHints = {};
  for (const s of readJSON(SOURCES_FILE, { sources: [] }).sources || []) if (s.instId && s.emailDomain) domainHints[s.instId] = s.emailDomain;

  const candidates = [];
  const perInst = [];
  let totalSearches = 0;
  for (const inst of batch) {
    const domain = domainHints[inst.id] || domainFromWebsite(inst.website || '');
    let result;
    try {
      result = await findRoles(inst);
    } catch (e) {
      console.warn(`  ⚠ ${inst.name}: ${e.message}`);
      perInst.push({ instId: inst.id, error: e.message });
      continue;
    }
    totalSearches += result.searches;
    let kept = 0;
    for (const p of result.people) {
      const nm = splitName(p.name);
      if (!nm || !p.role_family || !p.source_url) continue;
      const family = ROLE_FAMILIES.find(([k]) => k.toLowerCase() === String(p.role_family).toLowerCase())?.[0] || String(p.role_family).slice(0, 60);
      const published = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(p.email || '') ? p.email.trim() : '';
      const email = published || constructEmail(nm.first, nm.last, domain);
      if (!email) continue;
      const el = email.toLowerCase(), nl = `${nm.first} ${nm.last}`.toLowerCase();
      if (seenEmail.has(el) || seenName.has(nl)) continue;
      seenEmail.add(el); seenName.add(nl);
      kept++;
      candidates.push({
        first: nm.first, last: nm.last, title: String(p.title || family).slice(0, 150),
        department: family, instId: inst.id, instName: inst.name,
        email, constructed: !published, source: String(p.source_url).slice(0, 500),
        confidence: p.confidence === 'high' ? 'high' : 'medium',
      });
    }
    console.log(`  ✓ ${inst.name}: ${result.people.length} named, ${kept} new — ${result.searches} search(es)${result.refused ? ' (refused)' : ''}`);
    perInst.push({ instId: inst.id, named: result.people.length, kept, searches: result.searches });
    await sleep(2000);
  }
  if (!ONLY_INST.length) cursor = (cursor + batch.length) % order.length;

  console.log(`\nFound ${candidates.length} new candidate(s):`);
  for (const c of candidates) console.log(`  ${(c.first + ' ' + c.last).padEnd(28)} ${c.department.padEnd(40)} ${c.title.slice(0, 40).padEnd(42)} ${c.email}${c.constructed ? '  (email constructed)' : ''}`);

  let added = 0, failed = false;
  if (!DRY_RUN && candidates.length) {
    const rows = candidates.map(c => ({
      first: c.first, last: c.last, title: c.title, department: c.department,
      institution_id: c.instId, institution_name: c.instName, email: c.email,
      research: '', source_url: c.source,
      notes: `Found by role search (${c.confidence} confidence). ` + (c.constructed ? 'Email constructed — please verify.' : 'Email published on the cited page.'),
      status: 'pending', region: REGION,
    }));
    try { added = await supaInsert(rows); }
    catch (e) { console.error('Supabase insert error:', e.message); failed = true; }
  }

  if (!DRY_RUN) {
    saveJSON(STATE_FILE, {
      lastRun: new Date().toISOString(),
      lastAddedCount: added,
      lastBatch: batch.map(i => i.id),
      lastWebSearches: totalSearches,
      cursor, institutions: order.length,
      perInstitution: perInst,
      ...(failed ? { error: 'insert failed' } : {}),
    });
    if (!failed && candidates.length) saveJSON(AUDIT_FILE, [...readJSON(AUDIT_FILE, []), ...candidates.map(c => ({ ...c, foundDate: new Date().toISOString().slice(0, 10) }))]);
  }
  if (process.env.GITHUB_ACTIONS && !totalSearches && batch.length) console.log('::warning::discover-roles: the model ran no web searches this run, so an empty result is not evidence.');
  console.log(`\nDone — ${batch.length} institution(s) searched (${totalSearches} web searches), ${added} candidate(s) added to pending_contacts. Next cursor: ${cursor}/${order.length}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
