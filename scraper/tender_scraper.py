"""
tender_scraper.py — Daily scraper for Belgium tenders that align with an
Elsevier product
Source: TED Europa (EU official journal, filtered to place-of-performance =
Belgium). Belgium's national procurement portal (e-Procurement) has no
verified public JSON API equivalent to the Netherlands' TenderNed, so it is
not scraped here — only TED Europa, which as an EU member state already
covers Belgium's larger, EU-threshold procurement notices.
Only keeps tenders that resolve to a specific named Elsevier product
(Scopus, SciVal, or Elsevier Pure) — see PRODUCT_ALIGNMENT.
Writes new tenders to data/tenders.json without duplicates, and (if any new
tenders were found) writes a summary for the workflow to post as a GitHub
issue — see write_notification_files().

Run: python scraper/tender_scraper.py
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, date, timedelta, timezone
from pathlib import Path

# ── Config ───────────────────────────────────────────────────────────────────

REPO_ROOT    = Path(__file__).parent.parent
TENDERS_FILE = REPO_ROOT / "data" / "tenders.json"
STATE_FILE   = REPO_ROOT / "data" / "tenders-scan-state.json"

# Keywords that make a tender Elsevier-relevant.
# Scoped to exactly Scopus, SciVal and Elsevier Pure — per explicit product
# scope, ScienceDirect and Elsevier's other products (Mendeley, Reaxys,
# ClinicalKey, Embase) are intentionally excluded, even though they're real
# Elsevier products, because they're not in scope for this tracker.
ELSEVIER_PRODUCTS = ["Scopus", "SciVal", "Elsevier Pure"]
COMPETITOR_PRODUCTS = [
    "Web of Science", "InCites", "Journal Citation Reports",
    "Clarivate", "Vidatum", "Symplectic Elements",
]
CATEGORY_KEYWORDS = [
    "research information system", "current research information",
    "bibliometric", "academic database", "scholarly database",
    "publication database", "library database",
    "wetenschappelijke databanken",  # NL: scientific/academic databases
    "onderzoeksinformatie",          # NL: research information
    "literatuurdatabanken",          # NL: literature databases
    "bases de données scientifiques",  # FR: scientific/academic databases
    "information de recherche",        # FR: research information
    "bases de données documentaires",  # FR: literature databases
]

ALL_KEYWORDS = ELSEVIER_PRODUCTS + COMPETITOR_PRODUCTS + CATEGORY_KEYWORDS

# Every non-Elsevier keyword must resolve to the specific Elsevier product it
# competes with — we only want tenders where a named Elsevier solution
# actually aligns with what's being procured, not a vague "academic database"
# bucket. Case-insensitive lookup; keys are lowercased at lookup time.
PRODUCT_ALIGNMENT = {
    # Research information systems / CRIS -> Pure
    "research information system": "Elsevier Pure",
    "current research information": "Elsevier Pure",
    "onderzoeksinformatie": "Elsevier Pure",
    "information de recherche": "Elsevier Pure",
    "publication database": "Elsevier Pure",
    "symplectic elements": "Elsevier Pure",   # Digital Science CRIS competitor
    "vidatum": "Elsevier Pure",                # CRIS-adjacent competitor
    # Bibliometrics / analytics -> SciVal
    "bibliometric": "SciVal",
    "incites": "SciVal",
    "journal citation reports": "SciVal",
    # Citation / discovery database -> Scopus
    "academic database": "Scopus",
    "scholarly database": "Scopus",
    "library database": "Scopus",
    "wetenschappelijke databanken": "Scopus",
    "literatuurdatabanken": "Scopus",
    "bases de données scientifiques": "Scopus",
    "bases de données documentaires": "Scopus",
    "web of science": "Scopus",
    "clarivate": "Scopus",
}

# ── Helpers ──────────────────────────────────────────────────────────────────

def load_tenders() -> list:
    try:
        return json.loads(TENDERS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []

def save_tenders(tenders: list) -> None:
    TENDERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    TENDERS_FILE.write_text(
        json.dumps(tenders, indent=2, ensure_ascii=False),
        encoding="utf-8"
    )

def save_state(new_count: int) -> None:
    state = {
        "lastRun": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "lastNewCount": new_count,
    }
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")

def write_notification(new_tenders: list) -> None:
    """Writes GitHub Actions step outputs (new_count, summary) so the workflow
    can post a notification issue when new tenders are found — this is the
    "let me know daily" channel. No-op if not running in GitHub Actions, or
    if there's nothing new to report (no daily "nothing found" noise)."""
    output_path = os.environ.get("GITHUB_OUTPUT")
    if not output_path or not new_tenders:
        return
    lines = [f"**{len(new_tenders)} new Belgium tender(s) competing with Elsevier found today.**\n"]
    for t in new_tenders:
        competes = t.get("product", "—")
        vs = f" (vs {t['competitor']})" if t.get("competitor") and t["competitor"] != "—" else ""
        deadline = f" · Deadline: {t['deadline']}" if t.get("deadline") else ""
        lines.append(
            f"### {t['title']}\n"
            f"- Institution: {t.get('institution') or 'Unknown'}\n"
            f"- Competes with: **{competes}**{vs}\n"
            f"- Published: {t.get('publishedDate') or '—'}{deadline}\n"
            f"- {t.get('url', '')}\n"
        )
    body = "\n".join(lines)
    with open(output_path, "a", encoding="utf-8") as f:
        f.write(f"new_count={len(new_tenders)}\n")
        f.write("summary<<TENDER_SUMMARY_EOF\n")
        f.write(body + "\n")
        f.write("TENDER_SUMMARY_EOF\n")

