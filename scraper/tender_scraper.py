"""
tender_scraper.py — Daily scraper for Belgium tenders that align with an
Elsevier product (Scopus, SciVal, Elsevier Pure).

Source: TED Europa (EU Official Journal) — the authoritative source for every
procurement notice above EU threshold, which is where CRIS / research
information system and bibliographic database tenders land.
Belgium's national portal (publicprocurement.be / BOSA e-Procurement) is an
Angular SPA with no public JSON API, so it is not scraped. Verified
2026-09-12: the obvious /api/* paths all return the SPA shell. Below-EU-
threshold Belgian notices are therefore out of reach for now.

CRIS (Current Research Information System) procurements are the highest-value
signal here and are flagged with isCRIS=true and category="CRIS".

Writes new tenders to data/tenders.json without duplicates, and (if any new
tenders were found) writes a summary for the workflow to post as a GitHub
issue — see write_notification().

Run: python scraper/tender_scraper.py
"""

import json
import os
import re
import secrets
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, date, timedelta, timezone
from pathlib import Path

# ── Config ───────────────────────────────────────────────────────────────────

REPO_ROOT    = Path(__file__).parent.parent
TENDERS_FILE = REPO_ROOT / "data" / "tenders.json"
STATE_FILE   = REPO_ROOT / "data" / "tenders-scan-state.json"

COUNTRY      = "Belgium"
COUNTRY_CODE = "BEL"

# Elsevier products in scope. ScienceDirect and the rest of the catalogue
# (Mendeley, Reaxys, ClinicalKey, Embase) are intentionally out of scope.
#
# "Pure" is NOT listed here: on its own it is a catastrophically noisy term
# (TED is full of "pure sodium chloride" road-salt contracts). It is handled
# as an ambiguous term via PAIR_RULES below, which is what actually catches
# the real ones — e.g. VUB's "UL-Elsevier - Pure - licenties en hosting",
# where "pure" and "elsevier" appear separately in the same notice.
ELSEVIER_PRODUCTS = ["Scopus", "SciVal", "Elsevier Pure"]

# Competitors, grouped by the Elsevier product they displace. Only names
# distinctive enough to stand alone belong here — "Dimensions", "Metis",
# "Haplo" and "Esploro" are ordinary words in procurement text and live in
# PAIR_RULES instead.
COMPETITOR_PRODUCTS = [
    # CRIS vendors — these compete head-to-head with Pure
    "Symplectic Elements", "Converis", "Vidatum", "Worktribe", "PlumX",
    # Bibliometrics / citation analytics
    "Web of Science", "InCites", "Journal Citation Reports", "Clarivate",
    "Academic Analytics", "OpenAlex",
]

# Category terms. A category hit only counts if PRODUCT_ALIGNMENT maps it to a
# specific named Elsevier product.
CATEGORY_KEYWORDS = [
    # CRIS — English
    "current research information system", "research information system",
    "research information management", "research management system",
    "research output management", "research portal", "CRIS",
    # Bibliometrics / databases — English
    "bibliometric", "scientometric", "citation database",
    "abstract and citation database", "academic database",
    "scholarly database", "publication database", "library database",
    "research analytics", "research intelligence",
    # CRIS / databases — Dutch (Flanders)
    "onderzoeksinformatiesysteem", "onderzoeksinformatie",
    "onderzoeksregistratie", "onderzoeksportaal",
    "publicatiedatabank", "wetenschappelijke databanken",
    "bibliometrisch", "bibliometrie", "literatuurdatabanken",
    # CRIS / databases — French (Wallonia/Brussels)
    "systeme d information recherche", "information de recherche",
    "bases de donnees scientifiques", "base de donnees bibliographique",
    "bibliometrique", "bibliometrie",
]

ALL_KEYWORDS = ELSEVIER_PRODUCTS + COMPETITOR_PRODUCTS + CATEGORY_KEYWORDS

