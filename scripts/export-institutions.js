/**
 * export-institutions.js — keeps data/institutions.json in step with the CRM.
 *
 * The public landing page cannot read crm_institutions directly: row-level
 * security filters every row for anonymous callers, which is why the board
 * used to be a hard-coded copy of the list and had drifted fifteen
 * institutions behind in the Netherlands. This exports the same set the app
 * shows into a file the landing page can fetch.
 *
 * Only public identity fields are written — id, name, short, type, city. No
 * contacts, no notes, nothing that isn't already on the page.
 *
 * Run: node scripts/export-institutions.js   (needs SUPABASE_SERVICE_ROLE_KEY)
 */
import { readFileSync, writeFileSync } from 'fs';

const OUT = 'data/institutions.json';
const REGION = 'belgium';
const SUPA_URL = 'https://cfhljbexesdrabmadpcc.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function main() {
  if (!KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY not set — leaving the existing file untouched.');
    process.exit(0); // not a failure: the committed file stays valid
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let rows;
  try {
    const res = await fetch(
      `${SUPA_URL}/rest/v1/crm_institutions?select=id,name,short,type,city&region=eq.${REGION}`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rows = await res.json();
  } finally { clearTimeout(timer); }

  if (!Array.isArray(rows) || !rows.length) {
    // An empty result is far more likely to be a query or permission problem
    // than a region genuinely losing every institution. Refuse to publish it.
    console.error(`Refusing to overwrite ${OUT}: query returned no rows.`);
    process.exit(1);
  }

  const out = rows
    .map(i => ({ id: i.id, name: i.name, short: i.short || i.name, type: i.type, city: i.city || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));

  let prev = [];
  try { prev = JSON.parse(readFileSync(OUT, 'utf8')); } catch (e) {}

  // A sudden collapse in the list usually means something upstream broke.
  if (prev.length && out.length < prev.length * 0.6) {
    console.error(`Refusing to overwrite ${OUT}: ${prev.length} institutions to ${out.length} is too large a drop.`);
    process.exit(1);
  }

  writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`Wrote ${out.length} institutions to ${OUT} (was ${prev.length}).`);
}

main().catch(e => { console.error(e); process.exit(1); });
