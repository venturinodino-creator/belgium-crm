/**
 * discover-staff.js — Decision-maker discovery scan.
 *
 * Companion to discover.js. That script scrapes OpenAlex, which indexes paper
 * *authors*, so every contact it returns is a researcher — it can never surface
 * the library, collection and research-support leads who actually hold
 * subscription budgets. This script reads the institution staff/contact
 * directories listed in data/staff-sources.json instead, keeps only people
 * whose job title reads as a decision-maker, and files them into the same
 * pending_contacts review queue with their real title.
 *
 * Emails are taken from the page when published. Where a directory lists a role
 * but routes mail through a shared inbox, the address is constructed from the
 * institution domain and flagged for verification — the same convention
 * discover.js uses.
 *
 * Usage:
 *   node scripts/discover-staff.js              # dry run unless the service key is set
 *   node scripts/discover-staff.js --dry-run    # never writes, always prints
 *   node scripts/discover-staff.js --limit 40   # cap candidates this run
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const SOURCES_FILE = 'data/staff-sources.json';
const PENDING_FILE = 'data/pending-staff-contacts.json'; // local audit trail only
const STATE_FILE   = 'data/staff-scan-state.json';
const REGION       = 'belgium';

const SUPA_URL = 'https://cfhljbexesdrabmadpcc.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run') || !SUPA_SERVICE_KEY;
// Prints every person a page lists, matched or not — use when adding a new
// source URL to see what the extractor can actually read off it.
const VERBOSE = args.includes('--verbose');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i !== -1 && args[i + 1] ? parseInt(args[i + 1], 10) : 60;
})();

const UA = 'NL-CRM-Bot/1.0 (mailto:venturino.dino@gmail.com)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Role taxonomy ──────────────────────────────────────────────────────────
// Titles that indicate someone with budget, policy or collection authority.
//
// Seniority words are accepted on their own here, without needing a nearby
// "library"/"research" word. That would be far too loose in general, but this
// rule is only ever applied to the curated library and research-support
// directories in staff-sources.json — on those pages a bare "Teamlead" or
// "Departement head" already means the library one. EXCLUDE_RE below carries
// the weight of keeping juniors and service desks out.
const DECISION_MAKER_RE = new RegExp([
  '\\b(?:director|directeur|direct(?:ie|rice)|head|hoofd|chief|manager|coordinator|co[oö]rdinator',
  '|teamlead|team\\s?leader|teamleider|dean|decaan|kabinetschef',
  '|head\\s+librarian|hoofdbibliothecaris|university\\s+librarian|chief\\s+librarian|bibliothecaris)\\b',
].join(''), 'i');

// Roles that look senior but are not buyers — filtered out to keep the queue clean.
const EXCLUDE_RE = /\b(?:student|intern|trainee|volunteer|assistant|assistent|front\s?office|desk|helpdesk|receptio)\b/i;

function isDecisionMaker(role) {
  if (!role) return false;
  if (EXCLUDE_RE.test(role)) return false;
  return DECISION_MAKER_RE.test(role);
}

// ── HTML helpers ───────────────────────────────────────────────────────────
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&#8217;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[​‎‏]/g, '');
}
// Drops complete tags, then any dangling partial tag left by slicing a fixed
// number of characters out of the middle of the markup (e.g. a trailing
// '<a href=' with no closing '>'), which would otherwise survive into the role.
const strip = s => decodeEntities(
  String(s).replace(/<[^>]*>/g, ' ').replace(/<[^>]*$/, ' ')
).replace(/\s+/g, ' ').trim();

function cleanRole(raw) {
  let r = strip(raw);
  // Phone numbers frequently sit in the cell next to the role and get swept up.
  r = r.replace(/\+?\d[\d\s().\/-]{6,}\d/g, ' ');
  // Directory pages often run several people together in one blob; cut at the
  // point a second person's name starts so a role never absorbs the next entry.
  const nextPerson = /\s[-–—]\s(?=[A-ZÀ-Þ][a-zà-ÿ]+\s+[A-ZÀ-Þ])/.exec(r);
  if (nextPerson) r = r.slice(0, nextPerson.index);
  r = r.replace(/\s+/g, ' ')
       .replace(/^[\s\-–—:,/|•+]+/, '')
       .replace(/[\s\-–—:,/|•+]+$/, ''); // '+' is left behind by phone stripping
  if (/[@<>]|https?:\/\//.test(r)) return '';
  if (r.length > 90) r = r.slice(0, 90).replace(/\s+\S*$/, '');
  return r.trim();
}

function looksLikePersonName(n) {
  if (!n || n.length > 60) return false;
  if (/[@\d]|https?:/.test(n)) return false;
  const words = n.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  // at least two capitalised words (handles "van Daele", "De Wilde")
  return words.filter(w => /^[A-ZÀ-Þ]/.test(w)).length >= 2;
}

/**
 * Pulls {name, role, email} from a staff page. Tries the reliable shape first
 * (a table row holding a mailto link), then a mailto-anchor + nearby-text pass,
 * then a name/role pass for directories that publish no personal addresses.
 */