def existing_ids(tenders: list) -> set:
    return {t["id"] for t in tenders}

def existing_titles(tenders: list) -> set:
    return {t["title"].lower().strip() for t in tenders}

def is_relevant(title: str, description: str = "") -> tuple[bool, str, str]:
    """Returns (relevant, elsevier_product, matched_competitor).

    `elsevier_product` is always a specific named Elsevier product (Scopus,
    ScienceDirect, SciVal, or Elsevier Pure) — never a generic category term.
    A tender is only relevant if it resolves to one; a bare category or
    competitor match with no Elsevier alignment is not enough.
    """
    text = (title + " " + description).lower()

    elsevier_hit = next((k for k in ELSEVIER_PRODUCTS if k.lower() in text), "")
    if elsevier_hit:
        competitor = next((k for k in COMPETITOR_PRODUCTS if k.lower() in text), "")
        return True, elsevier_hit, competitor

    competitor_hit = next((k for k in COMPETITOR_PRODUCTS if k.lower() in text), "")
    if competitor_hit:
        aligned = PRODUCT_ALIGNMENT.get(competitor_hit.lower())
        if aligned:
            return True, aligned, competitor_hit

    category_hit = next((k for k in CATEGORY_KEYWORDS if k.lower() in text), "")
    if category_hit:
        aligned = PRODUCT_ALIGNMENT.get(category_hit.lower())
        if aligned:
            competitor = next((k for k in COMPETITOR_PRODUCTS if k.lower() in text), "")
            return True, aligned, competitor

    return False, "", ""

BE_COUNTRY_CODE = "BEL"

def is_belgium(notice: dict) -> bool:
    """TED place-of-performance is a list of ISO-3 country codes."""
    places = notice.get("place-of-performance")
    if isinstance(places, list):
        return BE_COUNTRY_CODE in places
    return False

def fetch_json(url: str, data: bytes = None, headers: dict = None) -> dict | None:
    """Simple HTTP GET/POST returning parsed JSON or None on error."""
    req = urllib.request.Request(url, data=data, headers=headers or {})
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
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

# ── TED Europa scraper ────────────────────────────────────────────────────────
# API v3 expert-query syntax: field~"value", combined with AND/OR/parens.
# Field names verified against the live API as of 2026-08-13 for the
# Netherlands version of this scraper — identical schema applies here, only
# the place-of-performance country code differs (BEL vs NLD).

TED_URL = "https://api.ted.europa.eu/v3/notices/search"
TED_FIELDS = [
    "publication-number", "notice-title", "buyer-name", "publication-date",
    "deadline", "estimated-value-lot", "contract-nature",
    "place-of-performance", "links",
]
TED_LOOKBACK_DAYS = 180  # only scan recent notices — avoids re-walking all TED history every run

def _ted_lookback_cutoff() -> str:
    return (date.today() - timedelta(days=TED_LOOKBACK_DAYS)).strftime("%Y%m%d")

def _pick_lang(obj, prefer: str = "eng") -> str:
    """TED v3 returns multilingual fields as {lang3: value_or_[value]}."""
    if not isinstance(obj, dict) or not obj:
        return ""
    v = obj.get(prefer)
    if v is None:
        v = next(iter(obj.values()), "")
    return v[0] if isinstance(v, list) else (v or "")

def build_ted_query(keywords: list) -> str:
    ors = " OR ".join(f'notice-title~"{k}"' for k in keywords)
    return f"({ors}) AND publication-date>={_ted_lookback_cutoff()}"