# Every non-Elsevier keyword must resolve to the specific Elsevier product it
# competes with. Case-insensitive lookup; keys are lowercased at lookup time.
PRODUCT_ALIGNMENT = {
    # ── Research information systems / CRIS -> Elsevier Pure ──
    "current research information system": "Elsevier Pure",
    "research information system": "Elsevier Pure",
    "research information management": "Elsevier Pure",
    "research management system": "Elsevier Pure",
    "research output management": "Elsevier Pure",
    "research portal": "Elsevier Pure",
    "cris": "Elsevier Pure",
    "publication database": "Elsevier Pure",
    "symplectic elements": "Elsevier Pure",
    "symplectic": "Elsevier Pure",
    "converis": "Elsevier Pure",
    "vidatum": "Elsevier Pure",
    "worktribe": "Elsevier Pure",
    "haplo": "Elsevier Pure",
    "esploro": "Elsevier Pure",
    "metis": "Elsevier Pure",
    "pure": "Elsevier Pure",
    # ── Bibliometrics / analytics -> SciVal ──
    "bibliometric": "SciVal",
    "scientometric": "SciVal",
    "research analytics": "SciVal",
    "research intelligence": "SciVal",
    "incites": "SciVal",
    "journal citation reports": "SciVal",
    "academic analytics": "SciVal",
    "plumx": "SciVal",
    "dimensions": "SciVal",
    "digital science": "SciVal",
    # ── Citation / discovery database -> Scopus ──
    "citation database": "Scopus",
    "abstract and citation database": "Scopus",
    "academic database": "Scopus",
    "scholarly database": "Scopus",
    "library database": "Scopus",
    "web of science": "Scopus",
    "clarivate": "Scopus",
    "openalex": "Scopus",
    # ── Dutch (Flanders) ──
    "onderzoeksinformatiesysteem": "Elsevier Pure",
    "onderzoeksinformatie": "Elsevier Pure",
    "onderzoeksregistratie": "Elsevier Pure",
    "onderzoeksportaal": "Elsevier Pure",
    "publicatiedatabank": "Elsevier Pure",
    "bibliometrisch": "SciVal",
    "bibliometrie": "SciVal",
    "wetenschappelijke databanken": "Scopus",
    "literatuurdatabanken": "Scopus",
    # ── French (Wallonia/Brussels) ──
    "systeme d information recherche": "Elsevier Pure",
    "information de recherche": "Elsevier Pure",
    "bibliometrique": "SciVal",
    "bases de donnees scientifiques": "Scopus",
    "base de donnees bibliographique": "Scopus",
}

# Terms that mark a tender as a CRIS procurement specifically — the highest
# priority signal for the Pure sales motion.
CRIS_MARKERS = [
    "current research information system", "research information system",
    "research information management", "research management system",
    "research output management", "research portal", "cris", "pure",
    "converis", "symplectic", "symplectic elements", "worktribe",
    "esploro", "metis", "vidatum",
    "onderzoeksinformatiesysteem", "onderzoeksinformatie",
    "onderzoeksregistratie", "onderzoeksportaal",
    "systeme d information recherche", "information de recherche",
]

# ── Precision controls ───────────────────────────────────────────────────────
# Without these the scan drowns in false positives. Real examples caught in
# testing: "pure sodium chloride" (road salt) matched Pure; "the dimensions of
# the laboratory bench" matched Dimensions; "CRIS (Clientvolgsysteem)", a
# victim-support case system, matched CRIS.
#
# Each ambiguous term only counts when one of its qualifier phrases also
# appears in the notice. Qualifiers are deliberately specific to research
# information management — a bare "research" or "university" is not enough,
# because every university equipment tender contains both.
PAIR_RULES = {
    "pure": [
        "elsevier", "research information", "current research information",
        "research portal", "research output", "onderzoeksinformatie",
        "forskningsinformation", "bibliometri", "cris",
    ],
    "cris": [
        "research information", "current research information",
        "onderzoeksinformatie", "forskningsinformation", "research output",
        "research portal", "bibliometri", "scientometri",
    ],
    "metis": [
        "research information", "onderzoeksinformatie", "research output",
        "bibliometri", "publicatie", "cris",
    ],
    "dimensions": [
        "bibliometri", "scientometri", "citation database", "research analytics",
        "research information", "scopus", "web of science", "clarivate",
    ],
    "haplo":   ["research information", "research output", "cris"],
    "esploro": ["research information", "research output", "cris", "bibliometri"],
    "symplectic": ["research information", "research output", "cris",
                   "bibliometri", "publicatie", "elements"],
}

