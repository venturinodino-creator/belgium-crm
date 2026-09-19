// Pulls every tracked institution's recent research grants from the OpenAIRE
// Graph API — Horizon Europe / ERC / MSCA projects from CORDIS plus the
// national and charitable funders OpenAIRE aggregates (NWO, the Danish
// foundations, UKRI, ANR, Wellcome ...) — and writes data/funding.json for
// the Funding card on each institution profile. Run weekly by
// .github/workflows/funding-scan.yml.
//
// Why OpenAIRE rather than CORDIS directly: CORDIS publishes bulk dumps, not
// a per-organisation query; OpenAIRE indexes the same CORDIS records and
// serves them by organisation, with the national funders in the same call.
//
// Institution resolution: data/research-focus.json carries each
// institution's ROR id (from OpenAlex). OpenAIRE's organisations endpoint
// maps a ROR id to its own organisation id, which the projects endpoint
// filters on. Those ids are cached in data/funding-scan-state.json.
//
// A grant amount is the project's total funded amount, not this
// institution's share — the API does not split it by participant, and the
// page labels it accordingly.

const fs = require('fs');
const path = require('path');

const API = 'https://api.openaire.eu/graph/v1';
const COUNTRY = 'BE'; // ISO country code for the name-search fallback
const FOCUS_PATH = path.join(__dirname, '..', 'data', 'research-focus.json');
const OUT_PATH = path.join(__dirname, '..', 'data', 'funding.json');
const STATE_PATH = path.join(__dirname, '..', 'data', 'funding-scan-state.json');
const LOOKBACK_YEARS = 3;
const MAX_PAGES = 3;      // 300 most recent projects per institution is plenty for a card
const TOP_PROJECTS = 12;
const PAUSE_MS = 400;

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = (() => { const i = process.argv.indexOf('--inst'); return i > -1 ? process.argv[i + 1].split(',') : []; })();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function apiGet(url, attempt = 0) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'research-crm-funding-scan/1.0' } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 3) { await sleep(5000 * (attempt + 1)); return apiGet(url, attempt + 1); }
    throw new Error(`OpenAIRE HTTP ${res.status} for ${url}`);
  }
  if (!res.ok) throw new Error(`OpenAIRE HTTP ${res.status} for ${url}`);
  return res.json();
}

function readJSON(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; } }

// OpenAIRE does not carry a ROR pid for every organisation it knows (CWI,
// Deltares and Sanquin all resolve by name but not by ROR), so fall back to a
// name search restricted to this country and accept an exact name match.
async function resolveOrg(ror, name) {
  const json = await apiGet(`${API}/organizations?pid=${encodeURIComponent('https://ror.org/' + ror)}&pageSize=1`);
  const org = (json.results || [])[0];
  if (org) return { id: org.id, name: org.legalName || org.legalShortName, via: 'ror' };
  if (!name) return null;
  await sleep(PAUSE_MS);
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const byName = await apiGet(`${API}/organizations?search=${encodeURIComponent(name)}&countryCode=${COUNTRY}&pageSize=10`);
  const want = norm(name);
  const hit = (byName.results || []).find(o => [o.legalName, o.legalShortName, ...(o.alternativeNames || [])].some(n => norm(n) === want));
  return hit ? { id: hit.id, name: hit.legalName || hit.legalShortName, via: 'name' } : null;
}

function projectUrl(p) { return `https://explore.openaire.eu/search/project?projectId=${encodeURIComponent(p.id)}`; }