def search_ted(query: str, page: int = 1) -> list:
    """Search TED Europa notices. Returns list of raw notice dicts."""
    payload = json.dumps({
        "query": query,
        "onlyLatestVersions": True,
        "scope": "ALL",
        "fields": TED_FIELDS,
        "page": page,
        "limit": 50
    }).encode()
    result = fetch_json(TED_URL, data=payload)
    if not result or "notices" not in result:
        return []
    return result.get("notices", [])

def ted_to_tender(notice: dict, product: str, competitor: str) -> dict:
    """Convert a TED v3 notice dict to our tender schema."""
    pub_num = notice.get("publication-number", "") or ""
    tender_id = "ted_" + re.sub(r"[^a-z0-9_]", "_", pub_num.lower())

    title = _pick_lang(notice.get("notice-title") or {})
    buyer = _pick_lang(notice.get("buyer-name") or {})

    pub_date_raw = notice.get("publication-date") or ""
    published = pub_date_raw[:10] if pub_date_raw else ""

    deadline_raw = notice.get("deadline")
    deadline = deadline_raw[0][:10] if isinstance(deadline_raw, list) and deadline_raw else ""

    value_raw = notice.get("estimated-value-lot")
    value = ""
    if isinstance(value_raw, list) and value_raw:
        try:
            value = str(int(float(value_raw[0])))
        except (ValueError, TypeError):
            value = ""

    links = notice.get("links") or {}
    html_links = links.get("html") or {} if isinstance(links, dict) else {}
    url = html_links.get("ENG") or (next(iter(html_links.values()), "") if html_links else "")
    if not url and pub_num:
        url = f"https://ted.europa.eu/en/notice/-/detail/{pub_num}"

    return {
        "id": tender_id,
        "title": title or f"TED notice {pub_num}",
        "institution": buyer,
        "publishedDate": published,
        "deadline": deadline,
        "status": "identified",
        "value": value,
        "product": product,
        "competitor": competitor or "—",
        "url": url,
        "notes": f"TED Europa notice {pub_num}. Published: {published or '—'}.",
        "source": f"TED Europa {pub_num}",
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }

def scrape_ted(existing: list) -> list:
    """Scrape TED for all relevant keyword groups. Returns new tenders only."""
    ids    = existing_ids(existing)
    titles = existing_titles(existing)
    new    = []
    seen   = set()

    query_groups = [ELSEVIER_PRODUCTS, COMPETITOR_PRODUCTS, CATEGORY_KEYWORDS[:6]]

    for group in query_groups:
        query = build_ted_query(group)
        print(f"  TED query: {query[:90]}...")
        notices = search_ted(query)
        print(f"    → {len(notices)} notices")
        for n in notices:
            if not is_belgium(n):
                continue
            title = _pick_lang(n.get("notice-title") or {})
            rel, product, competitor = is_relevant(title)
            if not rel:
                continue
            t = ted_to_tender(n, product, competitor)
            if t["id"] in ids or t["id"] in seen:
                continue
            if t["title"].lower().strip() in titles:
                continue
            new.append(t)
            seen.add(t["id"])
        time.sleep(1)   # be polite

    return new

# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    # Windows consoles default to cp1252, which can't encode the arrows/checkmarks
    # below. GitHub Actions runners are UTF-8 by default, but reconfigure defensively
    # so a print() never crashes the run after the actual scraping work is done.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    print(f"[tender_scraper] {datetime.now().strftime('%Y-%m-%d %H:%M')} starting...")
    tenders = load_tenders()
    print(f"  Existing tenders: {len(tenders)}")

    new_tenders = []

    # TED Europa (only verified source for Belgium — see module docstring)
    print("Scraping TED Europa...")
    try:
        ted_new = scrape_ted(tenders)
        print(f"  New from TED: {len(ted_new)}")
        new_tenders.extend(ted_new)
    except Exception as e:
        print(f"  TED scrape failed: {e}", file=sys.stderr)

    if new_tenders:
        # Prepend new tenders (most recent first)
        all_tenders = new_tenders + tenders
        save_tenders(all_tenders)
        print(f"[tender_scraper] ✓ Added {len(new_tenders)} new tender(s). Total: {len(all_tenders)}")
    else:
        print("[tender_scraper] ✓ No new relevant tenders found.")

    save_state(len(new_tenders))
    write_notification(new_tenders)
    return len(new_tenders)

if __name__ == "__main__":
    count = main()
    sys.exit(0)
