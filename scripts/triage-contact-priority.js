/**
 * triage-contact-priority.js — one-off backfill of crm_contacts.priority.
 *
 * Every Belgian contact currently sits on the 'medium' default, so the CRM
 * (and the board-facing summary PDF) can't distinguish a university's
 * library director from a name scraped off a publication. This assigns a
 * priority from the contact's job title, using the role families this CRM
 * actually sells into.
 *
 * The rule, in the order it is applied:
 *
 *   high   — budget holders and decision-makers: directors (incl. the
 *            Danish/Dutch/French forms), heads of department/research/
 *            library/IT, C-level, deans, rectors, university librarians,
 *            and the research-support/grants/tech-transfer leadership that
 *            signs off on subscriptions. Also AI leadership (guild, lab,
 *            centre lead), since that is where AI-tool budget decisions sit.
 *   medium — coordinators, project/programme/communication/HR managers:
 *            real people worth keeping, but they don't hold the budget.
 *   low    — the generic 'Researcher' title. These are leftovers from the
 *            retired OpenAlex researcher scan (452 of Belgium's 708
 *            contacts as of 2026-09-12). Marking them low keeps the record
 *            and its provenance while getting them out of the way of the
 *            leadership contacts this CRM is now built around. Nothing is
 *            deleted.
 *
 * A title that matches nothing is left ALONE rather than forced into a
 * bucket — an unrecognised title is a gap in this rule, not evidence that
 * the person is unimportant, and silently downgrading them would hide real
 * contacts. Run with --verbose to see exactly which ones were skipped.
 *
 * DRY RUN BY DEFAULT. This rewrites a column on hundreds of existing,
 * hand-reviewable rows, so it prints a full before/after breakdown and
 * changes nothing unless you pass --apply:
 *
 *   node scripts/triage-contact-priority.js              # report only
 *   node scripts/triage-contact-priority.js --verbose    # + every title
 *   node scripts/triage-contact-priority.js --apply      # actually write
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY. Only touches region='belgium'.
 */

const REGION = 'belgium';
const SUPA_URL = 'https://cfhljbexesdrabmadpcc.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');
const BATCH_SIZE = 50;

// ── the rule ───────────────────────────────────────────────────────────────
// Matched against the title in lower case. Ordered: LOW is checked first so
// the exact generic 'researcher' can't be caught by a broader pattern, then
// HIGH, then MEDIUM.

// Exactly the generic scrape output, not e.g. 'Research Director' or
// 'Head of Research' — anchored so only the bare word matches.
const GENERIC_RESEARCHER_RE = /^(researcher|research fellow|phd|phd student|postdoc|postdoctoral researcher)$/i;

// Checked before everything else. These are assistants whose title quotes
// their boss's title — 'Sygehusdirektør PA/chefsekretær for Ricco Dyhr' is
// the PA, not the hospital director, and a plain 'director' match would
// promote them. Real rows in the Danish set, hence the explicit guard.
const ASSISTANT_RE = /(^|\W)pa\b|chefsekret|personal assistant|\bsecretary to\b/i;

// Individual technical contributors whose titles contain a leadership word
// ('Lead Full Stack Engineer') — senior, but not who signs a subscription.
const IC_TECH_RE = /\b(engineer|developer|programmer)\b|full stack/i;

// Catering/facilities staff, who appear in these directories alongside
// everyone else. 'Head Chef' is a real row in the Danish set and matches
// 'head' — a cook, not a budget holder. Deliberately narrow: the French
// 'Chef du service des Urgences' is a clinical department head and must
// not be caught here.
const FACILITIES_RE = /head chef|\b(catering|canteen|kitchen|janitor|cleaning|groundskeep)/i;

const LEADERSHIP_RE = new RegExp([
  // director, in the languages these directories actually use
  'director', 'directeur', 'direktør', 'direktor', 'directrice', 'directeur',
  'wetenschappelijk directeur', 'algemeen directeur',
  // heads of things. '\\w{3,}chef' is the Danish compound (kontorchef,
  // udviklingschef, sekretariatschef) — a bare '\\bchef\\b' would also
  // match the hospital's actual 'Head Chef', which is a cook.
  '\\bhead\\b', '\\bhoofd\\b', '\\w{3,}chef\\b', 'chief', 'leder\\b', '\\blead\\b', 'teamlead', 'team lead',
  // C-level / executive
  '\\bceo\\b', '\\bcto\\b', '\\bcio\\b', '\\bcoo\\b', '\\bcfo\\b', 'chief executive',
  'chief technology', 'chief information', 'chief operating', 'chief data',
  'vice president', 'vice-president', 'president', 'executive vice',
  // French/Dutch forms these Belgian directories use heavily. 'responsable'
  // is literally "the person in charge"; 'chef du/de service' is a clinical
  // or administrative department head (distinct from the English 'Head Chef'
  // excluded above, which is why this needs the following preposition).
  'responsable', 'chef d[eu]\\b', 'médecin chef', 'medecin chef',
  'secretary general', 'secrétaire général', 'permanent secretary', 'vast secretaris',
  // academic leadership
  'dean\\b', 'decaan', 'rector', 'provost', 'vice-chancellor', 'pro-vice',
  'university librarian', 'bibliotheksdirektør', 'hoofdbibliothecaris',
  // the research-support / money side that signs off on subscriptions
  'grants? (manager|director|officer|lead)', 'research support',
  'research funding', 'funding (manager|director|officer|lead)',
  'knowledge transfer', 'tech(nology)? transfer', 'valorisation', 'valorisatie',
  'research (director|manager|policy)', 'secretariat',
  // AI leadership specifically — where AI-tool budget decisions sit
  'ai (lead|head|director|guild|officer)', '(head|lead|director).{0,20}\\bai\\b',
].join('|'), 'i');