async function scanInstitution(orgId, fromDate) {
  const projects = [];
  let numFound = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await apiGet(`${API}/projects?relOrganizationId=${encodeURIComponent(orgId)}&fromStartDate=${fromDate}&pageSize=100&page=${page}&sortBy=startDate%20DESC`);
    numFound = (json.header && json.header.numFound) || 0;
    projects.push(...(json.results || []));
    if (page * 100 >= numFound) break;
    await sleep(PAUSE_MS);
  }
  const today = new Date().toISOString().slice(0, 10);
  const byFunder = {};
  let active = 0, fundedTotal = 0, fundedKnown = 0;
  for (const p of projects) {
    const f = (p.fundings || [])[0] || {};
    const key = f.shortName || f.name || 'Other';
    const amt = p.granted && p.granted.fundedAmount > 0 ? p.granted.fundedAmount : 0;
    byFunder[key] = byFunder[key] || { name: f.name || key, count: 0, amount: 0 };
    byFunder[key].count++;
    byFunder[key].amount += amt;
    if (amt) { fundedTotal += amt; fundedKnown++; }
    if (!p.endDate || p.endDate >= today) active++;
  }
  const top = projects.slice(0, TOP_PROJECTS).map(p => {
    const f = (p.fundings || [])[0] || {};
    return {
      id: p.id, code: p.code || '', acronym: p.acronym || '', title: p.title || '',
      funder: f.shortName || f.name || '', stream: (f.fundingStream && f.fundingStream.description) || '',
      call: p.callIdentifier || '', start: p.startDate || '', end: p.endDate || '',
      amount: p.granted && p.granted.fundedAmount > 0 ? p.granted.fundedAmount : null,
      currency: (p.granted && p.granted.currency) || 'EUR',
      url: projectUrl(p),
    };
  });
  return { numFound, fetched: projects.length, active, fundedTotal, fundedKnown, byFunder, projects: top };
}

async function main() {
  const focus = readJSON(FOCUS_PATH, null);
  if (!focus) { console.error('data/research-focus.json missing — run research-focus-scan first'); process.exit(1); }
  const state = readJSON(STATE_PATH, { orgIds: {} });
  const previous = readJSON(OUT_PATH, { institutions: {} });
  const from = new Date(); from.setFullYear(from.getFullYear() - LOOKBACK_YEARS);
  const fromDate = from.toISOString().slice(0, 10);
  const out = {
    generatedAt: new Date().toISOString(),
    source: 'OpenAIRE Graph API (projects by organisation; CORDIS and national funders)',
    since: fromDate,
    institutions: {},
  };
  let ok = 0, skipped = 0, failed = 0;
  for (const [instId, rf] of Object.entries(focus.institutions || {})) {
    if (ONLY.length && !ONLY.includes(instId)) continue;
    if (!rf || !rf.ror) { out.institutions[instId] = { notFound: true, reason: 'No ROR id resolved for this organisation, so OpenAIRE cannot be queried.' }; skipped++; continue; }
    try {
      let org = state.orgIds[rf.ror];
      if (!org) { org = await resolveOrg(rf.ror, rf.openalexName); await sleep(PAUSE_MS); }
      if (!org) { out.institutions[instId] = { notFound: true, reason: `OpenAIRE has no organisation record for ROR ${rf.ror}.`, ror: rf.ror }; skipped++; continue; }
      state.orgIds[rf.ror] = org;
      const rec = await scanInstitution(org.id, fromDate);
      out.institutions[instId] = { ror: rf.ror, openaireId: org.id, openaireName: org.name, since: fromDate, ...rec,
        sourceUrl: `https://explore.openaire.eu/search/advanced/projects?relorganizationid=${encodeURIComponent(org.id)}` };
      ok++;
      const funders = Object.entries(rec.byFunder).sort((a, b) => b[1].count - a[1].count).slice(0, 3).map(([k, v]) => `${k} ${v.count}`).join(', ');
      console.log(`  ✓ ${(org.name || instId).padEnd(52)} ${String(rec.numFound).padStart(5)} projects since ${fromDate}, ${rec.active} active — ${funders}`);
      await sleep(PAUSE_MS);
    } catch (e) {
      failed++;
      const prev = (previous.institutions || {})[instId];
      out.institutions[instId] = prev && prev.numFound ? { ...prev, stale: true, fetchError: e.message } : { fetchError: e.message };
      console.log(`  ✗ ${instId}: ${e.message}`);
    }
  }
  console.log(`\nDone: ${ok} scanned, ${skipped} without an OpenAIRE record, ${failed} failed.`);
  if (DRY_RUN) { console.log('(dry run — not written)'); return; }
  if (ONLY.length) out.institutions = { ...(previous.institutions || {}), ...out.institutions };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  state.lastRun = new Date().toISOString();
  state.lastScanned = ok; state.lastFailed = failed;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
