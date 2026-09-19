// Deepens the OpenAlex picture of every tracked institution beyond the topic
// mix in data/research-focus.json: works per year over the last five years,
// open-access status, the funders behind the output, the publishers that
// carry it (with Elsevier's share), and the institutions it co-publishes
// with most. Writes data/research-output.json. Run weekly by
// .github/workflows/research-output-scan.yml.
//
// Why this exists: the profile page and the White Space table had a blank
// "Output" wherever the hand-researched dossier had no figure, and nothing
// on the page said who funds an institution's research or how much of it
// already lands in Elsevier journals. Every number here is a live OpenAlex
// works query, and the query URL is recorded so it can be checked.
//
// Institution resolution reuses data/research-focus.json, which already
// carries each institution's OpenAlex ID (resolved and verified by
// scripts/research-focus-scan.js). An institution that file could not
// resolve is skipped here with the same reason.

const fs = require('fs');
const path = require('path');

const MAILTO = 'venturino.dino@gmail.com';
const FOCUS_PATH = path.join(__dirname, '..', 'data', 'research-focus.json');
const OUT_PATH = path.join(__dirname, '..', 'data', 'research-output.json');
const ELSEVIER_PUBLISHER_ID = 'P4310320990'; // OpenAlex publisher record for Elsevier BV
const YEARS = 5;
const PAUSE_MS = 150; // OpenAlex polite pool allows 10 req/s; stay well under

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = (() => { const i = process.argv.indexOf('--inst'); return i > -1 ? process.argv[i + 1].split(',') : []; })();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function apiGet(url, attempt = 0) {
  const res = await fetch(url, { headers: { 'User-Agent': `research-crm-output-scan (mailto:${MAILTO})` } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 3) { await sleep(2000 * (attempt + 1)); return apiGet(url, attempt + 1); }
    throw new Error(`OpenAlex HTTP ${res.status} for ${url}`);
  }
  if (!res.ok) throw new Error(`OpenAlex HTTP ${res.status} for ${url}`);
  return res.json();
}

function groupUrl(filter, groupBy) {
  return `https://api.openalex.org/works?filter=${encodeURIComponent(filter)}&group_by=${groupBy}&per_page=200&mailto=${MAILTO}`;
}

// One institution: five grouped works queries over the same filter.
async function scanInstitution(instId, oaId, name, yearFrom, yearTo) {
  const filter = `authorships.institutions.id:${oaId},publication_year:${yearFrom}-${yearTo}`;
  const groups = {};
  let total = 0;
  for (const g of ['publication_year', 'open_access.oa_status', 'funders.id', 'primary_location.source.publisher_lineage', 'authorships.institutions.lineage']) {
    const json = await apiGet(groupUrl(filter, g));
    total = (json.meta && json.meta.count) || total;
    groups[g] = (json.group_by || []).map(x => ({ key: x.key, name: x.key_display_name, count: x.count }));
    await sleep(PAUSE_MS);
  }
  const byYear = [];
  for (let y = yearFrom; y <= yearTo; y++) {
    const hit = groups['publication_year'].find(x => String(x.key) === String(y));
    byYear.push({ year: y, count: hit ? hit.count : 0 });
  }
  const oa = {};
  groups['open_access.oa_status'].forEach(x => { oa[x.key] = x.count; });
  const closed = oa.closed || 0;
  const oaShare = total ? Math.round(((total - closed) / total) * 1000) / 10 : null;

  const self = `https://openalex.org/${oaId}`;
  const partners = groups['authorships.institutions.lineage']
    .filter(x => x.key !== self && x.key !== oaId)
    .slice(0, 6);
  const publishers = groups['primary_location.source.publisher_lineage'].slice(0, 6);
  const elsevier = groups['primary_location.source.publisher_lineage'].find(x => String(x.key).endsWith(ELSEVIER_PUBLISHER_ID));
  const elsevierCount = elsevier ? elsevier.count : 0;

  return {
    openalexId: oaId,
    openalexName: name,
    window: { from: yearFrom, to: yearTo },
    worksTotal: total,
    byYear,
    oa: { share: oaShare, byStatus: oa },
    funders: groups['funders.id'].slice(0, 8).map(x => ({ name: x.name, count: x.count })),
    publishers: publishers.map(x => ({ name: x.name, count: x.count })),
    elsevier: { count: elsevierCount, share: total ? Math.round((elsevierCount / total) * 1000) / 10 : null },
    partners: partners.map(x => ({ name: x.name, count: x.count })),
    apiUrl: `https://api.openalex.org/works?filter=${filter}`,
    worksUrl: `https://openalex.org/works?filter=${filter}`,
  };
}

async function main() {
  if (!fs.existsSync(FOCUS_PATH)) { console.error('data/research-focus.json missing — run research-focus-scan first'); process.exit(1); }
  const focus = JSON.parse(fs.readFileSync(FOCUS_PATH, 'utf8'));
  const insts = focus.institutions || {};
  const previous = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')) : { institutions: {} };
  const yearTo = new Date().getFullYear();
  const yearFrom = yearTo - (YEARS - 1);
  const out = {
    generatedAt: new Date().toISOString(),
    source: 'OpenAlex API (works grouped by year, OA status, funder, publisher, co-author institution)',
    window: { from: yearFrom, to: yearTo },
    institutions: {},
  };
  let ok = 0, skipped = 0, failed = 0;
  for (const [instId, rf] of Object.entries(insts)) {
    if (ONLY.length && !ONLY.includes(instId)) continue;
    if (!rf || !rf.openalexId) {
      out.institutions[instId] = { notFound: true, reason: (rf && rf.reason) || 'No OpenAlex institution record resolved for this organisation.' };
      skipped++;
      continue;
    }
    try {
      const rec = await scanInstitution(instId, rf.openalexId, rf.openalexName, yearFrom, yearTo);
      out.institutions[instId] = rec;
      ok++;
      console.log(`  ✓ ${(rf.openalexName || instId).padEnd(52)} ${String(rec.worksTotal).padStart(7)} works ${yearFrom}-${yearTo}  OA ${rec.oa.share}%  Elsevier ${rec.elsevier.share}%  funders: ${rec.funders.slice(0, 2).map(f => f.name).join(', ')}`);
    } catch (e) {
      failed++;
      // Keep last week's figures rather than blanking the card on a bad day.
      const prev = (previous.institutions || {})[instId];
      out.institutions[instId] = prev && prev.worksTotal ? { ...prev, stale: true, fetchError: e.message } : { fetchError: e.message };
      console.log(`  ✗ ${instId}: ${e.message}`);
    }
  }
  console.log(`\nDone: ${ok} scanned, ${skipped} without an OpenAlex record, ${failed} failed.`);
  if (DRY_RUN) { console.log('(dry run — not written)'); return; }
  if (ONLY.length) {
    // A partial run updates only the named institutions.
    out.institutions = { ...(previous.institutions || {}), ...out.institutions };
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