const COORDINATOR_RE = new RegExp([
  'coordinator', 'coördinator', 'koordinator',
  'project manager', 'programme manager', 'program manager',
  'communication manager', 'communications manager',
  '\\bhr manager\\b', 'public affairs', 'knowledge manager',
  'adviser', 'advisor', 'officer\\b', 'specialist', 'consultant',
].join('|'), 'i');

function classify(title) {
  const t = String(title || '').trim();
  if (!t) return null;                       // no title -> no opinion
  if (GENERIC_RESEARCHER_RE.test(t)) return 'low';
  // Assistants and individual contributors are demoted out of the
  // leadership check before it runs, not after — their titles legitimately
  // contain 'director' / 'lead'.
  if (ASSISTANT_RE.test(t)) return 'medium';
  if (IC_TECH_RE.test(t)) return 'medium';
  if (FACILITIES_RE.test(t)) return 'low';
  if (LEADERSHIP_RE.test(t)) return 'high';
  if (COORDINATOR_RE.test(t)) return 'medium';
  return null;                               // unrecognised -> leave alone
}

// ── Supabase ───────────────────────────────────────────────────────────────
async function supaFetch(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

const authHeaders = {
  apikey: SUPA_SERVICE_KEY,
  Authorization: `Bearer ${SUPA_SERVICE_KEY}`,
  'content-type': 'application/json',
};

async function fetchContacts() {
  const res = await supaFetch(
    `${SUPA_URL}/rest/v1/crm_contacts?select=id,first,last,title,priority&region=eq.${REGION}`,
    { headers: authHeaders });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function updatePriority(id, priority) {
  const res = await supaFetch(
    `${SUPA_URL}/rest/v1/crm_contacts?id=eq.${encodeURIComponent(id)}&region=eq.${REGION}`,
    { method: 'PATCH', headers: { ...authHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ priority }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

function pct(n, total) {
  return total ? `${Math.round((n / total) * 100)}%` : '0%';
}

async function main() {
  if (!SUPA_SERVICE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY is not set — cannot read contacts.');
    process.exit(1);
  }

  const contacts = await fetchContacts();
  console.log(`[triage] ${contacts.length} ${REGION} contacts loaded.\n`);

  const changes = [];
  const unchanged = [];
  const skipped = [];
  const samples = { high: new Map(), medium: new Map(), low: new Map() };

  for (const c of contacts) {
    const target = classify(c.title);
    if (!target) { skipped.push(c); continue; }
    const bucket = samples[target];
    const key = String(c.title || '').trim();
    bucket.set(key, (bucket.get(key) || 0) + 1);
    if ((c.priority || 'medium') === target) unchanged.push(c);
    else changes.push({ ...c, from: c.priority || 'medium', to: target });
  }

  const byTarget = t => changes.filter(c => c.to === t).length;
  console.log('Proposed priority distribution');
  console.log('──────────────────────────────');
  for (const t of ['high', 'medium', 'low']) {
    const total = [...samples[t].values()].reduce((a, b) => a + b, 0);
    console.log(`  ${t.padEnd(7)} ${String(total).padStart(4)}  (${pct(total, contacts.length)})  ${byTarget(t)} would change`);
  }
  console.log(`  ${'skipped'.padEnd(7)} ${String(skipped.length).padStart(4)}  (${pct(skipped.length, contacts.length)})  title unrecognised — left as-is\n`);

  for (const t of ['high', 'medium', 'low']) {
    const top = [...samples[t].entries()].sort((a, b) => b[1] - a[1]).slice(0, VERBOSE ? 500 : 12);
    if (!top.length) continue;
    console.log(`${t.toUpperCase()} — titles matched${VERBOSE ? '' : ' (top 12)'}`);
    for (const [title, n] of top) console.log(`   ${String(n).padStart(4)} × ${title}`);
    console.log('');
  }

  if (skipped.length) {
    const skipTitles = new Map();
    for (const c of skipped) {
      const k = String(c.title || '').trim() || '(no title)';
      skipTitles.set(k, (skipTitles.get(k) || 0) + 1);
    }
    const top = [...skipTitles.entries()].sort((a, b) => b[1] - a[1]).slice(0, VERBOSE ? 500 : 15);
    console.log(`SKIPPED — unrecognised titles${VERBOSE ? '' : ' (top 15)'}`);
    for (const [title, n] of top) console.log(`   ${String(n).padStart(4)} × ${title}`);
    console.log('   ^ these keep whatever priority they already have. If any of');
    console.log('     these should be high, add the pattern and re-run.\n');
  }

  console.log(`${changes.length} row(s) would change, ${unchanged.length} already correct.`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to commit these changes.');
    return;
  }

  console.log(`\nApplying ${changes.length} update(s)...`);
  let done = 0, failed = 0;
  for (let i = 0; i < changes.length; i += BATCH_SIZE) {
    const batch = changes.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async c => {
      try { await updatePriority(c.id, c.to); done++; }
      catch (e) { failed++; console.warn(`  ! ${c.first} ${c.last} (${c.id}): ${e.message}`); }
    }));
    console.log(`  ${Math.min(i + BATCH_SIZE, changes.length)}/${changes.length}`);
  }
  console.log(`\n[triage] Done — ${done} updated, ${failed} failed.`);
}

// Exported so the rule can be exercised against real titles without
// touching (or even connecting to) the database — see the dry-run notes
// above; reviewing the classification is the whole point of this script.
if (require.main === module) {
  main().catch(e => { console.error('[triage] Failed:', e.message); process.exit(1); });
}
module.exports = { classify };
