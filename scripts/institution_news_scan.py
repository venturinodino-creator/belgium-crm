"""
institution_news_scan.py — Daily scan of Belgium institutions' own news
pages for research-information-system and procurement announcements.

WHY THIS EXISTS, separately from scripts/news-scan.js:

news-scan.js queries Google News RSS, which indexes news outlets. It cannot
see an announcement that only ever appeared on a university's own site.

That is not hypothetical. On 13 April 2026 Radboud University announced that
its ten-year CRIS contract had been awarded to Vidatum — a direct Elsevier
Pure competitor — as a staff news item on ru.nl. No award notice was ever
filed to TED or TenderNed (TenderNed's record still reads isGegund: false),
and Google News has zero results for it. Verified 2026-09-12: searches for
"Radboud CRIS Vidatum", "Radboud University Vidatum" and "Vidatum CRIS" all
return nothing. The tender scraper could not catch it because no notice
exists; news-scan.js could not catch it because no outlet covered it.

This scanner reads the institutions' own feeds and news pages directly, which
is the only channel that carried it.

Sources are RSS/Atom where the institution publishes one, and plain HTML
headline extraction where it does not. Keyword matching is deliberately
narrow — see is_signal() — because an HTML news page also yields navigation
links, and only a real announcement clears the bar.

Run: python scripts/institution_news_scan.py [--days N]
"""

import json
import os
import re
import secrets
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from html import unescape
from html.parser import HTMLParser
from urllib.parse import urljoin

REPO_ROOT  = __import__("pathlib").Path(__file__).parent.parent
NEWS_FILE  = REPO_ROOT / "data" / "institution-news.json"
STATE_FILE = REPO_ROOT / "data" / "institution-news-state.json"

COUNTRY = "Belgium"

# Sources verified reachable on 2026-09-12. "feed" entries are RSS/Atom;
# "html" entries are news index pages scraped for headline links.
SOURCES = [
    # Feeds — verified 2026-09-12
    {"institution": "KU Leuven", "url": "https://nieuws.kuleuven.be/en/rss", "type": "feed"},
    {"institution": "KU Leuven Libraries", "url": "https://bib.kuleuven.be/english/rss", "type": "feed"},
    {"institution": "UCLouvain", "url": "https://uclouvain.be/fr/rss.xml", "type": "feed"},
    # No feed published — headline extraction from the news index
    {"institution": "KU Leuven Libraries (news index)", "url": "https://bib.kuleuven.be/english/news", "type": "html"},
]

MAX_STORED   = 400
REQUEST_WAIT = 0.6
UA = "Mozilla/5.0 (compatible; research-crm-newsscan/1.0; +https://github.com/venturinodino-creator)"

# ── Signal vocabulary ────────────────────────────────────────────────────────
# STRONG terms are specific enough to fire on their own.
STRONG = [
    "cris", "current research information system", "research information system",
    "research information management", "onderzoeksinformatiesysteem",
    "forskningsinformationssystem", "systeme d'information recherche",
    "elsevier", "scopus", "scival", "sciencedirect",
    "web of science", "clarivate", "incites", "converis", "vidatum",
    "symplectic", "worktribe", "esploro", "openalex", "dimensions",
    "bibliometric", "bibliometrisch", "bibliometrie", "bibliometrisk",
    "scientometric", "metis",
]

# PROCUREMENT + SYSTEM together also fire, which is what catches a headline
# like "Tender for new CRIS completed" even if no vendor is named.
PROCUREMENT = [
    "tender", "aanbesteding", "aanbesteed", "gegund", "gunning", "awarded",
    "procurement", "contract", "marktconsultatie", "market consultation",
    "rfp", "request for proposal", "udbud", "kontrakt", "marche public",
    "selected a supplier", "supplier selected", "leverancier",
]
SYSTEM = [
    "cris", "ris", "research information", "onderzoeksinformatie",
    "forskningsinformation", "research portal", "research system",
    "publication database", "publicatiedatabank", "repository",
    "library system", "bibliotheeksysteem", "discovery system",
    "research data", "onderzoeksdata", "research analytics",
]

# "Pure" is hopeless on its own in news text ("pure research", "pure maths"),
# so it only counts next to a research-information qualifier — the same pair
# rule the tender scraper uses, for the same reason.
PURE_QUALIFIERS = [
    "elsevier", "cris", "research information", "onderzoeksinformatie",
    "research portal", "repository", "publication",
]