function extractPeople(html) {
  const found = new Map(); // key -> person, dedup within a page

  const add = (name, role, email) => {
    name = strip(name); role = cleanRole(role); email = (email || '').trim().toLowerCase();
    if (!looksLikePersonName(name)) return;
    const key = (email || name).toLowerCase();
    const prev = found.get(key);
    // keep the entry with the more informative role
    if (!prev || (role && role.length > (prev.role || '').length)) {
      found.set(key, { name, role: role || (prev && prev.role) || '', email: email || (prev && prev.email) || '' });
    }
  };

  // 1. table rows containing a mailto link
  for (const row of html.match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
    const mail = /href=["']mailto:([^"'?]+)/i.exec(row);
    const anchor = /<a[^>]*mailto:[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!mail || !anchor) continue;
    const cells = (row.match(/<td\b[\s\S]*?<\/td>/gi) || []).map(strip).filter(Boolean);
    const name = strip(anchor[1]);
    const role = cells.find(c => c !== name && !c.includes(mail[1]) && !/^[+\d\s()./-]+$/.test(c)) || '';
    add(name, role, mail[1]);
  }

  // 2. mailto anchors anywhere, role from the text that follows. The window is
  //    cut at the next anchor so a role can never swallow the following
  //    person's name (which lives inside that anchor).
  const anchorRe = /<a[^>]*href=["']mailto:([^"'?]+)["'][^>]*>([\s\S]*?)<\/a>([\s\S]{0,120})/gi;
  let m;
  while ((m = anchorRe.exec(html))) add(m[2], m[3].split(/<a\b/i)[0], m[1]);

  // 3. "Name – Role" / "Name, Role" pairs in list items and headings, for
  //    directories that publish a shared inbox instead of personal addresses
  const blocks = html.match(/<(?:li|p|h[2-5]|div)\b[^>]*>[\s\S]{0,220}?<\/(?:li|p|h[2-5]|div)>/gi) || [];
  for (const b of blocks) {
    const t = strip(b);
    const pair = /^([A-ZÀ-Þ][^,–—:|]{2,40}?)\s*[,–—:|]\s*(.{3,90})$/.exec(t);
    if (!pair) continue;
    const [, a, bb] = pair;
    // Directories differ on ordering: most write "Name — Role", KU Leuven's
    // writes "Role: Name". Trust whichever side actually parses as a person —
    // and note that a title like "Head of Service" passes the name heuristic on
    // capitalisation alone, so a role-looking left side loses to a person-
    // looking right side.
    const swap = looksLikePersonName(bb) && (!looksLikePersonName(a) || DECISION_MAKER_RE.test(a));
    if (swap) add(bb, a, '');
    else add(a, bb, '');
  }

  return [...found.values()];
}

// ── Email construction (mirrors discover.js) ───────────────────────────────
function slugifyNamePart(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}
function constructEmail(name, domain) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length < 2 || !domain) return '';
  const f = slugifyNamePart(parts[0]);
  const l = slugifyNamePart(parts.slice(1).join(''));
  return f && l ? `${f}.${l}@${domain}` : '';
}