# CPV families a research-information or bibliographic-database procurement
# actually falls under. Verified against every true positive found in DK/BE/NL
# since 2024: 48 (software packages), 72 (IT services), 9251 (library
# services), 22200 (periodicals), 79980 (subscription services).
#
# A *category*-only match (e.g. the phrase "publication database") must sit in
# one of these families to count. A named product ("Scopus", "Elsevier Pure",
# "Web of Science") is distinctive enough to count on its own, whatever the
# CPV — that path is not gated. This is what keeps laboratory instruments,
# road salt and construction notices out.
RELEVANT_CPV_PREFIXES = ("48", "72", "9251", "22200", "79980", "7998")

# ── Helpers ──────────────────────────────────────────────────────────────────

def load_tenders() -> list:
    try:
        return json.loads(TENDERS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []

def save_tenders(tenders: list) -> None:
    TENDERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    TENDERS_FILE.write_text(
        json.dumps(tenders, indent=2, ensure_ascii=False), encoding="utf-8"
    )

def save_state(new_count: int, scanned: int, cris_count: int) -> None:
    state = {
        "lastRun": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "lastNewCount": new_count,
        "lastScannedCount": scanned,
        "lastCrisCount": cris_count,
    }
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")

def existing_ids(tenders: list) -> set:
    return {t["id"] for t in tenders}

def existing_titles(tenders: list) -> set:
    return {t["title"].lower().strip() for t in tenders}

def _term_ok(term: str, text: str) -> bool:
    """An ambiguous term only counts when one of its qualifiers co-occurs."""
    quals = PAIR_RULES.get(term.lower())
    if quals is None:
        return True
    return any(q in text for q in quals)

def _present(term: str, text: str) -> bool:
    """Whole-word match, so 'pure' does not fire on 'purely'."""
    return bool(re.search(r"(?<![a-z0-9])" + re.escape(term.lower()) + r"(?![a-z0-9])", text))

def _find(needles, text: str) -> str:
    """First needle present in text and satisfying its pair rule, if any."""
    for k in needles:
        if _present(k, text) and _term_ok(k, text):
            return k
    return ""

COUNTRY_LABEL = "Belgium"

def notice_is_domestic(notice: dict) -> bool:
    """Guard against TED's occasional mis-filed place-of-performance.

    Universitaet Wien's Elsevier database contract carries place-of-performance
    NLD in the TED feed, so a query scoped to the Netherlands returns it. Every
    TED notice title starts with its own country label ("Austria - Database
    services - ..."), so that is the tiebreaker: when the leading label names a
    different country, believe the label.
    """
    title = _pick_lang(notice.get("notice-title") or {})
    head  = title.split("–")[0].split(" - ")[0].strip()
    if not head or len(head) > 60:
        return True
    # Multi-country notices list ours among others — that still counts.
    if COUNTRY_LABEL.lower() in head.lower():
        return True
    # A leading label naming only other countries means it is not ours.
    return "," not in head and head.lower() == COUNTRY_LABEL.lower()

def cpv_is_relevant(cpvs) -> bool:
    """True when any CPV code sits in a family a CRIS / database procurement
    plausibly belongs to. Empty CPV is treated as relevant — better to let a
    keyword decide than to silently drop a notice with no classification."""
    if not cpvs:
        return True
    if isinstance(cpvs, str):
        cpvs = [cpvs]
    return any(str(c).startswith(RELEVANT_CPV_PREFIXES) for c in cpvs if c)

def is_relevant(title: str, description: str = "", cpvs=None) -> tuple:
    """Returns (relevant, elsevier_product, matched_competitor, is_cris).

    `elsevier_product` is always a specific named Elsevier product — never a
    generic category term. Matching runs in descending order of confidence:

      1. A named Elsevier product  -> accept, whatever the CPV.
      2. A named competitor product -> accept, whatever the CPV.
      3. A generic category phrase  -> accept ONLY if the CPV family is one a
         research-information procurement actually uses.

    Ambiguous terms ("Pure", "CRIS", "Dimensions") must additionally satisfy
    their PAIR_RULES qualifier in every one of those paths.
    """
    text = (title + " " + description).lower()
    is_cris = bool(_find(CRIS_MARKERS, text))

    # On a CRIS procurement the opportunity is Pure, whatever else the notice
    # mentions. Without this rule, Denmark's national Forskningsportal tender
    # came back labelled "Scopus" purely because its text names OpenAlex, and
    # TU Delft's CRIS came back as "Scopus" because the spec lists Scopus as a
    # required data source.
    def result(product: str, competitor: str):
        if is_cris and product != "Elsevier Pure":
            return True, "Elsevier Pure", competitor or product, True
        return True, product, competitor, is_cris

    hit = _find(ELSEVIER_PRODUCTS, text)
    if hit:
        return result(hit, _find(COMPETITOR_PRODUCTS, text))

    hit = _find(COMPETITOR_PRODUCTS, text)
    if hit:
        aligned = PRODUCT_ALIGNMENT.get(hit.lower())
        if aligned:
            return result(aligned, hit)

    # "Pure" on its own is only meaningful once its pair rule has held.
    if _present("pure", text) and _term_ok("pure", text):
        return result("Elsevier Pure", _find(COMPETITOR_PRODUCTS, text))

    hit = _find(CATEGORY_KEYWORDS, text)
    if hit and cpv_is_relevant(cpvs):
        aligned = PRODUCT_ALIGNMENT.get(hit.lower())
        if aligned:
            return result(aligned, _find(COMPETITOR_PRODUCTS, text))

    return False, "", "", False

def fetch_json(url: str, data: bytes = None, headers: dict = None):
    """HTTP GET/POST returning parsed JSON, or None on error."""
    req = urllib.request.Request(url, data=data, headers=headers or {})
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        print(f"  HTTP {e.code} for {url} :: {body}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"  Error fetching {url}: {e}", file=sys.stderr)
        return None

# ── TED Europa scraper ───────────────────────────────────────────────────────
# API v3 expert-query syntax. Field names verified against the live API on
# 2026-09-12.
#
# Two rules this scraper depends on, both learned the hard way:
#
#  1. The country filter MUST be inside the query. The previous version
#     searched EU-wide, took page 1 (50 rows) and filtered to this country in
#     Python afterwards — so any keyword with more than 50 EU-wide matches had
#     every domestic notice truncated away before it was ever examined. That
#     is why Denmark and Belgium reported zero tenders for months.
#
#  2. Use FT="..." (exact full text), not notice-title~"..." (fuzzy, title
#     only). The fuzzy operator matched "Scopy"/"scope"/"Sconto" for "Scopus",
#     while title-only matching missed every CRIS notice whose TED title is
#     just the generic CPV label ("IT services: consulting, software
#     development, Internet and support").

TED_URL = "https://api.ted.europa.eu/v3/notices/search"
TED_FIELDS = [
    "publication-number", "notice-title", "buyer-name", "publication-date",
    "deadline", "estimated-value-lot", "total-value", "tender-value",
    "contract-nature", "place-of-performance", "buyer-country", "links",
    "notice-type", "procedure-type", "winner-name",
    "description-lot", "description-proc", "classification-cpv",
    "contract-duration-end-date-lot", "duration-period-value-lot",
    "duration-period-unit-lot",
]
TED_LOOKBACK_DAYS = 400   # ~13 months, so a full annual renewal cycle stays in view
TED_PAGE_LIMIT    = 100   # API max per page
TED_MAX_PAGES     = 10

# Overridden by --days on the command line, for a one-off historical backfill.
# The daily scheduled run always uses the default: a short window is what keeps
# "new" meaning new. Seeding the backlog is a separate, manual operation.
LOOKBACK_DAYS = TED_LOOKBACK_DAYS

# Notice types worth surfacing. Awards (can-*) matter as much as open calls:
# they name the winner, the value, and when the contract expires — which is
# when the re-tender lands.
NOTICE_TYPE_LABELS = {
    "cn-standard":      "Contract notice (OPEN - biddable)",
    "cn-social":        "Contract notice (social/other services)",
    "cn-desg":          "Design contest",
    "pin-only":         "Prior information notice (early signal)",
    "pin-buyer":        "Prior information notice (buyer profile)",
    "pin-rtl":          "Prior information notice (call for competition)",
    "pin-cfc-standard": "Prior information notice (call for competition)",
    "pmc":              "Preliminary market consultation (very early signal)",
    "can-standard":     "Award notice (contract awarded)",
    "can-social":       "Award notice (social/other services)",
    "can-modif":        "Contract modification",
    "veat":             "Voluntary ex-ante transparency (direct award)",
    "qu-sy":            "Qualification system",
}
BIDDABLE_TYPES = {"cn-standard", "cn-social", "cn-desg", "pin-only",
                  "pin-buyer", "pin-rtl", "pin-cfc-standard", "pmc"}

def _award_status(ntype: str, winner: str) -> str:
    """Pipeline status for a notice.

    A biddable notice is an opportunity ("identified"). An award notice is
    already decided, so read the outcome off the winner the notice names:
    Elsevier means we won it, another name means we lost it, and no name at
    all leaves it "closed" — concluded, outcome unknown. Filing every award
    as "closed" hid real wins behind the Monitoring badge.
    """
    if ntype in BIDDABLE_TYPES:
        return "identified"
    if not winner:
        return "closed"
    return "won" if "elsevier" in winner.lower() else "lost"


def _ted_cutoff() -> str:
    return (date.today() - timedelta(days=LOOKBACK_DAYS)).strftime("%Y%m%d")

def _pick_lang(obj, prefer: str = "eng") -> str:
    """TED v3 returns multilingual fields as {lang3: value_or_[value]}."""
    if isinstance(obj, list):
        return " ".join(_pick_lang(o, prefer) for o in obj if o)
    if not isinstance(obj, dict) or not obj:
        return ""
    v = obj.get(prefer)
    if v is None:
        v = next(iter(obj.values()), "")
    if isinstance(v, list):
        return " ".join(str(x) for x in v if x)
    return v or ""

def _first_num(raw) -> str:
    if isinstance(raw, list) and raw:
        raw = raw[0]
    if raw in (None, ""):
        return ""
    try:
        n = float(raw)
    except (ValueError, TypeError):
        return ""
    # TED carries a placeholder value of 1 when the real figure is withheld.
    return "" if n <= 1 else str(int(n))

def build_ted_query(keywords: list) -> str:
    """Full-text OR-group, scoped to this country INSIDE the query.

    place-of-performance is missing on some notices, so buyer-country is OR'd
    in as a fallback — otherwise those notices are invisible to us.
    """
    ors = " OR ".join('FT="{}"'.format(k.replace('"', "")) for k in keywords)
    geo = f"(place-of-performance={COUNTRY_CODE} OR buyer-country={COUNTRY_CODE})"
    return f"({ors}) AND {geo} AND publication-date>={_ted_cutoff()}"

def search_ted(query: str) -> list:
    """Search TED, walking every page of results (not just the first)."""
    out = []
    for page in range(1, TED_MAX_PAGES + 1):
        payload = json.dumps({
            "query": query,
            "onlyLatestVersions": False,
            "scope": "ALL",
            "fields": TED_FIELDS,
            "page": page,
            "limit": TED_PAGE_LIMIT,
        }).encode()
        result = fetch_json(TED_URL, data=payload)
        if not result or "notices" not in result:
            break
        batch = result.get("notices") or []
        out.extend(batch)
        if len(batch) < TED_PAGE_LIMIT:
            break
        time.sleep(0.5)
    return out

def ted_to_tender(notice: dict, product: str, competitor: str, is_cris: bool) -> dict:
    pub_num = notice.get("publication-number", "") or ""
    tender_id = "ted_" + re.sub(r"[^a-z0-9_]", "_", pub_num.lower())

    title = _pick_lang(notice.get("notice-title") or {})
    buyer = _pick_lang(notice.get("buyer-name") or {})

    published = (notice.get("publication-date") or "")[:10]

    deadline_raw = notice.get("deadline")
    deadline = deadline_raw[0][:10] if isinstance(deadline_raw, list) and deadline_raw else ""

    value = (_first_num(notice.get("total-value"))
             or _first_num(notice.get("tender-value"))
             or _first_num(notice.get("estimated-value-lot")))

    winner = _pick_lang(notice.get("winner-name") or {})
    ntype  = notice.get("notice-type") or ""
    label  = NOTICE_TYPE_LABELS.get(ntype, ntype or "Notice")

    end_raw = notice.get("contract-duration-end-date-lot")
    contract_end = end_raw[0][:10] if isinstance(end_raw, list) and end_raw else ""

    dur_v = notice.get("duration-period-value-lot")
    dur_u = notice.get("duration-period-unit-lot")
    duration = ""
    if isinstance(dur_v, list) and dur_v:
        unit = (dur_u[0] if isinstance(dur_u, list) and dur_u else "").lower()
        duration = f"{dur_v[0]} {unit}".strip()

    links = notice.get("links") or {}
    html_links = links.get("html") or {} if isinstance(links, dict) else {}
    url = html_links.get("ENG") or (next(iter(html_links.values()), "") if html_links else "")
    if not url and pub_num:
        url = f"https://ted.europa.eu/en/notice/-/detail/{pub_num}"

    notes = [f"TED Europa notice {pub_num}.", label + "."]
    if winner:
        notes.append(f"Winner: {winner}.")
    if value:
        notes.append(f"Value: EUR {int(value):,}.")
    if duration:
        notes.append(f"Duration: {duration}.")
    if contract_end:
        notes.append(f"Contract ends {contract_end} - re-tender window opens before then.")
    if is_cris:
        notes.append("*** CRIS / research information system procurement - direct Elsevier Pure opportunity. ***")

    return {
        "id": tender_id,
        "title": title or f"TED notice {pub_num}",
        "institution": buyer,
        "publishedDate": published,
        "deadline": deadline,
        "status": _award_status(ntype, winner),
        "value": value,
        "product": product,
        "competitor": competitor or "—",
        "winner": winner or "",
        "noticeType": ntype,
        "noticeTypeLabel": label,
        "biddable": ntype in BIDDABLE_TYPES,
        "isCRIS": is_cris,
        "category": "CRIS" if is_cris else "Database/Analytics",
        "contractEnd": contract_end,
        "duration": duration,
        "url": url,
        "notes": " ".join(notes),
        "source": f"TED Europa {pub_num}",
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }

def scrape_ted(existing: list) -> tuple:
    """Scrape TED for every keyword group. Returns (new_tenders, scanned)."""
    ids     = existing_ids(existing)
    titles  = existing_titles(existing)
    new     = []
    seen    = set()
    scanned = 0

    # Chunked so no single query string gets unwieldy. The country filter is
    # inside every one of them, so each group returns only domestic notices.
    groups = [
        ELSEVIER_PRODUCTS,
        COMPETITOR_PRODUCTS[:9],
        COMPETITOR_PRODUCTS[9:],
        CATEGORY_KEYWORDS[:7],
        CATEGORY_KEYWORDS[7:14],
        CATEGORY_KEYWORDS[14:],
    ]

    for group in groups:
        group = [g for g in group if g]
        if not group:
            continue
        query = build_ted_query(group)
        preview = ", ".join(group[:4]) + ("..." if len(group) > 4 else "")
        print(f"  TED [{COUNTRY_CODE}]: {preview}")
        notices = search_ted(query)
        scanned += len(notices)
        print(f"    -> {len(notices)} domestic notices")
        for n in notices:
            if not notice_is_domestic(n):
                continue
            title = _pick_lang(n.get("notice-title") or {})
            desc  = (_pick_lang(n.get("description-lot") or {}) + " "
                     + _pick_lang(n.get("description-proc") or {}))
            rel, product, competitor, is_cris = is_relevant(
                title, desc, n.get("classification-cpv"))
            if not rel:
                continue
            t = ted_to_tender(n, product, competitor, is_cris)
            if t["id"] in ids or t["id"] in seen:
                continue
            key = t["title"].lower().strip()
            if key in titles:
                continue
            new.append(t)
            seen.add(t["id"])
            titles.add(key)   # so repeat notices for one procurement collapse
            flag = "[CRIS] " if is_cris else ""
            print(f"       + {flag}{t['title'][:78]}")
        time.sleep(0.6)

    return new, scanned



def write_notification(new_tenders: list) -> None:
    """Writes GitHub Actions step outputs (new_count, cris_count, summary) so
    the workflow can post a notification issue. No-op outside Actions, or when
    there is nothing new (no daily "nothing found" noise). CRIS items are
    listed first and counted separately."""
    output_path = os.environ.get("GITHUB_OUTPUT")
    if not output_path or not new_tenders:
        return

    cris  = [t for t in new_tenders if t.get("isCRIS")]
    other = [t for t in new_tenders if not t.get("isCRIS")]

    lines = [f"**{len(new_tenders)} new {COUNTRY} tender(s) relevant to Elsevier.**\n"]

    def render(bucket, heading):
        if not bucket:
            return
        lines.append(f"## {heading}\n")
        for t in bucket:
            vs = ""
            if t.get("competitor") and t["competitor"] != "—":
                vs = f" (vs {t['competitor']})"
            bits = [
                f"### {t['title']}",
                f"- Institution: {t.get('institution') or 'Unknown'}",
                f"- Competes with: **{t.get('product', '-')}**{vs}",
                f"- Notice type: {t.get('noticeTypeLabel') or '-'}",
                f"- Published: {t.get('publishedDate') or '-'}",
            ]
            if t.get("deadline"):
                bits.append(f"- **Deadline: {t['deadline']}**")
            if t.get("winner"):
                bits.append(f"- Winner: {t['winner']}")
            if t.get("value"):
                bits.append(f"- Value: EUR {int(t['value']):,}")
            if t.get("contractEnd"):
                bits.append(f"- Contract ends: {t['contractEnd']} (re-tender window)")
            bits.append(f"- {t.get('url', '')}\n")
            lines.append("\n".join(bits))

    render(cris, f"{len(cris)} CRIS / research information system tender(s) - direct Elsevier Pure opportunity")
    render(other, "Other relevant tenders")

    body = "\n".join(lines)
    # `body` is built from scraped TED text — external, not fully trusted. A
    # fixed heredoc delimiter would let a crafted notice close the block early
    # and inject arbitrary key=value pairs into $GITHUB_OUTPUT. A random
    # per-run delimiter closes that off, per GitHub's own recommendation.
    delimiter = f"TENDER_SUMMARY_{secrets.token_hex(16)}"
    with open(output_path, "a", encoding="utf-8") as f:
        f.write(f"new_count={len(new_tenders)}\n")
        f.write(f"cris_count={len(cris)}\n")
        f.write(f"summary<<{delimiter}\n")
        f.write(body + "\n")
        f.write(f"{delimiter}\n")

# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    # Windows consoles default to cp1252 and cannot encode the arrows below.
    # GitHub Actions runners are UTF-8, but reconfigure defensively so a
    # print() never crashes the run after the scraping work is already done.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    global LOOKBACK_DAYS
    if "--days" in sys.argv:
        try:
            LOOKBACK_DAYS = int(sys.argv[sys.argv.index("--days") + 1])
            print(f"[tender_scraper] BACKFILL MODE: looking back {LOOKBACK_DAYS} days")
        except (IndexError, ValueError):
            print("usage: tender_scraper.py [--days N]", file=sys.stderr)
            return 0

    print(f"[tender_scraper] {datetime.now().strftime('%Y-%m-%d %H:%M')} starting ({COUNTRY})...")
    tenders = load_tenders()
    print(f"  Existing tenders: {len(tenders)}")

    new_tenders = []
    scanned = 0

    print("Scraping TED Europa...")
    try:
        ted_new, ted_scanned = scrape_ted(tenders)
        scanned += ted_scanned
        print(f"  New from TED: {len(ted_new)}")
        new_tenders.extend(ted_new)
    except Exception as e:
        print(f"  TED scrape failed: {e}", file=sys.stderr)


    cris_count = sum(1 for t in new_tenders if t.get("isCRIS"))

    if new_tenders:
        all_tenders = new_tenders + tenders
        save_tenders(all_tenders)
        print(f"[tender_scraper] Added {len(new_tenders)} new tender(s) "
              f"({cris_count} CRIS). Total: {len(all_tenders)}")
    else:
        print(f"[tender_scraper] No new relevant tenders found "
              f"({scanned} domestic notices scanned).")

    save_state(len(new_tenders), scanned, cris_count)
    write_notification(new_tenders)
    return len(new_tenders)

if __name__ == "__main__":
    count = main()
    sys.exit(0)