# Headline text that is navigation furniture, not an announcement.
NAV_NOISE = re.compile(
    r"^(home|menu|search|contact|login|log in|sign in|cookie|privacy|sitemap|"
    r"skip to|read more|show all|view all|previous|next|back to|share)\b", re.I)

# Contexts where a vendor name is a sponsor, donor or research subject rather
# than a procurement signal. Leiden's "Scaliger Institute research fellowship
# winners" matched on "Elsevier" purely because Elsevier sits in the list of
# funding companies — real, but not a system decision. Checked against the
# full text, since that is where the sponsor list lives.
NOT_PROCUREMENT = re.compile(
    r"\b(fellowship|scholarship|bursary|prize|award winners|laureate|"
    r"obituary|in memoriam|vacancy|vacature|exhibition|tentoonstelling|"
    r"lecture series|inaugural|phd defence|phd defense|promotie)\b", re.I)


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def _has(terms, text: str) -> str:
    for t in terms:
        if re.search(r"(?<![a-z0-9])" + re.escape(t) + r"(?![a-z0-9])", text):
            return t
    return ""


def is_signal(title: str, summary: str = "") -> tuple:
    """Returns (matched, matched_term, reason).

    Fires on a strong term, on procurement-plus-system co-occurrence, or on
    "Pure" next to a research-information qualifier. Everything else — the
    nav links an HTML news index inevitably yields — is dropped.
    """
    text = (title + " " + summary).lower()
    if NAV_NOISE.match(title.strip()) or NOT_PROCUREMENT.search(text):
        return False, "", ""

    hit = _has(STRONG, text)
    if hit:
        return True, hit, "named system or vendor"

    proc = _has(PROCUREMENT, text)
    syst = _has(SYSTEM, text)
    if proc and syst:
        return True, f"{proc} + {syst}", "procurement language on a research system"

    if _has(["pure"], text) and _has(PURE_QUALIFIERS, text):
        return True, "pure", "Elsevier Pure in a research-information context"

    return False, "", ""


# ── Fetching ─────────────────────────────────────────────────────────────────

def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/rss+xml,application/atom+xml,application/xml,text/html;q=0.9",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read(600000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        print(f"    HTTP {e.code}", file=sys.stderr)
    except Exception as e:
        print(f"    error: {e}", file=sys.stderr)
    return ""


def parse_feed(body: str, base: str) -> list:
    """RSS <item> and Atom <entry>, without an XML dependency — these feeds
    carry CDATA and stray entities that a strict parser rejects."""
    out = []
    blocks = re.findall(r"<item[\s>].*?</item>", body, re.S | re.I) \
        or re.findall(r"<entry[\s>].*?</entry>", body, re.S | re.I)
    for b in blocks:
        t = re.search(r"<title[^>]*>(.*?)</title>", b, re.S | re.I)
        title = _norm(re.sub(r"<!\[CDATA\[|\]\]>", "", t.group(1))) if t else ""
        l = re.search(r"<link[^>]*>(.*?)</link>", b, re.S | re.I)
        link = _norm(l.group(1)) if l and _norm(l.group(1)) else ""
        if not link:
            m = re.search(r'<link[^>]+href="([^"]+)"', b, re.I)
            link = m.group(1) if m else ""
        d = re.search(r"<(?:pubDate|updated|published|dc:date)[^>]*>(.*?)</", b, re.S | re.I)
        date = _norm(d.group(1)) if d else ""
        s = re.search(r"<(?:description|summary|content)[^>]*>(.*?)</", b, re.S | re.I)
        summary = _norm(re.sub(r"<!\[CDATA\[|\]\]>", "", s.group(1)))[:600] if s else ""
        if title and link:
            out.append({"title": title, "url": urljoin(base, link),
                        "date": date, "summary": summary})
    return out


