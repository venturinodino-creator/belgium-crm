// Checks contacts against the ORCID public registry: does a person with
// this name hold an ORCID iD that lists this institution as an employer?
// A single unambiguous match is recorded on the row (orcid); when the ORCID
// record publishes an email at the institution and the CRM has none, that
// email is filled in. Every row is marked checked so it is looked up once.
// The New Contacts queue is checked first, then the CRM's own contacts, up
// to --limit rows a run. Run daily by .github/workflows/orcid-verify.yml.
//
// Why: the discovery agents queue people found on web pages, often with an
// email built from the institution's pattern, and the queue is accepted
// wholesale. An ORCID record with the same name and employer is independent
// confirmation that the person exists and is there, and its public email
// (when present) is one the person chose to publish. No API key is needed:
// pub.orcid.org's expanded search is open.
//
// Flags:  --limit N   rows to check this run (default 200)
//         --dry-run   look up and print, write nothing

const fs = require('fs');

const REGION = 'belgium';
const STATE_FILE = 'data/orcid-scan-state.json';
const SUPA_URL = 'https://cfhljbexesdrabmadpcc.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORCID_API = 'https://pub.orcid.org/v3.0/expanded-search/';
const PAUSE_MS = 300; // ORCID's public API allows 24 requests a second; stay far under

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1], 10) || 200 : 200; })();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const supaHeaders = () => ({ apikey: SUPA_SERVICE_KEY, Authorization: `Bearer ${SUPA_SERVICE_KEY}` });

async function supaAll(pathAndQuery) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${pathAndQuery}`, {
      headers: { ...supaHeaders(), Range: `${from}-${from + 999}`, 'Range-Unit': 'items' },
    });
    if (res.status === 416) return out;
    if (!res.ok) throw new Error(`Supabase GET ${pathAndQuery}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
async function supaPatch(table, id, patch) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} ${id}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
}

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['university', 'universiteit', 'universitet', 'universite', 'universitaire', 'of', 'the', 'de', 'van', 'voor', 'for', 'and', 'en', 'og', 'et', 'des', 'der', 'die', 'institute', 'instituut', 'institut', 'center', 'centre', 'centrum', 'research', 'onderzoek', 'medical', 'medisch', 'hospital', 'ziekenhuis', 'college', 'applied', 'sciences', 'school', 'royal', 'koninklijk', 'koninklijke', 'national', 'nationaal', 'netherlands', 'nederland', 'nederlands', 'nederlandse', 'danish', 'denmark', 'danmark', 'belgium', 'belgian', 'belgique', 'belgie', 'flanders', 'vlaams', 'vlaamse', 'technology', 'technische', 'technical', 'library', 'bibliotheek', 'foundation', 'stichting', 'academy', 'academie']);

// The distinctive words of an institution's names: "delft", "twente",
// "radboud", "aarhus". An ORCID employer entry that shares one of them, or
// contains the whole name or short name, counts as this institution.
function instKeys(inst) {
  const words = new Set();
  [inst.name, inst.short].forEach(n => norm(n).split(' ').forEach(w => { if (w.length >= 4 && !STOP.has(w)) words.add(w); }));
  return { words, short: norm(inst.short), name: norm(inst.name) };
}
function employerMatches(entry, keys) {
  const e = norm(entry);
  if (!e) return false;
  if (keys.name && e.includes(keys.name)) return true;
  if (keys.short && keys.short.length >= 3 && e.split(' ').includes(keys.short)) return true;
  return e.split(' ').some(w => keys.words.has(w));
}

function orcidQuery(first, last) {
  const q = s => '"' + String(s).replace(/["\\]/g, ' ').trim() + '"';
  // A double or hyphenated given name often sits in ORCID as its first part.
  return `given-names:${q(String(first).split(/[\s-]/)[0])} AND family-name:${q(last)}`;
}

async function lookup(first, last) {
  const url = `${ORCID_API}?q=${encodeURIComponent(orcidQuery(first, last))}&rows=25`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'research-crm-orcid-verify/1.0' } });
    if (res.status === 429 || res.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`ORCID HTTP ${res.status}`);
    const json = await res.json();
    return json['expanded-result'] || [];
  }
  throw new Error('ORCID unavailable after retries');
}

