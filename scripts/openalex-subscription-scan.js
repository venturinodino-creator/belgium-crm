/**
 * openalex-subscription-scan.js — Daily OpenAlex subscription intelligence scan
 * Calls the Claude API (web search tool) to research public evidence — institution
 * library pages, press releases, blog posts, OpenAlex's own Community Advisory
 * Board notes — that a Belgium research institution has subscribed to OpenAlex
 * (Member / Member+ / Partner tier), and critically, what it is paying and when the
 * subscription was announced/took effect. Genuinely new or updated findings are
 * appended to data/openalex-subscriptions.json, tagged autoDiscovered: true so the
 * UI can flag them as not yet manually reviewed.
 *
 * Requires ANTHROPIC_API_KEY in the environment.
 * Run: node scripts/openalex-subscription-scan.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const DATA_FILE = 'data/openalex-subscriptions.json';
const STATE_FILE = 'data/openalex-scan-state.json';
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-opus-5';

// The Belgium institutions this CRM tracks — kept in sync with SEED_INSTITUTIONS
// in index.html. Used to focus the search and to let the model flag status changes
// for institutions we already have an opinion on, not just brand-new subscribers.
const BE_INSTITUTIONS = [
  'KU Leuven',
  'Ghent University (UGent)',
  'University of Antwerp (UAntwerpen)',
  'Vrije Universiteit Brussel (VUB)',
  'Hasselt University (UHasselt)',
  'UCLouvain',
  'Université de Liège (ULiège)',
  'Université libre de Bruxelles (ULB)',
  'University of Namur (UNamur)',
  'Université de Mons (UMons)',
  'UZ Leuven (University Hospitals Leuven) (UZ Leuven)',
  'Ghent University Hospital (UZ Gent)',
  'Antwerp University Hospital (UZA)',
  'UZ Brussel',
  'CHU de Liège (CHU Liège)',
  'Cliniques universitaires Saint-Luc (Saint-Luc)',
  'Hôpital Erasme (Erasme)',
  'Institut Jules Bordet (Bordet)',
  'CHU UCL Namur (Godinne) (CHU UCL Namur)',
  'imec',
  'VIB (Vlaams Instituut voor Biotechnologie) (VIB)',
  'Flanders Make',
  'Sciensano',
  'Royal Belgian Institute of Natural Sciences (RBINS)',
  'Royal Meteorological Institute of Belgium (RMI)',
  'Royal Observatory of Belgium (ROB)',
  'International Solvay Institutes for Physics and Chemistry (Solvay Institutes)',
  'VITO (Flemish Institute for Technological Research) (VITO)',
  'Royal Academies for Science and the Arts of Belgium (RASAB)',
  'Royal Belgian Institute for Space Aeronomy (BIRA-IASB)',
  'Egmont Institute (Royal Institute for International Relations) (Egmont Institute)',
  'Bruegel',
  'Itinera Institute (Itinera)',
  'Research Foundation – Flanders (FWO)',
  'F.R.S.-FNRS',
  'King Baudouin Foundation (KBF)',
  'Kom op tegen Kanker (KOTK)',
  'Fondation contre le Cancer / Stichting tegen Kanker (FCC)',
];

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
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { items.push(JSON.parse(trimmed)); } catch { /* skip malformed lines */ }
  }
  return items;
}

async function callClaude(existing) {
  const known = existing.map(e => `- ${e.inst}: ${e.status}${e.tier ? ' (' + e.tier + (e.annualFee ? ', ' + e.annualFee : '') + ')' : ''}`).join('\n') || '(none tracked yet)';

  const prompt = `You are researching OpenAlex (the open scholarly metadata index run by OurResearch) subscription status for Belgium research institutions, for a sales-intelligence CRM used by a competing publisher.

OpenAlex has four tiers: Free/API ($1/day rate-limited), Member ($5,000/yr — admin dashboard, affiliation editor, unsub access), Member+ ($20,000/yr — increased API quotas, consulting hours), and Partner (custom pricing — product roadmap influence, dedicated support).

Institutions this CRM tracks, with what we currently know:
${known}

Search the web (institution library pages and news sections, press releases, procurement/tender notices, OpenAlex's own blog and Community Advisory Board notes on GitHub, LinkedIn posts from library staff, relevant EU/NL open-science coverage) for CURRENT, VERIFIABLE evidence of:
1. Any of the above institutions confirming an OpenAlex Member/Member+/Partner subscription that we don't already have correctly recorded above (a new subscriber, a status upgrade, or a previously-unconfirmed price now disclosed).
2. Any Belgian university, medical centre, or research institute NOT in the list above that has confirmed an OpenAlex subscription.

The price/fee and the announcement or effective date are the most important facts to capture — always include them if the source states them, and say "not disclosed" if the source confirms a subscription but not the amount. Do not guess a price.

For each genuinely new or updated finding, respond with one JSON object per line (JSONL), each with exactly these fields:
{"inst": "institution name", "type": "University"|"Medical Centre"|"NGO / Funder"|"NGO / Research", "status": "subscriber"|"active", "tier": "Member"|"Member+"|"Partner"|null, "annualFee": "e.g. $5,000 USD / year, or Custom — price not disclosed, or null if status is not subscriber", "announceDate": "YYYY-MM-DD or null", "effectiveDate": "YYYY-MM-DD or null", "notes": "2-4 factual sentences: what was confirmed, by whom, and any related signal like a Scopus/Web of Science cancellation", "signal": "one short sentence for a table cell, e.g. 'CONFIRMED PAYING. Member tier at $5,000/yr, effective March 2026.'", "sourceUrl": "...", "sourceName": "..."}

Use status "active" only for an institution publicly and substantially engaging with OpenAlex (e.g. built a library guide on it, cancelled Scopus/WoS explicitly citing OpenAlex as the replacement) without a confirmed paid subscription. Only report what your search actually surfaces with a verifiable source URL — never invent a subscription, a price, or a source. If you find nothing genuinely new, output nothing at all.`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 12 }],
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

