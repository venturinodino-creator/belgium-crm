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
// Why match by name phrase rather than organisation id: OpenAIRE holds one
// university as many organisation records (the deduplicated "openorgs"
// record with the ROR id, plus "pending_org" fragments carrying each
// funder's own spelling — STICHTING KATHOLIEKE UNIVERSITEIT BRABANT, AALBORG
// UNIVERSITET, WAGENINGEN UNIVERSITY), and most projects hang off the
// fragments. The ROR record for the University of Copenhagen holds 3 of its
// 3,900 projects. relOrganizationName searches across all of them; quoted,
// it is a phrase match, so "Utrecht University" no longer pulls in "HU
// University of Applied Sciences Utrecht". A few institutions whose funder
// spelling differs from their English name are undercounted (Radboud), and
// the card links to the same OpenAIRE search so the figure can be checked.
//
// A grant amount is the project's total funded amount, not this
// institution's share — the API does not split it by participant, and the
// page labels it accordingly.

const fs = require('fs');
const path = require('path');

const API = 'https://api.openaire.eu/graph/v1';
const FOCUS_PATH = path.join(__dirname, '..', 'data', 'research-focus.json');
const INST_PATH = path.join(__dirname, '..', 'data', 'institutions.json');
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

function projectUrl(p) { return `https://explore.openaire.eu/search/project?projectId=${encodeURIComponent(p.id)}`; }
function searchUrl(name) { return `https://explore.openaire.eu/search/find/projects?fv0=${encodeURIComponent('"' + name + '"')}&f0=q`; }

function projectsUrl(name, fromDate, page, size) {
  return `${API}/projects?relOrganizationName=${encodeURIComponent('"' + name + '"')}&fromStartDate=${fromDate}&pageSize=${size}&page=${page}&sortBy=startDate%20DESC`;
}

// The names to try, in order: the OpenAlex display name, the CRM's own name,
// and the part of the CRM name before an em-dash ("ASTRON — Netherlands
// Institute for Radio Astronomy" is filed under ASTRON). The first that
// returns anything wins. Short names and acronyms are never used: a phrase
// search for "FORCE", "BRIGHT" or "Research Foundation" matches anything.
function candidateNames(rf, inst) {
  const seen = new Set();
  const usable = n => n.length >= 8 && n.split(/\s+/).length >= 2 && !/^[A-Z0-9 .&-]+$/.test(n);
  const raw = [rf && rf.openalexName, inst && inst.name];
  if (inst && inst.name && /\s—\s/.test(inst.name)) raw.push(inst.name.split(/\s—\s/)[0]);
  return raw
    // Commas and quotes inside the phrase make the API answer 400.
    .map(n => String(n || '').replace(/[,;"'()]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(n => usable(n) && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
}

async function scanInstitution(name, fromDate) {
  const projects = [];
  let numFound = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await apiGet(projectsUrl(name, fromDate, page, 100));
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
  // The counts above cover the fetched projects only; a large university has
  // more than the 300 fetched. Ask the API how many have already ended (a
  // project with no end date on record counts as running, as above) and
  // take the rest as active.
  if (numFound > projects.length) {
    try {
      await sleep(PAUSE_MS);
      const ended = await apiGet(`${API}/projects?relOrganizationName=${encodeURIComponent('"' + name + '"')}&fromStartDate=${fromDate}&toEndDate=${today}&pageSize=1`);
      if (ended.header && typeof ended.header.numFound === 'number') active = Math.max(0, numFound - ended.header.numFound);
    } catch (e) { /* keep the count over the fetched projects */ }
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
  const instList = readJSON(INST_PATH, []);
  const instById = Object.fromEntries((Array.isArray(instList) ? instList : []).map(i => [i.id, i]));
  const state = readJSON(STATE_PATH, {});
  const previous = readJSON(OUT_PATH, { institutions: {} });
  const from = new Date(); from.setFullYear(from.getFullYear() - LOOKBACK_YEARS);
  const fromDate = from.toISOString().slice(0, 10);
  const out = {
    generatedAt: new Date().toISOString(),
    source: 'OpenAIRE Graph API (projects by organisation name; CORDIS and national funders)',
    since: fromDate,
    institutions: {},
  };
  // Every CRM institution is tried, whether or not OpenAlex knows it.
  const ids = Array.from(new Set([...Object.keys(focus.institutions || {}), ...Object.keys(instById)]));
  let ok = 0, empty = 0, failed = 0;
  for (const instId of ids) {
    if (ONLY.length && !ONLY.includes(instId)) continue;
    const rf = (focus.institutions || {})[instId];
    const names = candidateNames(rf, instById[instId]);
    if (!names.length) { out.institutions[instId] = { notFound: true, reason: 'No name to search OpenAIRE with.' }; empty++; continue; }
    try {
      let rec = null, used = '';
      for (const name of names) {
        used = name;
        try { rec = await scanInstitution(name, fromDate); }
        catch (e) {
          // A phrase the API will not parse (HTTP 400) is a miss for that
          // name, not a failed institution: try the next spelling.
          if (!/HTTP 400/.test(e.message)) throw e;
          rec = { numFound: 0, fetched: 0, active: 0, fundedTotal: 0, fundedKnown: 0, byFunder: {}, projects: [], rejected: true };
        }
        await sleep(PAUSE_MS);
        if (rec.numFound > 0) break;
      }
      out.institutions[instId] = { query: used, since: fromDate, ...rec, sourceUrl: searchUrl(used) };
      if (rec.numFound > 0) ok++; else empty++;
      const funders = Object.entries(rec.byFunder).sort((a, b) => b[1].count - a[1].count).slice(0, 3).map(([k, v]) => `${k} ${v.count}`).join(', ');
      console.log(`  ${rec.numFound ? '✓' : '·'} ${used.padEnd(52)} ${String(rec.numFound).padStart(5)} projects since ${fromDate}, ${rec.active} active — ${funders}`);
    } catch (e) {
      failed++;
      const prev = (previous.institutions || {})[instId];
      out.institutions[instId] = prev && prev.numFound ? { ...prev, stale: true, fetchError: e.message } : { fetchError: e.message };
      console.log(`  ✗ ${instId}: ${e.message}`);
    }
  }
  console.log(`\nDone: ${ok} with projects, ${empty} with none, ${failed} failed.`);
  if (DRY_RUN) { console.log('(dry run — not written)'); return; }
  if (ONLY.length) out.institutions = { ...(previous.institutions || {}), ...out.institutions };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  state.lastRun = new Date().toISOString();
  state.lastScanned = ok; state.lastEmpty = empty; state.lastFailed = failed;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
