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
// Words that say nothing about which institution an employer entry names.
const STOP = new Set(['university', 'universiteit', 'universitet', 'universite', 'universitaire', 'universitair', 'of', 'the', 'de', 'van', 'voor', 'for', 'and', 'en', 'og', 'et', 'des', 'der', 'die', 'institute', 'instituut', 'institut', 'center', 'centre', 'centrum', 'research', 'onderzoek', 'medical', 'medisch', 'hospital', 'ziekenhuis', 'hospitalet', 'college', 'applied', 'sciences', 'science', 'school', 'royal', 'koninklijk', 'koninklijke', 'national', 'nationaal', 'netherlands', 'nederland', 'nederlands', 'nederlandse', 'danish', 'denmark', 'danmark', 'belgium', 'belgian', 'belgique', 'belgie', 'flanders', 'vlaams', 'vlaamse', 'technology', 'technische', 'technical', 'tekniske', 'library', 'bibliotheek', 'foundation', 'stichting', 'fonden', 'academy', 'academie', 'region', 'regionh', 'campus', 'location', 'department', 'faculty', 'business', 'health', 'group', 'unit', 'lab', 'laboratory', 'section', 'division']);
// Words that mark an institution as something other than the plain city
// university: "Vrije Universiteit Amsterdam" is not "University of Amsterdam".
const NOT_PLAIN = ['vrije', 'technische', 'technical', 'tekniske', 'umc', 'medical', 'medisch', 'hospital', 'hospitalet', 'ziekenhuis', 'business', 'applied', 'hogeschool', 'professionshojskole', 'college', 'polytechnic', 'it universit', 'katholieke', 'catholique', 'libre'];
const PLAIN_UNI = /^(university of|universiteit van|universiteit|universite de|universite|universitet i|)\s*([a-z]+)( university| universitet| universiteit)?$/;

// What identifies an institution in an ORCID employer entry: the whole
// name or short name; a distinctive word ("delft", "radboud", "wageningen",
// "imec"); or, for the plain city university, the city word next to a
// "univers-" word with none of the qualifiers that mark a different one.
// City words on their own are not enough (Copenhagen has six institutions),
// and an entry naming another city in the region is never a match.
function instKeys(inst, cities) {
  cities = cities || new Set();
  const words = new Set(), cityWords = new Set();
  const n = norm(inst.name), s = norm(inst.short);
  [n, s].forEach(x => x.split(' ').forEach(w => {
    if (w.length < 3 || STOP.has(w)) return;
    if (cities.has(w)) cityWords.add(w); else words.add(w);
  }));
  norm(inst.city).split(' ').forEach(w => { if (w.length >= 4 && cities.has(w)) cityWords.add(w); });
  const plain = PLAIN_UNI.test(n) && !NOT_PLAIN.some(q => n.includes(q));
  return { words, cityWords, cities, short: s, name: n, plainUniversity: plain };
}
function employerMatches(entry, keys) {
  const e = norm(entry);
  if (!e) return false;
  const toks = e.split(' ');
  if (keys.name && keys.name.length >= 6 && e.includes(keys.name)) return true;
  if (keys.short && keys.short.length >= 3 && toks.includes(keys.short)) return true;
  const ours = toks.some(w => keys.cityWords.has(w));
  const other = toks.some(w => keys.cities.has(w) && !keys.cityWords.has(w));
  if (other && !ours) return false;
  if (toks.some(w => keys.words.has(w))) return true;
  if (ours && keys.plainUniversity && /\buniver/.test(e) && !NOT_PLAIN.some(q => e.includes(q))) return true;
  return false;
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

// The institution's own email domain, from its website ("www.tue.nl" ->
// "tue.nl"), so only an address there can fill a blank.
function instDomain(inst) {
  const m = String(inst.website || '').toLowerCase().match(/^(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/);
  return m ? m[1] : '';
}

// One person: returns { orcid, employer, email, elsewhere, ambiguous }.
// `email` is a published address at the institution's own domain (or the
// domain of the address the CRM already holds), never one from another
// employer on the same record.
async function verify(first, last, inst, currentEmail, cities) {
  const keys = instKeys(inst, cities);
  const results = await lookup(first, last);
  const here = results.filter(r => (r['institution-name'] || []).some(n => employerMatches(n, keys)));
  if (here.length !== 1) return { orcid: null, elsewhere: results.length, ambiguous: here.length > 1 };
  const r = here[0];
  const domains = [((currentEmail || '').split('@')[1] || '').toLowerCase(), instDomain(inst)].filter(Boolean);
  const pub = (r.email || []).find(e => domains.some(d => e.toLowerCase().endsWith('@' + d) || e.toLowerCase().endsWith('.' + d))) || null;
  return { orcid: r['orcid-id'], employer: (r['institution-name'] || []).find(n => employerMatches(n, keys)), email: pub, elsewhere: results.length - 1, ambiguous: false };
}

async function main() {
  if (!SUPA_SERVICE_KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(1); }
  const insts = await supaAll(`crm_institutions?select=id,name,short,city,website&region=eq.${REGION}`);
  const instById = Object.fromEntries(insts.map(i => [i.id, i]));
  // Every city word in the region, so a city alone never identifies an institution.
  const cities = new Set();
  insts.forEach(i => norm(i.city).split(' ').forEach(w => { if (w.length >= 4 && !STOP.has(w)) cities.add(w); }));
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
      const v = await verify(c.first, c.last, inst, c.email, cities);
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