// ── Supabase ───────────────────────────────────────────────────────────────
async function supaFetch(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

async function fetchExistingPending() {
  if (!SUPA_SERVICE_KEY) return [];
  try {
    const res = await supaFetch(`${SUPA_URL}/rest/v1/pending_contacts?select=first,last,email&region=eq.${REGION}`, {
      headers: { apikey: SUPA_SERVICE_KEY, Authorization: `Bearer ${SUPA_SERVICE_KEY}` },
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
  const res = await supaFetch(`${SUPA_URL}/rest/v1/pending_contacts`, {
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

// ── Fetch ──────────────────────────────────────────────────────────────────
async function getHTML(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(timer); }
}

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function saveJSON(path, data) {
  const dir = path.split('/').slice(0, -1).join('/');
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

async function main() {
  const cfg = readJSON(SOURCES_FILE, null);
  if (!cfg || !Array.isArray(cfg.sources) || !cfg.sources.length) {
    console.error(`No sources configured in ${SOURCES_FILE}`);
    process.exit(1);
  }
  console.log(`Staff discovery — ${cfg.sources.length} institution(s), region ${REGION}`);
  if (DRY_RUN) {
    console.log(SUPA_SERVICE_KEY
      ? 'DRY RUN (--dry-run): nothing will be written.'
      : 'DRY RUN: SUPABASE_SERVICE_ROLE_KEY not set, so nothing will be written.');
  }

  const existingRemote = await fetchExistingPending();
  const localPending = readJSON(PENDING_FILE, []);
  const seenEmail = new Set([...existingRemote, ...localPending].map(c => (c.email || '').toLowerCase().trim()).filter(Boolean));
  const seenName = new Set([...existingRemote, ...localPending].map(c => `${c.first || ''} ${c.last || ''}`.toLowerCase().trim()).filter(Boolean));

  const candidates = [];
  const report = [];

  for (const src of cfg.sources) {
    let instFound = 0, instKept = 0;
    for (const url of src.urls || []) {
      if (candidates.length >= LIMIT) break;
      try {
        const html = await getHTML(url);
        const people = extractPeople(html);
        instFound += people.length;
        if (VERBOSE) {
          console.log(`    [verbose] ${url}`);
          for (const p of people) {
            console.log(`      ${isDecisionMaker(p.role) ? 'KEEP' : 'skip'}  ${p.name.padEnd(26)} ${(p.role || '(no role found)').slice(0, 50)}`);
          }
        }
        for (const p of people) {
          if (candidates.length >= LIMIT) break;
          if (!isDecisionMaker(p.role)) continue;
          const parts = p.name.split(/\s+/);
          const first = parts[0];
          const last = parts.slice(1).join(' ');
          const email = p.email || constructEmail(p.name, src.emailDomain);
          if (!email) continue;
          const el = email.toLowerCase();
          const nl = `${first} ${last}`.toLowerCase();
          if (seenEmail.has(el) || seenName.has(nl)) continue;
          seenEmail.add(el); seenName.add(nl);
          instKept++;
          candidates.push({
            first, last, title: p.role, dept: 'Library & Research Support',
            instId: src.instId, instName: src.instName,
            email, constructed: !p.email, source: url,
          });
        }
        console.log(`  ✓ ${src.instName}: ${people.length} listed, ${instKept} decision-maker(s) — ${url}`);
      } catch (e) {
        console.warn(`  ⚠ ${src.instName}: ${e.message} — ${url}`);
        report.push({ instId: src.instId, url, error: e.message });
      }
      await sleep(1500); // polite gap between requests
    }
    if (!instFound) report.push({ instId: src.instId, note: 'no people extracted' });
  }

  console.log(`\nFound ${candidates.length} new decision-maker candidate(s):`);
  for (const c of candidates) {
    console.log(`  ${(c.first + ' ' + c.last).padEnd(28)} ${String(c.title).slice(0, 42).padEnd(44)} ${c.email}${c.constructed ? '  (email constructed)' : ''}`);
  }

  if (DRY_RUN) {
    console.log('\nDry run — no records written.');
    return;
  }

  const rows = candidates.map(c => ({
    first: c.first, last: c.last, title: c.title, department: c.dept,
    institution_id: c.instId, institution_name: c.instName, email: c.email,
    research: '', source_url: c.source,
    notes: c.constructed ? 'Email constructed — please verify' : 'Email published on institution staff page',
    status: 'pending', region: REGION,
  }));

  let added = 0, failed = false;
  try { added = await insertPendingContacts(rows); }
  catch (e) { console.error('Supabase insert error:', e.message); failed = true; }

  saveJSON(STATE_FILE, {
    lastRun: new Date().toISOString(),
    lastAddedCount: added,
    sources: cfg.sources.length,
    issues: report,
  });
  if (!failed) saveJSON(PENDING_FILE, [...localPending, ...candidates]);
  else console.warn('Skipping audit-trail write — insert failed, candidates will be retried next run.');

  console.log(`\nDone — added ${added} decision-maker(s) to pending_contacts.`);
}

main().catch(e => { console.error(e); process.exit(1); });