async function main() {
  if (!API_KEY) {
    console.log('[openalex-subscription-scan] ANTHROPIC_API_KEY not set — skipping scan until it is configured.');
    saveJSON(STATE_FILE, { lastRun: new Date().toISOString(), lastAddedCount: 0, error: 'missing_api_key' });
    return;
  }

  const entries = readJSON(DATA_FILE, []);
  const byId = new Map(entries.map(e => [e.id, e]));

  console.log(`[openalex-subscription-scan] Calling Claude with web search across ${BE_INSTITUTIONS.length} tracked institutions...`);
  const response = await callClaude(entries);

  if (response.stop_reason === 'refusal') {
    console.log('[openalex-subscription-scan] Request was declined by safety classifiers — no results this run.');
    saveJSON(STATE_FILE, { lastRun: new Date().toISOString(), lastAddedCount: 0, refused: true });
    return;
  }

  const text = extractText(response);
  const found = parseJSONL(text);
  console.log(`[openalex-subscription-scan] Model returned ${found.length} candidate(s).`);

  let added = 0, updated = 0;
  for (const item of found) {
    if (!item.inst || !item.status || !item.sourceUrl) continue;
    const id = slugify(item.inst);
    const record = {
      id,
      inst: String(item.inst).slice(0, 150),
      type: ['University', 'Medical Centre', 'NGO / Funder', 'NGO / Research'].includes(item.type) ? item.type : 'University',
      status: ['subscriber', 'active'].includes(item.status) ? item.status : 'active',
      tier: item.tier ? String(item.tier).slice(0, 60) : null,
      annualFee: item.annualFee ? String(item.annualFee).slice(0, 150) : null,
      announceDate: /^\d{4}-\d{2}-\d{2}$/.test(item.announceDate) ? item.announceDate : null,
      effectiveDate: /^\d{4}-\d{2}-\d{2}$/.test(item.effectiveDate) ? item.effectiveDate : null,
      notes: String(item.notes || '').slice(0, 800),
      signal: String(item.signal || item.notes || '').slice(0, 400),
      sources: [{ label: String(item.sourceName || item.inst).slice(0, 150), url: String(item.sourceUrl).slice(0, 500) }],
      autoDiscovered: true,
      foundDate: new Date().toISOString().slice(0, 10),
    };

    const prior = byId.get(id);
    if (!prior) {
      entries.push(record);
      byId.set(id, record);
      added++;
      console.log(`  + ${record.inst}: ${record.status}${record.tier ? ' (' + record.tier + ')' : ''}`);
    } else if (prior.status !== record.status || prior.annualFee !== record.annualFee || prior.tier !== record.tier) {
      // Keep manually-reviewed source history, but let a status/price upgrade through.
      Object.assign(prior, record, { sources: [...(prior.sources || []), ...record.sources] });
      updated++;
      console.log(`  ~ ${record.inst}: updated to ${record.status}${record.tier ? ' (' + record.tier + ')' : ''}`);
    }
  }

  if (added > 0 || updated > 0) saveJSON(DATA_FILE, entries);

  saveJSON(STATE_FILE, {
    lastRun: new Date().toISOString(),
    lastAddedCount: added,
    lastUpdatedCount: updated,
    lastCandidateCount: found.length,
  });
  console.log(`[openalex-subscription-scan] Done — ${added} new, ${updated} updated.`);
}

main().catch(e => {
  console.error('[openalex-subscription-scan] Failed:', e.message);
  try {
    saveJSON(STATE_FILE, { lastRun: new Date().toISOString(), lastAddedCount: 0, error: e.message });
  } catch { /* ignore */ }
  process.exit(1);
});
