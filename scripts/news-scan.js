/**
 * news-scan.js — Daily Belgium research news scan for Elsevier's
 * competitive/business interests specifically (not general science news),
 * angled for a sales agent selling ScienceDirect/Scopus/LeapSpace into
 * Belgium institutions.
 *
 * Two stages:
 * 1. Free discovery: queries Google News RSS per institution/category,
 *    keyword-filtered against tracked SEED_INSTITUTIONS, with query terms
 *    scoped to research-information/scholarly-publishing/AI-for-research
 *    topics rather than any AI or funding mention. AI Development & Adoption
 *    and Competitor Announcements each run two query angles per entity
 *    (institution or competitor) instead of one — see their queryFor
 *    comments below. Competitor Announcements runs per named LeapSpace
 *    competitor (TRACKED_COMPETITORS) instead of per institution. Runs
 *    server-side (GitHub Actions) since a browser can't fetch
 *    news.google.com directly (CORS) without a proxy.
 * 2. Relevance filter: keyword matching alone still lets through stories
 *    that are topically on-theme but not actually useful to a sales agent
 *    (e.g. a study-specific research grant that will never touch a library
 *    budget, or an AI model for an unrelated domain) — a single batched
 *    Claude Haiku call judges each freshly-discovered candidate against a
 *    category-specific bar (see the prompt in filterRelevance()) and drops
 *    anything that doesn't clear it, tagging keepers with a one-line "why
 *    it matters" note naming the institution/company and the angle.
 *    Requires ANTHROPIC_API_KEY; skipped (keyword matches kept as-is) if
 *    unset, same fallback pattern as competitor-scan.js.
 *
 * Run: node scripts/news-scan.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const DATA_FILE = 'data/news.json';
const OVERVIEW_FILE = 'data/news-overview.json';
const STATE_FILE = 'data/news-scan-state.json';
const ARCHIVE_FILE = 'data/archive/news.json';
const ARCHIVE_AGE_DAYS = 7;
const MAX_STORED_ARTICLES = 300;
const MAX_AGE_DAYS = 14;
const REQUEST_DELAY_MS = 350;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RELEVANCE_MODEL = 'claude-haiku-4-5';
// Each article now carries a full structured analysis (bottom line, key
// findings, impact scoring, entities, action items) rather than a couple of
// short strings, so a full-size batch would risk running past a safe output
// budget — capped much lower than the old plain-summary pass, with max_tokens
// raised to match.
const MAX_ANALYSIS_BATCH = 20;
const ANALYSIS_MAX_TOKENS = 8192;
// Both filterRelevance and backfillAnalysis used to send their whole batch
// (up to MAX_ANALYSIS_BATCH) in a single call. In production, a batch of 17
// rich-schema items came back with only ~6-7 objects — the model just didn't
// finish all of them, and the code accepted the short response as complete,
// leaving the rest permanently un-analyzed. Chunking into small groups keeps
// each single call's expected output well within budget so it reliably
// returns one object per item.
const CHUNK_SIZE = 8;

const ELSEVIER_CONTEXT = `Elsevier is a scholarly research information and analytics company: ScienceDirect (full-text journal platform), Scopus (abstract/citation database), and LeapSpace (Elsevier's new AI-assisted research workspace — literature search, author search, funding discovery, writing coach, claim-checking, deep research reports, reading assistant, paper comparison). Its business depends on universities, medical centres, and research institutes subscribing to and using these tools, and on staying ahead of competitors like Clarivate/Web of Science, Digital Science/Dimensions, Springer Nature, Wiley, OpenAlex, Google Scholar, Semantic Scholar, and AI research-assistant tools (Elicit, scite, Consensus, SciSpace).`;

// Keep in sync with SEED_INSTITUTIONS in index.html
const BE_UNIVERSITIES = [
  'KU Leuven', 'Ghent University', 'University of Antwerp',
  'Vrije Universiteit Brussel', 'Hasselt University', 'UCLouvain',
  'Université de Liège', 'Université libre de Bruxelles',
  'University of Namur', 'Université de Mons',
];
const BE_MEDICAL = [
  'UZ Leuven (University Hospitals Leuven)', 'Ghent University Hospital',
  'Antwerp University Hospital', 'UZ Brussel', 'CHU de Liège',
  'Cliniques universitaires Saint-Luc', 'Hôpital Erasme',
  'Institut Jules Bordet', 'CHU UCL Namur (Godinne)',
];
const BE_RESEARCH = [
  'imec', 'VIB (Vlaams Instituut voor Biotechnologie)', 'Flanders Make',
  'Sciensano', 'Royal Belgian Institute of Natural Sciences',
  'Royal Meteorological Institute of Belgium', 'Royal Observatory of Belgium',
  'International Solvay Institutes for Physics and Chemistry',
  'VITO (Flemish Institute for Technological Research)',
  'Royal Academies for Science and the Arts of Belgium',
  'Royal Belgian Institute for Space Aeronomy',
  'Egmont Institute (Royal Institute for International Relations)',
  'Bruegel', 'Itinera Institute',
  'Research Foundation – Flanders', 'F.R.S.-FNRS', 'King Baudouin Foundation',
  'Kom op tegen Kanker', 'Fondation contre le Cancer / Stichting tegen Kanker',
];
const ALL_INSTITUTIONS = [...BE_UNIVERSITIES, ...BE_MEDICAL, ...BE_RESEARCH];

// Named LeapSpace competitors tracked on the Competitor Insights page —
// kept in sync manually with data/leapspace-competitors.json's company names.
const TRACKED_COMPETITORS = [
  'Clarivate', 'Digital Science', 'Springer Nature', 'Wiley', 'Elicit',
  'scite', 'Consensus', 'SciSpace', 'Paperguide',
  'IGI Global Scientific Publishing', 'IEEE', 'Allen Institute for AI',
  'Google', 'OpenAI', 'Anthropic',
];

// Extra alias/acronym forms per canonical institution name, for cases the
// mechanical splitting in institutionMatchAliases() can't derive — mainly a
// non-English institution commonly referred to by its English name or a
// well-known acronym (e.g. "Université libre de Bruxelles" is almost always
// just "ULB" in press). institutionSearchName()/institutionMatchAliases()
// already handle a parenthetical/en-dash/slash gloss; this covers the
// remaining French/Dutch-named institutions and their common acronyms.
const INSTITUTION_ALIASES = {
  'Université de Liège': ['University of Liège', 'University of Liege', 'ULiège', 'ULiege'],
  'Université libre de Bruxelles': ['ULB', 'Free University of Brussels'],
  'Université de Mons': ['University of Mons', 'UMONS'],
  'UCLouvain': ['Université catholique de Louvain', 'Catholic University of Louvain'],
  'CHU de Liège': ['CHU Liège', 'CHU Liege', 'University Hospital of Liège', 'University Hospital of Liege'],
  'Cliniques universitaires Saint-Luc': ['Saint-Luc', 'Cliniques Saint-Luc'],
  'Hôpital Erasme': ['Erasme Hospital', 'Hopital Erasme'],
  'Royal Belgian Institute of Natural Sciences': ['RBINS'],
  'Royal Meteorological Institute of Belgium': ['RMI', 'KMI', 'IRM'],
  'Royal Observatory of Belgium': ['ROB'],
  'International Solvay Institutes for Physics and Chemistry': ['Solvay Institutes'],
  'Royal Belgian Institute for Space Aeronomy': ['BIRA-IASB', 'IASB', 'BIRA'],
  'F.R.S.-FNRS': ['FNRS'],
};

const CATEGORIES = [
  {
    key: 'ai_adoption',
    label: 'AI Development & Adoption',
    perInstitution: true,
    // Two angles per institution, both scoped to AI *for research/publishing*
    // specifically: (1) the institution building its own AI research tool
    // in-house — a build-vs-buy competitive signal — and (2) the institution
    // adopting/rolling out a (usually third-party) AI research tool, which
    // flags what's already in play at that account. Both matter to a sales
    // agent positioning LeapSpace/ScienceDirect/Scopus. Kept to the same
    // 3-clause shape (institution + angle-terms + context-terms) as the
    // rest of this file — a wider 5-clause version was tried and dropped:
    // Google News RSS's matching goes loose/fuzzy on overly long boolean
    // queries, so it returned huge raw hit counts that mostly didn't even
    // contain the institution's literal name.
    queryFor: (inst) => [
      `"${inst}" (develops OR builds OR "in-house AI") (research OR literature OR "scientific discovery" OR publishing OR library OR database OR "research assistant")`,
      `"${inst}" (adopts OR "rolls out" OR partners OR selects) AI (research OR literature OR "scientific discovery" OR publishing OR library OR database OR "research assistant")`,
    ],
  },
  {
    key: 'funding',
    label: 'Funding Received',
    perInstitution: true,
    // Scoped to funding that could plausibly convert into an Elsevier
    // purchase or renewal — research infrastructure/library/digital-tools
    // budgets — not a grant for a specific research project or study (which
    // never touches a library/subscription budget even if it's AI-related).
    // The relevance filter below applies the sharper "would this money buy
    // an Elsevier product" test; these keywords are just the first pass.
    queryFor: (inst) => `"${inst}" (funding OR grant OR investment OR budget) ("research infrastructure" OR library OR database OR subscription OR "open access" OR "research information" OR "AI tools" OR bibliometric OR CRIS OR "digital infrastructure")`,
  },
  {
    key: 'policy',
    label: 'Belgium Research Policy',
    perInstitution: false,
    // High-level/ministry-level only — policy that could move institutional
    // purchasing power or touch existing Elsevier subscriptions, not
    // individual-researcher or single-study stories.
    queries: [
      'Belgium research funding policy BELSPO OR FWO OR FNRS',
      'Belgium universities "open access" OR "open science" policy',
      'Belgium research assessment reform',
      'Belgium library Scopus OR "Web of Science" OR subscription cancellation',
      'Belgium VLIR OR FWO OR FNRS Elsevier OR "Web of Science" OR Springer national license negotiation',
    ],
  },
  {
    key: 'competitor_announcements',
    label: 'Competitor Announcements',
    perInstitution: true,
    entities: TRACKED_COMPETITORS,
    // Two angles per competitor: (1) the general product launch/update —
    // the competitive-landscape shift itself — and (2) a signal that a
    // specific Belgium institution is adopting, piloting, or evaluating
    // it, which is the more actionable one for a sales agent since it flags
    // a live or at-risk account.
    queryFor: (co) => [
      `"${co}" (launches OR unveils OR announces OR partnership OR collaborat* OR "rolls out" OR expands OR acquisition OR "new tool" OR "new feature") (research OR publishing OR AI OR "scientific literature" OR database OR scholarly OR "research assistant")`,
      `"${co}" (Belgium OR Belgian OR Flemish OR Walloon) (adopts OR selects OR partners OR pilots OR licenses OR subscribes OR trial OR evaluat*)`,
    ],
  },
];

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function saveJSON(path, data) {
  const dir = path.split('/').slice(0, -1).join('/');
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}
function makeId(url) {
  let hash = 0;
  for (let i = 0; i < url.length; i++) { hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0; }
  return 'news-' + Math.abs(hash).toString(36);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function stripCdata(s) {
  const m = String(s || '').match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return decodeEntities(m ? m[1] : s);
}
// Truncates cleanly when the model overruns its length budget. Tries, in
// order: (1) cut at the end of the last complete sentence, so the result
// reads as a finished thought with no ellipsis; (2) if no sentence boundary
// falls in a reasonable range, fall back to a word boundary (never mid-word)
// with a trailing ellipsis. A raw slice() would chop off mid-sentence or
// even mid-word, which is exactly what this exists to avoid.
function truncateClean(str, maxLen) {
  const s = String(str || '').trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentenceEnd > maxLen * 0.4) {
    return cut.slice(0, sentenceEnd + 1).trim();
  }
  if (/[.!?]$/.test(cut.trim()) && cut.trim().length > maxLen * 0.4) {
    return cut.trim();
  }
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + '…';
}
function sanitizeStringArray(arr, maxItems, maxLen) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(x => typeof x === 'string' && x.trim()).slice(0, maxItems).map(x => truncateClean(x, maxLen));
}
function sanitizeImpact(impact) {
  const clamp = v => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3; };
  const i = impact && typeof impact === 'object' ? impact : {};
  return { novelty: clamp(i.novelty), commercial: clamp(i.commercial), threat: clamp(i.threat), urgency: clamp(i.urgency) };
}
function sanitizeSourceType(v) {
  return v === 'primary' ? 'primary' : 'secondary';
}
// Shared JSON shape for one article's structured analysis — used in both
// the relevance-filter prompt (fresh candidates) and the backfill prompt
// (existing live articles that predate this schema or an older, thinner one).
const ANALYSIS_SCHEMA_PROMPT = `"bottomLine": "one punchy sentence capturing the single most important takeaway, under about 200 characters", "keyFindings": ["3 to 5 short, complete bullet points on what's new or what the article actually reports, each under about 140 characters — never cut a bullet off mid-sentence"], "whyItMatters": "1-2 complete sentences on the business/strategy implications for an Elsevier sales agent selling ScienceDirect/Scopus/LeapSpace here — name the institution/company and the angle — under about 260 characters total, never cut off mid-sentence", "impact": {"novelty": 1-5, "commercial": 1-5, "threat": 1-5, "urgency": 1-5} (your rating of technical novelty, commercial potential, competitive threat to Elsevier, and urgency to act — 1 low, 5 high), "entities": ["named companies, products/models, researchers, or papers mentioned — up to 6"], "actionItems": ["1 to 3 concrete, complete follow-up actions or open questions for the sales team, each under about 130 characters — never cut one off mid-sentence"], "sourceType": "primary" (this outlet is the original source — an official announcement, a university/company's own page, a press release) or "secondary" (third-party reporting/aggregation)`;

function applyAnalysis(article, v) {
  return {
    ...article,
    bottomLine: truncateClean(v.bottomLine, 260),
    keyFindings: sanitizeStringArray(v.keyFindings, 5, 200),
    whyItMatters: truncateClean(v.whyItMatters, 420),
    impact: sanitizeImpact(v.impact),
    entities: sanitizeStringArray(v.entities, 6, 60),
    actionItems: sanitizeStringArray(v.actionItems, 3, 200),
    sourceType: sanitizeSourceType(v.sourceType),
  };
}

// De-duplicates by article id, keeping the richer copy when the same id
// appears more than once (a stale bare entry from a failed/fallback run
// alongside a later successfully-analyzed one) rather than just the first
// or last occurrence.
function dedupeArticles(list) {
  const byId = new Map();
  for (const a of list) {
    const existing = byId.get(a.id);
    if (!existing) { byId.set(a.id, a); continue; }
    const existingHasAnalysis = !!(existing.bottomLine && existing.keyFindings && existing.keyFindings.length);
    const currentHasAnalysis = !!(a.bottomLine && a.keyFindings && a.keyFindings.length);
    if (currentHasAnalysis && !existingHasAnalysis) byId.set(a.id, a);
  }
  return Array.from(byId.values());
}

// Shared low-level call to the Messages API. Returns the concatenated text
// content, or null (with a console.warn tagged by `context`) on any failure
// — network error, non-2xx, or timeout — so callers can fall back safely.
async function callHaiku(prompt, context, maxTokens = ANALYSIS_MAX_TOKENS) {
  let res;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: RELEVANCE_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
  } catch (e) {
    console.warn(`[news-scan] ${context} request failed (${e.message}).`);
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    console.warn(`[news-scan] ${context} API call failed (HTTP ${res.status}).`);
    return null;
  }
  const data = await res.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

// Some institution names (mainly Belgium's) bundle a descriptive gloss in
// parentheses, after an en-dash, or as a "French / Dutch" dual name — e.g.
// "VIB (Vlaams Instituut voor Biotechnologie)" or "Fondation contre le
// Cancer / Stichting tegen Kanker". Querying or matching against the full
// literal string (gloss included) essentially never succeeds against real
// news text, which uses one short form or the other but not both stitched
// together. institutionSearchName() extracts just the primary short form
// for building the Google News query; institutionMatches() accepts any
// standalone form (primary + gloss + each side of a "/" split) in the
// post-query relevance filter, since an article may use any of them. Also
// diacritic-insensitive (e.g. "Liège"/"Liege") since English-language
// coverage often drops accents.
function stripDiacritics(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function institutionSearchName(inst) {
  return inst.split(' (')[0].split(' – ')[0].split(' / ')[0].trim();
}
function institutionMatchAliases(inst) {
  const aliases = new Set([institutionSearchName(inst)]);
  const parenMatch = inst.match(/\(([^)]+)\)/);
  if (parenMatch) aliases.add(parenMatch[1].trim());
  for (const part of inst.split(' / ')) {
    const cleaned = part.replace(/\([^)]*\)/g, '').trim();
    if (cleaned) aliases.add(cleaned);
  }
  if (inst.includes(' – ')) for (const part of inst.split(' – ')) aliases.add(part.trim());
  for (const a of INSTITUTION_ALIASES[inst] || []) aliases.add(a);
  return Array.from(aliases).filter(Boolean);
}
function institutionMatches(inst, text) {
  const normalizedText = stripDiacritics(text);
  return institutionMatchAliases(inst).some(alias =>
    new RegExp(stripDiacritics(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(normalizedText)
  );
}

// Minimal RSS 2.0 <item> parser via regex — Google News RSS is well-formed
// enough that a full XML parser isn't worth the extra dependency.
function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const title = stripCdata((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const link = stripCdata((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
    const pubDate = stripCdata((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]);
    const source = stripCdata((block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]);
    const description = stripCdata((block.match(/<description>([\s\S]*?)<\/description>/) || [])[1]);
    if (title && link) items.push({ title, link, pubDate, source, description });
  }
  return items;
}

// Belgium is genuinely bilingual (Dutch/Flemish + French/Walloon) — a single
// Google News edition only covers one language community's press. Querying
// only BE:nl (Dutch) means the francophone institutions in this file's
// tracked list (ULB, Université de Liège, Université de Mons, Cliniques
// universitaires Saint-Luc, the French side of Fondation contre le Cancer,
// etc. — roughly half the list) would never surface any of their French-
// language press coverage, however much of it genuinely exists. Query both
// editions and merge, deduping by link (the same story sometimes appears
// in both editions' index).
const CEID_VARIANTS = ['BE:nl', 'BE:fr'];

async function fetchGoogleNewsRssOnce(query, ceid) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=BE&ceid=${ceid}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NL-CRM-NewsBot/1.0; +mailto:venturino.dino@gmail.com)' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseRssItems(xml);
  } catch (e) {
    clearTimeout(timer);
    console.warn(`  ! RSS fetch failed for "${query}" (${ceid}): ${e.message}`);
    return [];
  }
}

async function fetchGoogleNewsRss(query) {
  const seenLinks = new Set();
  const merged = [];
  for (let i = 0; i < CEID_VARIANTS.length; i++) {
    const items = await fetchGoogleNewsRssOnce(query, CEID_VARIANTS[i]);
    for (const item of items) {
      if (seenLinks.has(item.link)) continue;
      seenLinks.add(item.link);
      merged.push(item);
    }
    if (i < CEID_VARIANTS.length - 1) await sleep(REQUEST_DELAY_MS);
  }
  return merged;
}

function isRecent(pubDate) {
  if (!pubDate) return true; // don't drop items Google didn't date
  const d = new Date(pubDate);
  if (isNaN(d)) return true;
  return (Date.now() - d.getTime()) / 86400000 <= MAX_AGE_DAYS;
}

function toISODate(pubDate) {
  const d = new Date(pubDate);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function isOlderThanDays(dateStr, days) {
  if (!dateStr) return false; // no date info — keep it in the live feed rather than guess
  const d = new Date(dateStr);
  if (isNaN(d)) return false;
  return (Date.now() - d.getTime()) / 86400000 > days;
}

function relevancePrompt(batch) {
  return `${ELSEVIER_CONTEXT}

You are filtering this news feed for an Elsevier sales agent selling ScienceDirect/Scopus/LeapSpace into Belgium institutions. For each numbered article below, decide whether it's genuinely relevant using the category-specific bar for its bracketed category:

- [AI Development & Adoption]: keep only if it's a Belgium institution (mainly universities, though a medical centre or major research institute counts too) either developing its own AI research/publishing tool, or adopting/rolling out one (in-house or third-party) — either signals what's live at that account. Reject AI news with no research/scholarly-tools angle (e.g. clinical diagnostic AI, unrelated campus IT).
- [Funding Received]: keep ONLY if the money could plausibly be used to purchase or renew an Elsevier product — i.e. funding for research infrastructure, library systems, digital research tools, or an institutional research-support budget. Reject funding for a specific research project or study even if it mentions AI or "research" — that money never touches a library/subscription budget.
- [Belgium Research Policy]: keep only high-level, ministry/national-level policy (BELSPO, national funding agency, open-access mandates, VLIR/FWO/FNRS national licensing negotiations, research assessment reform) that could move institutional purchasing power or affect existing Elsevier subscriptions. Reject individual-researcher or single-study policy stories.
- [Competitor Announcements]: keep a genuine competitor product launch/update, OR a report that a Belgium institution is adopting, piloting, or evaluating a competitor's product. For an adoption story, the angle must name the institution and what it means for the competitive landscape or an existing Elsevier relationship there.

Mark irrelevant anything that's just general research findings or medical/scientific results, even if it mentions a tracked institution, "AI", or "funding".

${batch.map((c, i) => `${i + 1}. [${c.categoryLabel}] "${c.title}" — ${c.description || '(no description)'}`).join('\n')}

Respond with ONLY a JSON array of exactly ${batch.length} objects, one per article in the same order, each exactly: {"relevant": true|false, ${ANALYSIS_SCHEMA_PROMPT} — every field except "relevant" only if relevant, omit them (or use empty values) if not relevant}`;
}

async function filterRelevanceChunk(batch) {
  const text = await callHaiku(relevancePrompt(batch), 'Relevance filter');
  if (text === null) return batch; // network/API failure — keep unfiltered rather than lose candidates
  let verdicts;
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    verdicts = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (e) {
    console.warn('[news-scan] Could not parse relevance filter response for a chunk — keeping that chunk unfiltered.');
    return batch;
  }
  if (!Array.isArray(verdicts) || verdicts.length < batch.length) {
    console.warn(`[news-scan] Relevance filter returned ${Array.isArray(verdicts) ? verdicts.length : 0}/${batch.length} verdicts for a chunk — keeping that chunk unfiltered rather than dropping the unanswered ones.`);
    return batch;
  }

  const kept = [];
  batch.forEach((c, i) => {
    const v = verdicts[i];
    if (v && v.relevant) {
      kept.push(applyAnalysis(c, v));
    } else {
      console.log(`  - filtered out (not Elsevier-relevant): ${c.title}`);
    }
  });
  return kept;
}

async function filterRelevance(candidates) {
  if (!candidates.length) return candidates;
  if (!ANTHROPIC_API_KEY) {
    console.log('[news-scan] ANTHROPIC_API_KEY not set — skipping Elsevier-relevance filter, keeping all keyword matches.');
    return candidates;
  }

  const batch = candidates.slice(0, MAX_ANALYSIS_BATCH);
  const overflow = candidates.length - batch.length;
  if (overflow > 0) {
    console.log(`[news-scan] ${overflow} candidate(s) beyond the relevance-filter batch cap deferred to a future run.`);
  }

  const kept = [];
  for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
    const chunk = batch.slice(i, i + CHUNK_SIZE);
    kept.push(...await filterRelevanceChunk(chunk));
    if (i + CHUNK_SIZE < batch.length) await sleep(REQUEST_DELAY_MS);
  }
  return kept;
}

async function backfillAnalysisChunk(batch) {
  const prompt = `${ELSEVIER_CONTEXT}

For each numbered article below, produce a structured analysis for an Elsevier sales agent selling ScienceDirect/Scopus/LeapSpace into Belgium institutions.

${batch.map((c, i) => `${i + 1}. [${c.categoryLabel}] "${c.title}" — ${c.description || '(no description)'}`).join('\n')}

Respond with ONLY a JSON array of exactly ${batch.length} objects, one per article in the same order, each exactly: {${ANALYSIS_SCHEMA_PROMPT}}`;

  const text = await callHaiku(prompt, 'Backfill analysis');
  if (text === null) return new Map();
  let analyses;
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    analyses = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (e) {
    console.warn('[news-scan] Could not parse backfill analysis response for a chunk — skipping that chunk.');
    return new Map();
  }
  if (!Array.isArray(analyses) || analyses.length < batch.length) {
    console.warn(`[news-scan] Backfill analysis returned ${Array.isArray(analyses) ? analyses.length : 0}/${batch.length} for a chunk — the rest will retry on a future run.`);
  }

  const map = new Map();
  batch.forEach((c, i) => { if (analyses && analyses[i]) map.set(c.id, analyses[i]); });
  return map;
}

// Articles saved before this structured-analysis schema existed (or an even
// older plain-summary one) are missing bottomLine/keyFindings/etc. Re-run
// just those through a dedicated analysis-only call — unlike filterRelevance,
// this never drops an article: they already cleared the relevance bar once
// and are already live/visible, so a second pass only fills in the missing
// structure. Processed in small chunks (see CHUNK_SIZE) since a single big
// batch was observed in production to come back with fewer objects than
// requested, silently leaving the rest un-backfilled.
async function backfillAnalysis(items) {
  if (!items.length || !ANTHROPIC_API_KEY) return new Map();

  const batch = items.slice(0, MAX_ANALYSIS_BATCH);
  const map = new Map();
  for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
    const chunk = batch.slice(i, i + CHUNK_SIZE);
    const chunkMap = await backfillAnalysisChunk(chunk);
    for (const [id, v] of chunkMap) map.set(id, v);
    if (i + CHUNK_SIZE < batch.length) await sleep(REQUEST_DELAY_MS);
  }
  return map;
}

// One extra call per run that synthesizes ALL currently-live articles into a
// single merged analysis (same shape as a per-article one) — the News
// Summary modal's "Overview" reads this instead of trying to average
// per-article fields itself, since only an LLM can actually reason across
// the whole set (spot the throughline, roll up the real action items). Kept
// as its own small file (not embedded in news.json) so the News page and
// the summary modal can each fetch only what they need.
async function generateOverview(liveArticles) {
  if (!ANTHROPIC_API_KEY) return null;
  if (!liveArticles.length) {
    return { generatedAt: new Date().toISOString(), articleCount: 0, headline: '', bottomLine: 'No live stories to summarize yet.', keyFindings: [], whyItMatters: '', impact: sanitizeImpact({}), entities: [], actionItems: [] };
  }

  const digest = liveArticles.slice(0, 80).map((a, i) =>
    `${i + 1}. [${a.categoryLabel || a.category}] "${a.title}" — ${a.bottomLine || a.whyItMatters || a.summary || a.description || ''}`
  ).join('\n');

  const OVERVIEW_SCHEMA_PROMPT = `"headline": "one short punchy headline for the whole set, under about 120 characters", "bottomLine": "one complete sentence capturing the single most important takeaway across ALL of today's stories combined, under about 220 characters", "keyFindings": ["3 to 5 short, complete bullet points synthesizing the most important developments across ALL the articles — not a per-article recap, a market-level rollup — each under about 180 characters, never cut off mid-sentence"], "whyItMatters": "2-3 complete sentences on the overall business/strategy implications for the sales team this period, under about 380 characters total, never cut off mid-sentence", "impact": {"novelty": 1-5, "commercial": 1-5, "threat": 1-5, "urgency": 1-5} (your rating of the OVERALL period: technical novelty, commercial potential, competitive threat to Elsevier, and urgency to act — 1 low, 5 high), "entities": ["the most-recurring or most-significant named companies, products/models, researchers, or institutions across all the articles — up to 8"], "actionItems": ["2 to 4 concrete, complete follow-up actions or open questions for the sales team, prioritized, each under about 170 characters, never cut off mid-sentence"]`;

  const prompt = `${ELSEVIER_CONTEXT}

Below are the current live news items for an Elsevier sales agent selling ScienceDirect/Scopus/LeapSpace into Belgium institutions. Synthesize them into ONE merged executive overview of the whole market/region picture right now — don't just describe one article, roll up the throughline across all of them.

${digest}

Respond with ONLY one JSON object, exactly: {${OVERVIEW_SCHEMA_PROMPT}}`;

  const text = await callHaiku(prompt, 'Overview generation', ANALYSIS_MAX_TOKENS);
  if (text === null) return null;
  let v;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    v = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (e) {
    console.warn('[news-scan] Could not parse overview response — skipping.');
    return null;
  }

  return {
    generatedAt: new Date().toISOString(),
    articleCount: liveArticles.length,
    headline: truncateClean(v.headline, 140),
    bottomLine: truncateClean(v.bottomLine, 240),
    keyFindings: sanitizeStringArray(v.keyFindings, 5, 200),
    whyItMatters: truncateClean(v.whyItMatters, 420),
    impact: sanitizeImpact(v.impact),
    entities: sanitizeStringArray(v.entities, 8, 60),
    actionItems: sanitizeStringArray(v.actionItems, 4, 200),
  };
}

async function main() {
  const articles = readJSON(DATA_FILE, []);
  const existingUrls = new Set(articles.map(a => a.url));
  const candidateCounts = {};
  const freshCandidates = [];

  const needsBackfill = articles.filter(a => !a.bottomLine || !a.keyFindings || !a.keyFindings.length);
  let backfilledCount = 0;
  if (needsBackfill.length) {
    console.log(`[news-scan] ${needsBackfill.length} existing article(s) missing the structured analysis — backfilling...`);
    const map = await backfillAnalysis(needsBackfill.map(a => ({ id: a.id, title: a.title, description: a.description, categoryLabel: a.categoryLabel })));
    for (const a of articles) {
      if (map.has(a.id)) { Object.assign(a, applyAnalysis(a, map.get(a.id))); backfilledCount++; }
    }
    console.log(`[news-scan] Backfilled ${backfilledCount} article(s).`);
  }

  for (const category of CATEGORIES) {
    console.log(`[news-scan] Searching: ${category.label}...`);
    let categoryCandidates = 0;

    const jobs = category.perInstitution
      ? (category.entities || ALL_INSTITUTIONS).flatMap(inst => {
          // Query with the cleaned short name (see institutionSearchName) —
          // querying Google News for the full literal name, gloss included,
          // returns almost nothing for a name like "VIB (Vlaams Instituut
          // voor Biotechnologie)". `inst` itself is kept for the job tuple
          // so the post-filter match and the stored article still use/accept
          // the full canonical name.
          const q = category.queryFor(institutionSearchName(inst));
          return (Array.isArray(q) ? q : [q]).map(query => ({ inst, query }));
        })
      : category.queries.map(q => ({ inst: null, query: q }));

    for (const job of jobs) {
      const items = await fetchGoogleNewsRss(job.query);
      await sleep(REQUEST_DELAY_MS);
      categoryCandidates += items.length;

      for (const item of items) {
        if (!isRecent(item.pubDate)) continue;
        if (existingUrls.has(item.link)) continue;
        // For per-institution queries, require the institution name (or one of
        // its aliases — see institutionMatches) to actually appear in the
        // title/description — Google News RSS relevance ranking is loose.
        if (job.inst && !institutionMatches(job.inst, item.title + ' ' + item.description)) {
          continue;
        }

        freshCandidates.push({
          id: makeId(item.link),
          title: String(item.title).slice(0, 200),
          description: String(item.description || '').replace(/<[^>]*>/g, '').slice(0, 400),
          institution: job.inst,
          category: category.key,
          categoryLabel: category.label,
          url: String(item.link).slice(0, 500),
          sourceName: String(item.source || '').slice(0, 150),
          publishedDate: toISODate(item.pubDate),
          foundDate: new Date().toISOString().slice(0, 10),
          autoDiscovered: true,
        });
        existingUrls.add(item.link);
        console.log(`  + [${category.key}] ${item.title}`);
      }
    }
    candidateCounts[category.key] = categoryCandidates;
  }

  console.log(`[news-scan] ${freshCandidates.length} keyword-matched candidate(s) found — running Elsevier-relevance filter...`);
  const relevant = await filterRelevance(freshCandidates);
  for (const article of relevant) articles.unshift(article);
  const totalAdded = relevant.length;

  // A stale bare entry (e.g. saved by an old fallback/error path) can end up
  // sharing an id with a later, properly-analyzed copy — dedupe before
  // archiving/trimming so only one survives, preferring the analyzed copy.
  const deduped = dedupeArticles(articles);
  const dedupedCount = articles.length - deduped.length;
  if (dedupedCount > 0) console.log(`[news-scan] Removed ${dedupedCount} duplicate article id(s).`);

  // Move anything older than ARCHIVE_AGE_DAYS out of the live feed into a
  // standing archive file instead of just discarding it past
  // MAX_STORED_ARTICLES — keeps the News page recent while still preserving
  // history for later reference.
  const live = [];
  const toArchive = [];
  for (const a of deduped) {
    (isOlderThanDays(a.publishedDate || a.foundDate, ARCHIVE_AGE_DAYS) ? toArchive : live).push(a);
  }
  let archivedCount = 0;
  if (toArchive.length) {
    const archive = readJSON(ARCHIVE_FILE, []);
    const archivedIds = new Set(archive.map(a => a.id));
    for (const a of toArchive) {
      if (!archivedIds.has(a.id)) { archive.unshift(a); archivedIds.add(a.id); archivedCount++; }
    }
    if (archivedCount > 0) saveJSON(ARCHIVE_FILE, archive);
  }

  const trimmed = live.slice(0, MAX_STORED_ARTICLES);
  if (totalAdded > 0 || archivedCount > 0 || backfilledCount > 0 || dedupedCount > 0) saveJSON(DATA_FILE, trimmed);

  // Regenerated every run regardless of whether anything changed above —
  // the live set can shift (an article aging out to archive) even with zero
  // new additions, and re-synthesizing is cheap next to the rest of the
  // pipeline (one call, fixed-size output regardless of how many articles
  // are live).
  console.log('[news-scan] Generating merged overview...');
  const overview = await generateOverview(trimmed);
  let overviewGenerated = false;
  if (overview) {
    saveJSON(OVERVIEW_FILE, overview);
    overviewGenerated = true;
  } else {
    console.log('[news-scan] Overview generation skipped or failed — leaving the previous overview file in place.');
  }

  saveJSON(STATE_FILE, {
    lastRun: new Date().toISOString(),
    lastAddedCount: totalAdded,
    lastCandidateCount: freshCandidates.length,
    lastArchivedCount: archivedCount,
    lastBackfilledCount: backfilledCount,
    lastOverviewGenerated: overviewGenerated,
    candidateCounts,
    source: ANTHROPIC_API_KEY
      ? 'Google News RSS (discovery) + Claude Haiku (Elsevier-relevance filter + overview synthesis)'
      : 'Google News RSS (free, no API key — relevance filter skipped)',
  });
  console.log(`[news-scan] Done — ${totalAdded} new article(s) added, ${archivedCount} archived, ${backfilledCount} backfilled, overview ${overviewGenerated ? 'refreshed' : 'unchanged'} (${freshCandidates.length} candidates found).`);
}

main().catch(e => {
  console.error('[news-scan] Failed:', e.message);
  try {
    saveJSON(STATE_FILE, { lastRun: new Date().toISOString(), lastAddedCount: 0, error: e.message });
  } catch { /* ignore */ }
  process.exit(1);
});