class _Anchors(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self._href, self._buf = [], None, []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href")
            if href and not href.startswith(("#", "javascript:", "mailto:")):
                self._href, self._buf = href, []

    def handle_data(self, data):
        if self._href is not None:
            self._buf.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._href is not None:
            txt = re.sub(r"\s+", " ", "".join(self._buf)).strip()
            if len(txt) >= 20:
                self.out.append((txt, self._href))
            self._href, self._buf = None, []


def parse_html(body: str, base: str) -> list:
    p = _Anchors()
    try:
        p.feed(body)
    except Exception:
        pass
    seen, out = set(), []
    for txt, href in p.out:
        url = urljoin(base, href)
        if url in seen:
            continue
        seen.add(url)
        out.append({"title": txt, "url": url, "date": "", "summary": ""})
    return out


# ── State ────────────────────────────────────────────────────────────────────

def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def write_notification(new_items: list) -> None:
    """GitHub Actions step outputs, so the workflow can open an issue. No-op
    outside Actions or when nothing is new."""
    out = os.environ.get("GITHUB_OUTPUT")
    if not out or not new_items:
        return
    lines = [f"**{len(new_items)} new research-system announcement(s) "
             f"on {COUNTRY} institution websites.**\n",
             "_These come from the institutions' own news pages — not from TED, "
             "TenderNed or Google News, none of which carry them._\n"]
    for it in new_items:
        lines.append(
            f"### {it['title']}\n"
            f"- Institution: **{it['institution']}**\n"
            f"- Matched: `{it['matchedTerm']}` — {it['reason']}\n"
            f"- Published: {it.get('date') or 'not stated'}\n"
            f"- {it['url']}\n"
        )
    body = "\n".join(lines)
    # Titles come from external websites. A random delimiter stops a crafted
    # headline from closing the heredoc early and injecting workflow commands.
    delim = f"INSTNEWS_{secrets.token_hex(16)}"
    with open(out, "a", encoding="utf-8") as f:
        f.write(f"new_count={len(new_items)}\n")
        f.write(f"summary<<{delim}\n{body}\n{delim}\n")


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    print(f"[institution_news] {datetime.now():%Y-%m-%d %H:%M} starting ({COUNTRY})...")
    stored = load_json(NEWS_FILE, [])
    state = load_json(STATE_FILE, {})
    seen = set(state.get("seenUrls", []))
    print(f"  Stored announcements: {len(stored)} | URLs already seen: {len(seen)}")

    new_items, scanned, reached = [], 0, 0

    for src in SOURCES:
        print(f"  {src['institution']} ({src['type']})")
        body = fetch(src["url"])
        if not body:
            continue
        reached += 1
        items = parse_feed(body, src["url"]) if src["type"] == "feed" \
            else parse_html(body, src["url"])
        scanned += len(items)
        for it in items:
            ok, term, reason = is_signal(it["title"], it.get("summary", ""))
            if not ok or it["url"] in seen:
                continue
            seen.add(it["url"])
            rec = {
                "id": "inews_" + re.sub(r"[^a-z0-9]+", "_", it["url"].lower())[-60:],
                "institution": src["institution"],
                "sourceType": src["type"],
                "title": it["title"],
                "url": it["url"],
                "date": it.get("date", ""),
                "summary": it.get("summary", ""),
                "matchedTerm": term,
                "reason": reason,
                "foundAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            }
            new_items.append(rec)
            print(f"     + [{term}] {it['title'][:74]}")
        time.sleep(REQUEST_WAIT)

    print(f"  Sources reached: {reached}/{len(SOURCES)} | items examined: {scanned}")

    if new_items:
        stored = new_items + stored
        print(f"[institution_news] Added {len(new_items)} announcement(s). "
              f"Total: {min(len(stored), MAX_STORED)}")
    else:
        print("[institution_news] Nothing new.")

    # Written unconditionally, even when empty. A first run that finds nothing
    # still has to leave the file on disk: the workflow's `git add` names it
    # explicitly and fails the job outright if it is missing, and the CRM front
    # end can then read it without special-casing its absence.
    save_json(NEWS_FILE, stored[:MAX_STORED])

    save_json(STATE_FILE, {
        "lastRun": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "lastNewCount": len(new_items),
        "sourcesReached": reached,
        "sourcesTotal": len(SOURCES),
        "itemsExamined": scanned,
        # Capped so the state file cannot grow without bound; the oldest URLs
        # fall off, and anything that old has long since left its feed anyway.
        "seenUrls": sorted(seen)[-4000:],
    })
    write_notification(new_items)
    return len(new_items)


if __name__ == "__main__":
    main()
    sys.exit(0)