// One person: returns { orcid, employer, email, elsewhere, ambiguous }.
async function verify(first, last, inst, currentEmail) {
  const keys = instKeys(inst);
  const results = await lookup(first, last);
  const here = results.filter(r => (r['institution-name'] || []).some(n => employerMatches(n, keys)));
  if (here.length !== 1) return { orcid: null, elsewhere: results.length, ambiguous: here.length > 1 };
  const r = here[0];
  const domain = (currentEmail || '').split('@')[1] || '';
  const pub = (r.email || []).find(e => domain ? e.toLowerCase().endsWith('@' + domain.toLowerCase()) : /@/.test(e)) || null;
  return { orcid: r['orcid-id'], employer: (r['institution-name'] || []).find(n => employerMatches(n, keys)), email: pub, elsewhere: results.length - 1, ambiguous: false };
}

async function main() {
  if (!SUPA_SERVICE_KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(1); }
  const insts = await supaAll(`crm_institutions?select=id,name,short&region=eq.${REGION}`);
  const instById = Object.fromEntries(insts.map(i => [i.id, i]));
  const pending = (await supaAll(`pending_contacts?select=id,first,last,email,notes,institution_id,institution_name&region=eq.${REGION}&status=eq.pending&orcid_checked_at=is.null&order=created_at.desc`))
    .map(r => ({ table: 'pending_contacts', id: r.id, first: r.first, last: r.last, email: r.email, notes: r.notes, instId: r.institution_id, instName: r.institution_name }));
  const crm = (await supaAll(`crm_contacts?select=id,first,last,email,notes,inst_id&region=eq.${REGION}&orcid_checked_at=is.null&order=last.asc`))
    .map(r => ({ table: 'crm_contacts', id: r.id, first: r.first, last: r.last, email: r.email, notes: r.notes, instId: r.inst_id }));
  const queue = [...pending, ...crm];
  const batch = queue.slice(0, LIMIT);
  console.log(`${pending.length} pending + ${crm.length} CRM contact(s) unchecked in ${REGION}; checking ${batch.length} this run`);

  let checked = 0, verified = 0, emails = 0, ambiguous = 0, failed = 0;
  for (const c of batch) {
    if (!c.first || !c.last) { checked++; if (!DRY_RUN) await supaPatch(c.table, c.id, { orcid_checked_at: new Date().toISOString() }).catch(() => {}); continue; }
    const inst = instById[c.instId] || { id: c.instId, name: c.instName || '', short: '' };
    const patch = { orcid_checked_at: new Date().toISOString() };
    let line;
    try {
      const v = await verify(c.first, c.last, inst, c.email);
      if (v.orcid) {
        patch.orcid = v.orcid;
        verified++;
        line = `✓ ${v.orcid}  (${v.employer})`;
        // A published address at the institution fills a blank, or replaces a
        // constructed guess in the queue (the CRM's own emails are left alone).
        const constructed = c.table === 'pending_contacts' && /constructed/i.test(c.notes || '');
        if (v.email && (!c.email || constructed) && v.email.toLowerCase() !== (c.email || '').toLowerCase()) {
          patch.email = v.email;
          patch.notes = ((c.notes || '').replace(/Email constructed[^.]*\./, '').trim() + ' Email confirmed from the person\'s ORCID record.').trim();
          emails++;
          line += `  email -> ${v.email}`;
        }
      } else if (v.ambiguous) {
        ambiguous++;
        line = `? several ORCID records at this institution share the name — left unverified`;
      } else {
        line = `· no ORCID record at ${inst.short || inst.name}${v.elsewhere ? ` (${v.elsewhere} elsewhere)` : ''}`;
      }
      checked++;
    } catch (e) {
      failed++;
      console.log(`  ${(c.first + ' ' + c.last).padEnd(30)} ✗ ${e.message}`);
      continue; // not marked checked: retried next run
    }
    console.log(`  ${(c.first + ' ' + c.last).padEnd(30)} ${(inst.short || inst.name || '').slice(0, 14).padEnd(15)} ${line}`);
    if (!DRY_RUN) {
      try { await supaPatch(c.table, c.id, patch); }
      catch (e) { failed++; console.log(`    save failed: ${e.message}`); }
    }
    await sleep(PAUSE_MS);
  }
  console.log(`\nDone: ${checked} checked, ${verified} verified, ${emails} email(s) filled, ${ambiguous} ambiguous, ${failed} failed. ${Math.max(0, queue.length - batch.length)} left for the next run.`);
  if (DRY_RUN) { console.log('(dry run — nothing written)'); return; }
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    lastRun: new Date().toISOString(), lastChecked: checked, lastVerified: verified,
    lastEmailsFilled: emails, lastAmbiguous: ambiguous, lastFailed: failed, remaining: Math.max(0, queue.length - batch.length),
  }, null, 2) + '\n');
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { verify, instKeys, employerMatches, orcidQuery };
