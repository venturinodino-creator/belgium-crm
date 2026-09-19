/**
 * openalex-subscription-scan.js — Daily OpenAlex adoption scan, per institution
 *
 * What it looks for. Evidence that a Belgium research institution has
 * adopted OpenAlex (OurResearch's open scholarly index) or open research
 * information more broadly — the signal a competing publisher's account
 * manager needs before a Scopus or Web of Science renewal:
 *   subscriber — a paid OpenAlex subscription (Premium / Member / Member+ /
 *                Partner), with the fee and dates where published
 *   active     — public engagement short of a confirmed contract: a library
 *                guide on OpenAlex, OpenAlex feeding the CRIS / research
 *                portal or bibliometric reports, a Scopus / Web of Science
 *                cancellation or review citing open alternatives, signing
 *                the Barcelona Declaration on Open Research Information, a
 *                pilot or evaluation, membership of a national open-metadata
 *                initiative, or library staff presenting on OpenAlex
 * Each record carries a signalType so the reader knows which of these it is.
 *
 * Why per institution. Until 2026-09-18 this was one Claude call with twelve
 * web searches asked to cover every tracked institution and to report only
 * confirmed paid subscriptions with a price. Those are rare and rarely
 * announced, and twelve searches spread over 45 institutions is a quarter of
 * a search each; it returned zero candidates every day for a week. Now each
 * run takes a rotating batch of institutions (default 6) and gives each one
 * its own call with its own search budget, plus a country-level search once
 * a week for consortium and funder deals that no single institution's site
 * would carry. Every URL the model cites is fetched before the finding is
 * kept, and a record's institution name is the CRM's own, so the OpenAlex
 * page can merge it by name.
 *
 * Reads the institution list from data/institutions.json (exported daily from
 * the CRM), so a new institution joins the rotation without a code change.
 *
 * Requires ANTHROPIC_API_KEY. Run: node scripts/openalex-subscription-scan.js
 *   --batch N     institutions this run (default 6)
 *   --inst IDS    only these institution ids, comma-separated (skips the cursor)
 *   --dry-run     search and log, write nothing
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const COUNTRY = 'Belgium';
const DEMONYM = 'Belgian';
const DATA_FILE = 'data/openalex-subscriptions.json';
const STATE_FILE = 'data/openalex-scan-state.json';
const INSTITUTIONS_FILE = 'data/institutions.json';
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-opus-5';
const MAX_SEARCHES = 6;
const NATIONAL_EVERY_DAYS = 7;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// Country-level bodies whose deals cover many institutions at once — the
// weekly national search names them so the model looks in the right places.
const NATIONAL_HINTS = 'FWO and FNRS, VLIR and CRef, BELSPO (the Belgian Science Policy Office), the FRIS research portal (Flanders), KU Leuven LIBIS, BICfB (the Belgian consortium of university libraries), the Royal Library of Belgium (KBR), ELEKTRON, the Flanders Open Science Board';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] ? args[i + 1] : dflt; };
const BATCH = Math.max(1, parseInt(flag('--batch', '6'), 10) || 6);
const ONLY_INST = flag('--inst', '').split(',').map(s => s.trim()).filter(Boolean);
const DRY_RUN = args.includes('--dry-run');

const TYPE_LABEL = { university: 'University', medical: 'Medical Centre', ngo: 'NGO / Funder', research: 'NGO / Research' };
const TYPE_ORDER = { university: 0, medical: 1, research: 2, ngo: 3 };
const SIGNAL_TYPES = ['subscription', 'library_guide', 'cris_integration', 'bibliometrics_use', 'database_cancellation', 'barcelona_declaration', 'pilot_evaluation', 'national_initiative', 'staff_advocacy', 'other'];

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function saveJSON(path, data) {
  const dir = path.split('/').slice(0, -1).join('/');
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}
function slugify(s) {
  return String(s).toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
}
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
function isoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null;
}
// 404/410 or a dead host means the cited page is not there; a 403/429 is a
// bot wall, not evidence either way, so the finding stays.
async function urlLooksLive(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' }, signal: AbortSignal.timeout(20000) });
    return res.status !== 404 && res.status !== 410;
  } catch { return false; }
}

const OUTPUT_SPEC = `Return ONLY JSON Lines — one object per finding, no prose, no markdown. Fields:
{"inst": "organisation name", "status": "subscriber" or "active", "signalType": one of ${SIGNAL_TYPES.map(s => `"${s}"`).join(', ')}, "tier": "Premium" | "Member" | "Member+" | "Partner" | null, "annualFee": "as published, e.g. $5,000 USD / year, or null", "announceDate": "YYYY-MM-DD or null", "effectiveDate": "YYYY-MM-DD or null", "signal": "one sentence: what the evidence is", "notes": "two or three sentences: what was found, where, and what it means for a Scopus or Web of Science renewal", "sourceName": "page or document title", "sourceUrl": "the page you saw it on"}

Rules: only findings you saw on a page in this session, with that page's URL — never a URL from memory; "subscriber" only for a paid subscription stated by the institution or by OpenAlex/OurResearch; "active" for the other signal types; one object per distinct signal; nothing at all if there is no evidence. Up to ${MAX_SEARCHES} searches.`;

async function callClaude(prompt) {
  const ctrl = new AbortController();
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
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const response = await res.json();
  const usage = response.usage || {};
  const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  if (response.stop_reason === 'refusal') return { items: [], searches, refused: true };
  return { items: parseJSONL(extractText(response)), searches, refused: false };
}

function institutionPrompt(inst) {
  const label = inst.short && inst.short !== inst.name ? `${inst.name} (${inst.short})` : inst.name;
  return `You are researching, for a sales-intelligence CRM used by a scholarly publisher, whether one ${COUNTRY} research institution has adopted OpenAlex (OurResearch's open index of scholarly works) or open research information more broadly.

Institution: ${label}, ${inst.city || COUNTRY}, ${COUNTRY} (${TYPE_LABEL[inst.type] || 'institution'}).

Look for, in this order:
1. A paid OpenAlex subscription — OpenAlex Premium, or the older Member / Member+ / Partner tiers — announced by the institution, its library, or by OpenAlex/OurResearch; capture the fee and the dates if published.
2. Public engagement short of a contract: a library guide or LibGuide on OpenAlex; OpenAlex data feeding the institution's CRIS, research portal, or bibliometric and open-access monitoring reports; a Scopus or Web of Science cancellation, non-renewal, or review that cites OpenAlex or open alternatives; the institution signing the Barcelona Declaration on Open Research Information; a pilot or evaluation of OpenAlex or OpenAIRE as a replacement; membership of a national open-metadata initiative; library or research-support staff presenting or writing about OpenAlex.

Search the institution's own library and research-support pages first (in English and in the local language), then OpenAlex's and OurResearch's blog and documentation, the Barcelona Declaration signatory list, and LinkedIn or conference material from the institution's library staff. Ignore other organisations with similar names and anything older than 2022.

${OUTPUT_SPEC}
Use exactly "${inst.name}" as inst.`;
}

function nationalPrompt(known) {
  return `You are researching, for a sales-intelligence CRM used by a scholarly publisher, country-level adoption of OpenAlex (OurResearch's open index of scholarly works) and open research information in ${COUNTRY}: deals and commitments made by consortia, funders, ministries, research councils, national libraries, and CRIS or research-portal providers that cover many institutions at once.

Bodies to check: ${NATIONAL_HINTS}.

Look for: a national or consortium OpenAlex subscription or agreement; a funder or ministry recommending or mandating open research information; the Barcelona Declaration on Open Research Information signed by a ${DEMONYM} organisation; a national research portal or CRIS built on OpenAlex; a consortium-level Scopus or Web of Science review, non-renewal, or replacement; a national open-science plan naming OpenAlex.

Already recorded (do not repeat unless the status or price has changed): ${known || '(nothing yet)'}.

Search in English and in the local language, on the bodies' own sites, OpenAlex's and OurResearch's blog, the Barcelona Declaration signatory list, and open-science news. Ignore anything older than 2022.

${OUTPUT_SPEC}
Use the organisation's usual name as inst.`;
}

function toRecord(item, inst, today) {
  const status = item.status === 'subscriber' ? 'subscriber' : 'active';
  return {
    id: slugify(inst ? inst.name : item.inst),
    inst: inst ? inst.name : String(item.inst).slice(0, 150),
    type: inst ? (TYPE_LABEL[inst.type] || 'University') : (['University', 'Medical Centre', 'NGO / Funder', 'NGO / Research'].includes(item.type) ? item.type : 'NGO / Research'),
    status,
    signalType: SIGNAL_TYPES.includes(item.signalType) ? item.signalType : (status === 'subscriber' ? 'subscription' : 'other'),
    tier: item.tier ? String(item.tier).slice(0, 60) : null,
    annualFee: item.annualFee ? String(item.annualFee).slice(0, 150) : null,
    announceDate: isoDate(item.announceDate),
    effectiveDate: isoDate(item.effectiveDate),
    notes: String(item.notes || '').slice(0, 800),
    signal: String(item.signal || item.notes || '').slice(0, 400),
    sources: [{ label: String(item.sourceName || item.inst || '').slice(0, 150), url: String(item.sourceUrl).slice(0, 500) }],
    autoDiscovered: true,
    foundDate: today,
  };
}

// Keep the strongest finding per organisation: a subscription beats an
// engagement signal, and among engagement signals the ones closest to a
// purchasing decision rank first. A weaker finding still contributes its
// source, so the record accumulates every page cited for it.
const RANK = { subscriber: 2, active: 1 };
const SIGNAL_RANK = ['subscription', 'database_cancellation', 'cris_integration', 'pilot_evaluation', 'bibliometrics_use', 'library_guide', 'barcelona_declaration', 'national_initiative', 'staff_advocacy', 'other'];
const signalRank = s => { const i = SIGNAL_RANK.indexOf(s); return i === -1 ? SIGNAL_RANK.length : i; };
function merge(entries, byId, record) {
  const prior = byId.get(record.id);
  if (!prior) { entries.push(record); byId.set(record.id, record); return 'added'; }
  const sources = [...(prior.sources || [])];
  let newSource = false;
  for (const s of record.sources) if (!sources.some(x => x.url === s.url)) { sources.push(s); newSource = true; }
  const statusUp = (RANK[record.status] || 0) > (RANK[prior.status] || 0);
  const signalUp = record.status === prior.status && prior.autoDiscovered && signalRank(record.signalType) < signalRank(prior.signalType);
  const feeChanged = record.status === prior.status && (record.tier !== prior.tier || record.annualFee !== prior.annualFee);
  if (!statusUp && !signalUp && !feeChanged) {
    if (newSource) prior.sources = sources;
    return 'unchanged';
  }
  Object.assign(prior, record, { sources, foundDate: prior.foundDate || record.foundDate, lastConfirmed: record.foundDate });
  return 'updated';
}

async function checkPrompt(label, prompt) {
  const { items, searches, refused } = await callClaude(prompt);
  if (refused) { console.log(`[openalex-subscription-scan] ${label}: the model declined the request.`); return { items: [], searches }; }
  const kept = [];
  for (const it of items) {
    if (!it || !it.inst || !it.sourceUrl || !/^https?:\/\//i.test(String(it.sourceUrl))) continue;
    if (!(await urlLooksLive(String(it.sourceUrl)))) { console.log(`[openalex-subscription-scan] ${label}: dropped a finding — ${it.sourceUrl} does not answer`); continue; }
    kept.push(it);
  }
  console.log(`[openalex-subscription-scan] ${label}: ${searches} search(es), ${items.length} finding(s), ${kept.length} with a page that answers`);
  return { items: kept, searches };
}

async function main() {
  console.log(`[openalex-subscription-scan] ${new Date().toISOString().slice(0, 16)} starting (${COUNTRY}) — batch ${BATCH}${DRY_RUN ? ', dry run' : ''}`);
  const state = readJSON(STATE_FILE, {});
  if (!API_KEY) {
    console.log('[openalex-subscription-scan] ANTHROPIC_API_KEY not set — skipping scan until it is configured.');
    saveJSON(STATE_FILE, { ...state, lastRun: new Date().toISOString(), lastAddedCount: 0, error: 'missing_api_key' });
    return;
  }

  const insts = readJSON(INSTITUTIONS_FILE, []).filter(i => i && i.id && i.name)
    .sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || a.name.localeCompare(b.name));
  if (!insts.length) { console.log(`[openalex-subscription-scan] No institutions in ${INSTITUTIONS_FILE}.`); return; }

  const order = insts.map(i => i.id);
  let cursor = Number.isInteger(state.cursor) ? state.cursor % order.length : 0;
  let batch;
  if (ONLY_INST.length) batch = insts.filter(i => ONLY_INST.includes(i.id));
  else batch = Array.from({ length: Math.min(BATCH, order.length) }, (_, k) => insts[(cursor + k) % order.length]);
  if (!batch.length) { console.log(`[openalex-subscription-scan] Institution(s) ${ONLY_INST.join(', ')} not found for this region.`); return; }

  const entries = readJSON(DATA_FILE, []);
  const byId = new Map(entries.map(e => [e.id, e]));
  const today = new Date().toISOString().slice(0, 10);
  const checked = { ...(state.checked || {}) };
  let added = 0, updated = 0, candidates = 0, searchesTotal = 0;
  const errors = {};

  // Country-level search once a week (or when asked for a specific list, never).
  const nationalDue = !ONLY_INST.length && (!state.nationalLastRun || (Date.now() - new Date(state.nationalLastRun).getTime()) / 86400000 >= NATIONAL_EVERY_DAYS);
  let nationalLastRun = state.nationalLastRun || null;
  if (nationalDue) {
    try {
      const known = entries.map(e => `${e.inst}: ${e.status}${e.tier ? ' (' + e.tier + ')' : ''}`).join('; ');
      const { items, searches } = await checkPrompt(`${COUNTRY} (national)`, nationalPrompt(known));
      searchesTotal += searches; candidates += items.length;
      for (const it of items) {
        const byName = insts.find(i => i.name.toLowerCase() === String(it.inst).toLowerCase());
        const r = merge(entries, byId, toRecord(it, byName || null, today));
        if (r === 'added') added++; else if (r === 'updated') updated++;
        console.log(`  ${r === 'unchanged' ? '=' : r === 'added' ? '+' : '~'} ${it.inst}: ${it.status} / ${it.signalType || '?'} — ${String(it.signal || '').slice(0, 100)}`);
      }
      nationalLastRun = new Date().toISOString();
    } catch (e) {
      errors.national = e.message;
      console.warn(`[openalex-subscription-scan] national search failed: ${e.message}`);
    }
  }

  let apiError = null; // an account-level API error: stop, do not burn the rotation
  for (const inst of batch) {
    if (apiError) break;
    try {
      const { items, searches } = await checkPrompt(inst.name, institutionPrompt(inst));
      searchesTotal += searches; candidates += items.length;
      let best = 'none';
      for (const it of items) {
        const r = merge(entries, byId, toRecord(it, inst, today));
        if (r === 'added') added++; else if (r === 'updated') updated++;
        if (it.status === 'subscriber') best = 'subscriber'; else if (best === 'none') best = 'active';
        console.log(`  ${r === 'unchanged' ? '=' : r === 'added' ? '+' : '~'} ${inst.name}: ${it.status} / ${it.signalType || '?'} — ${String(it.signal || '').slice(0, 100)}`);
      }
      checked[inst.id] = { lastChecked: today, result: best, searches };
    } catch (e) {
      errors[inst.id] = e.message;
      console.warn(`[openalex-subscription-scan] ${inst.name} failed: ${e.message}`);
      if (/credit balance|billing|insufficient/i.test(e.message)) {
        apiError = e.message.slice(0, 200);
        console.error(`[openalex-subscription-scan] Anthropic API refused the call for the account, not the institution — stopping this run. ${apiError}`);
        if (process.env.GITHUB_ACTIONS) console.log('::error::Anthropic API credit balance is too low; top up at console.anthropic.com. No institution was searched this run.');
      }
    }
  }

  // Only move on when something was actually searched: a run where every
  // call failed leaves the cursor where it was, so the batch is retried.
  const searchedOk = batch.filter(i => !errors[i.id]).length;
  if (!ONLY_INST.length && searchedOk > 0) cursor = (cursor + batch.length) % order.length;

  if (DRY_RUN) {
    console.log(`[openalex-subscription-scan] Dry run — would add ${added}, update ${updated} (${candidates} finding(s), ${searchesTotal} searches). Nothing written.`);
    return;
  }
  if (added > 0 || updated > 0) saveJSON(DATA_FILE, entries);
  saveJSON(STATE_FILE, {
    lastRun: new Date().toISOString(),
    lastAddedCount: added,
    lastUpdatedCount: updated,
    lastCandidateCount: candidates,
    lastWebSearches: searchesTotal,
    lastBatch: batch.map(i => i.id),
    cursor,
    institutionsTotal: order.length,
    nationalLastRun,
    checked,
    errors,
    error: apiError || undefined,
  });
  const withSignal = Object.values(checked).filter(c => c.result !== 'none').length;
  console.log(`[openalex-subscription-scan] Done — ${added} new, ${updated} updated from ${candidates} finding(s) across ${batch.length} institution(s)${nationalDue ? ' + national' : ''}; ${Object.keys(checked).length}/${order.length} institutions checked so far, ${withSignal} with a signal.`);
}

main().catch(e => {
  console.error('[openalex-subscription-scan] Failed:', e.message);
  try {
    const state = readJSON(STATE_FILE, {});
    saveJSON(STATE_FILE, { ...state, lastRun: new Date().toISOString(), lastAddedCount: 0, error: e.message });
  } catch { /* ignore */ }
  process.exit(1);
});
