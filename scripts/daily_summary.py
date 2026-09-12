#!/usr/bin/env python3
"""
daily_summary.py — builds the 3-page executive-summary PDF (crm_summary.pdf)
from the JSON blob produced by scripts/extract-crm-data.js, using
matplotlib's PdfPages. A4 portrait.

Meant to stand alone: a stranger looking at this PDF with no other context
should understand the country's competitive position and what's new,
without needing to log into the CRM. Every citation-bearing item (a
competitor's product-status proof, an OpenAlex subscription announcement, a
news article, an open competitor role, a newly discovered contact's source
page) carries a real clickable link — matplotlib's PDF backend attaches a
genuine `/Subtype /Link` + `/URI` annotation to any Text artist created with
`url=...` (verified: patches/bars do NOT get this, only Text does, hence
every link in this file renders as a text label rather than a colored bar).

Page 1 — Executive Overview: narrative summary, KPI tiles, institution/
  contact composition, and a New Additions panel (newly discovered contacts
  and freshly scanned news/hiring items since the data was last this size).
Page 2 — Competitive Position: the country's Competitor Matrix (Scopus/
  SciVal/Pure/WoS status across institutions) with a linked proof list of
  notable status changes, plus OpenAlex tier distribution and exactly who
  is subscribing (with source links).
Page 3 — Daily Digest: today's top news stories and open competitor roles,
  condensed the same way the in-app Daily Digest view presents them, each
  with its source link, plus a week-over-week trend of the headline
  metrics against the report from ~7 days earlier (read from the
  data/summary-reports.json manifest), so the reader sees the trajectory
  and not just today's snapshot.

Usage: python3 scripts/daily_summary.py <input.json> <output.pdf>

Also appends a manifest entry to data/summary-reports.json, which the
"Summary" page in the CRM's Data section reads to build the report archive.
"""
import html
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone

import matplotlib
matplotlib.use('Agg')
# This report never needs an actual formula rendered, but every tender title,
# news headline, and deal name it draws is real-world text that can contain a
# '$' — and matplotlib's default mathtext parser treats any two '$' as a math
# expression to parse, raising an uncaught ParseException on '$$...$$' or an
# unmatched brace/subscript in between (e.g. a scraped tender mentioning two
# dollar amounts, or a name with an underscore next to a '$'). That exception
# was previously fatal to the whole script — one bad string anywhere in the
# day's data would silently kill the entire report with no output at all.
# Disabling mathtext parsing entirely makes every '$' render as a literal
# character, which is exactly what a CRM report wants.
matplotlib.rcParams['text.parse_math'] = False
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.patches import FancyBboxPatch, PathPatch
from matplotlib.path import Path as MplPath

REGION_LABEL = 'Belgium'
REGION_ARTICLE = ''  # 'Belgium' doesn't take a definite article
TOTAL_PAGES = 3
PAGE_SIZE = (8.27, 11.69)  # A4 portrait, inches

# ── palette — mirrors the app's own colors ──────────────────────────────────
INK = '#0f172a'
MUTED = '#64748b'
LINE = '#e2e8f0'
BG_SOFT = '#f8fafc'
ACCENT = '#0891b2'
LOGO_PURPLE = '#a855f7'
LOGO_BLUE = '#3b82f6'

TYPE_COLORS = {'university': '#6366f1', 'medical': '#ef4444', 'research': '#10b981', 'ngo': '#a855f7'}
TYPE_LABELS = {'university': 'University', 'medical': 'Medical\nCenter', 'research': 'Research\nInst.', 'ngo': 'NGO /\nFoundation'}

STATUS_COLORS = {'active': '#10b981', 'prospect': '#f59e0b', 'cold': '#64748b', 'inactive': '#94a3b8'}
PRIORITY_COLORS = {'high': '#ef4444', 'medium': '#f59e0b', 'low': '#64748b'}
QUALITY_COLORS = {'verified': '#10b981', 'seed': '#f59e0b', 'unverified': '#94a3b8'}

PRODUCT_STATUS_COLORS = {
    'yes': '#10b981', 'likely': '#60a5fa', 'no': '#ef4444',
    'cancelled': '#ef4444', 'expiring': '#f59e0b', 'unknown': '#94a3b8',
}
PRODUCT_STATUS_ORDER = ['yes', 'likely', 'expiring', 'cancelled', 'no', 'unknown']
PRODUCT_STATUS_LABELS = {
    'yes': 'Active', 'likely': 'Likely', 'no': 'No', 'cancelled': 'Cancelled',
    'expiring': 'Expiring', 'unknown': 'Unknown',
}
PRODUCTS = ['scopus', 'scival', 'pure', 'wos']
PRODUCT_LABELS = {'scopus': 'Scopus', 'scival': 'SciVal', 'pure': 'Pure', 'wos': 'Web of Science'}
PRODUCT_PROOF_KEY = {'scopus': 'scopusProof', 'scival': 'scivalProof', 'pure': 'pureProof', 'wos': 'proofWos'}

WARMTH_ORDER = ['hot', 'warm', 'cold', '']
WARMTH_COLORS = {'hot': '#ef4444', 'warm': '#f59e0b', 'cold': '#60a5fa', '': '#94a3b8'}
WARMTH_LABELS = {'hot': 'Hot', 'warm': 'Warm', 'cold': 'Cold', '': 'Not Set'}

TIER_ORDER = ['Partner', 'Member+', 'Member', 'None']
TIER_COLORS = {'Partner': '#fbbf24', 'Member+': '#60a5fa', 'Member': '#34d399', 'None': '#94a3b8'}

NEWS_CATEGORY_COLORS = {
    'ai_adoption': '#1d4ed8', 'funding': '#059669', 'policy': '#991b1b', 'competitor_announcements': '#7c3aed',
}
NEWS_CATEGORY_SHORT = {
    'ai_adoption': 'AI Adoption', 'funding': 'Funding', 'policy': 'Policy', 'competitor_announcements': 'Competitor',
}
HIRING_CATEGORY_COLORS = {'sam': '#059669', 'csm': '#1d4ed8', 'channel': '#d97706'}


def infinity_logo(fig, x, y, w, h):
    """Draws the app's infinity mark (same path as the sidebar SVG,
    viewBox 0 0 40 22) as two colored halves so it reads as the app's
    purple-to-blue brand mark without needing true gradient strokes."""
    ax = fig.add_axes([x, y, w, h])
    ax.set_xlim(0, 40); ax.set_ylim(0, 22); ax.axis('off')
    ax.set_aspect('equal')

    right_loop = MplPath(
        [(20, 11), (20, 5), (25, 2), (30, 2), (35, 2), (38, 6), (38, 11),
         (38, 16), (35, 20), (30, 20), (25, 20), (22, 17), (20, 11)],
        [MplPath.MOVETO, MplPath.CURVE4, MplPath.CURVE4, MplPath.CURVE4,
         MplPath.CURVE4, MplPath.CURVE4, MplPath.CURVE4,
         MplPath.CURVE4, MplPath.CURVE4, MplPath.CURVE4,
         MplPath.CURVE4, MplPath.CURVE4, MplPath.CURVE4])
    left_loop = MplPath(
        [(20, 11), (18, 5), (15, 2), (10, 2), (5, 2), (2, 6), (2, 11),
         (2, 16), (5, 20), (10, 20), (15, 20), (18, 17), (20, 11)],
        [MplPath.MOVETO, MplPath.CURVE4, MplPath.CURVE4, MplPath.CURVE4,
         MplPath.CURVE4, MplPath.CURVE4, MplPath.CURVE4,
         MplPath.CURVE4, MplPath.CURVE4, MplPath.CURVE4,
         MplPath.CURVE4, MplPath.CURVE4, MplPath.CURVE4])
    ax.add_patch(PathPatch(right_loop, facecolor='none', edgecolor=LOGO_BLUE, linewidth=3.4, capstyle='round', joinstyle='round'))
    ax.add_patch(PathPatch(left_loop, facecolor='none', edgecolor=LOGO_PURPLE, linewidth=3.4, capstyle='round', joinstyle='round'))
    return ax


def draw_header(fig, title, subtitle, page_num):
    infinity_logo(fig, 0.06, 0.952, 0.052, 0.026)
    fig.text(0.122, 0.965, title, fontsize=18, fontweight='bold', color=INK, ha='left', va='top')
    fig.text(0.122, 0.943, subtitle, fontsize=9.5, color=MUTED, ha='left', va='top')
    fig.text(0.94, 0.965, f'Page {page_num} of {TOTAL_PAGES}', fontsize=8.5, color=MUTED, ha='right', va='top')
    fig.add_artist(plt.Line2D([0.06, 0.94], [0.925, 0.925], color=LINE, linewidth=1, transform=fig.transFigure))


def draw_footer(fig, generated_at, note=None):
    line_y = 0.042 if note else 0.035
    fig.add_artist(plt.Line2D([0.06, 0.94], [line_y, line_y], color=LINE, linewidth=1, transform=fig.transFigure))
    if note:
        fig.text(0.06, line_y - 0.010, note, fontsize=6.3, color=MUTED, style='italic', ha='left', va='top')
    fig.text(0.94, 0.014, f'Generated {generated_at}', fontsize=7, color=MUTED, ha='right', va='bottom')
    fig.text(0.06, 0.014, f'Research CRM · {REGION_LABEL} · Executive Summary', fontsize=7, color=MUTED, ha='left', va='bottom')


def stat_tile(fig, rect, label, value, sub, color):
    ax = fig.add_axes(rect)
    ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis('off')
    ax.add_patch(FancyBboxPatch((0.0, 0.0), 1.0, 1.0, boxstyle='round,pad=0,rounding_size=0.08',
                                 linewidth=0, facecolor=BG_SOFT, transform=ax.transAxes, clip_on=False))
    ax.plot([0.025, 0.025], [0.12, 0.88], color=color, linewidth=4, transform=ax.transAxes, solid_capstyle='butt')
    ax.text(0.12, 0.60, str(value), fontsize=17, fontweight='bold', color=INK, transform=ax.transAxes, va='center')
    ax.text(0.12, 0.30, label.upper(), fontsize=6.6, fontweight='bold', color=MUTED, transform=ax.transAxes, va='center')
    if sub:
        ax.text(0.12, 0.12, sub, fontsize=6.2, color=MUTED, transform=ax.transAxes, va='center')


def bar_chart(ax, title, data, color_map=None, label_map=None, default_color=ACCENT, order=None):
    ax.set_title(title, fontsize=9.5, fontweight='bold', color=INK, loc='left', pad=7)
    keys = order if order else list(data.keys())
    items = [(k, data.get(k, 0)) for k in keys if data.get(k, 0)]
    if not items:
        ax.text(0.5, 0.5, 'No data yet', ha='center', va='center', color=MUTED, fontsize=8.5, transform=ax.transAxes)
        ax.axis('off')
        return
    ks = [k for k, v in items]
    vs = [v for k, v in items]
    cs = [(color_map or {}).get(k, default_color) for k in ks]
    labels = [(label_map or {}).get(k, str(k).title()) for k in ks]
    bars = ax.bar(range(len(ks)), vs, color=cs, width=0.62, zorder=3)
    ax.set_xticks(range(len(ks)))
    ax.set_xticklabels(labels, fontsize=7, color=MUTED)
    for spine in ['top', 'right', 'left']:
        ax.spines[spine].set_visible(False)
    ax.get_yaxis().set_visible(False)
    ax.set_ylim(0, max(vs) * 1.25)
    for b, v in zip(bars, vs):
        ax.text(b.get_x() + b.get_width() / 2, b.get_height() + max(vs) * 0.03, str(v),
                 ha='center', fontsize=8, fontweight='bold', color=INK)
    ax.tick_params(axis='x', length=0)


def stacked_product_chart(ax, title, comp_matrix):
    ax.set_title(title, fontsize=10, fontweight='bold', color=INK, loc='left', pad=7)
    rows = list(comp_matrix.values())
    if not rows:
        ax.text(0.5, 0.5, 'No data yet', ha='center', va='center', color=MUTED, fontsize=9, transform=ax.transAxes)
        ax.axis('off')
        return
    x = range(len(PRODUCTS))
    bottoms = [0] * len(PRODUCTS)
    totals = [len(rows)] * len(PRODUCTS)
    for status in PRODUCT_STATUS_ORDER:
        heights = []
        for p in PRODUCTS:
            n = sum(1 for r in rows if (r.get(p) or 'unknown') == status)
            heights.append(n)
        if sum(heights) == 0:
            continue
        ax.bar(x, heights, bottom=bottoms, color=PRODUCT_STATUS_COLORS[status],
               width=0.55, label=PRODUCT_STATUS_LABELS[status], zorder=3)
        for i, h in enumerate(heights):
            # A segment thinner than ~5% of the column's total height can't
            # fit an 7.5pt label without colliding with its neighbor —
            # confirmed live 2026-09-11 on a Web of Science column where two
            # adjacent small segments (4 and 6, against a total of 68)
            # rendered as overlapping unreadable digits. Below that
            # threshold the color segment itself still communicates
            # magnitude; the exact count is always available in the
            # Notable Status Changes list below.
            if h > 0 and h >= totals[i] * 0.05:
                ax.text(i, bottoms[i] + h / 2, str(h), ha='center', va='center',
                         fontsize=7.5, fontweight='bold', color='white')
        bottoms = [b + h for b, h in zip(bottoms, heights)]
    ax.set_xticks(list(x))
    ax.set_xticklabels([PRODUCT_LABELS[p] for p in PRODUCTS], fontsize=8.5, color=MUTED)
    ax.set_ylim(0, max(totals) * 1.05)
    for spine in ['top', 'right', 'left']:
        ax.spines[spine].set_visible(False)
    ax.get_yaxis().set_visible(False)
    ax.tick_params(axis='x', length=0)
    ax.legend(loc='upper center', bbox_to_anchor=(0.5, -0.06), ncol=6, fontsize=6.5,
              frameon=False, handlelength=0.9, handletextpad=0.4, columnspacing=0.9)


def breakdown_list(ax, title, data, color_map=None, label_map=None, order=None):
    """A labelled-row breakdown (colored dot · label ····· count) instead of
    a bar chart — used where a bar chart would be unreadable because one
    category dwarfs the rest (e.g. OpenAlex tiers: 1 Partner, 1 Member, 68
    None all in the same chart makes the two single-digit bars render as
    an invisible sliver). Rows are always legible regardless of how skewed
    the distribution is, which a bar's pixel height never guarantees."""
    ax.set_title(title, fontsize=9.5, fontweight='bold', color=INK, loc='left', pad=7)
    ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis('off')
    keys = order if order else list(data.keys())
    items = [(k, data.get(k, 0)) for k in keys if data.get(k, 0)]
    if not items:
        ax.text(0.5, 0.5, 'No data yet', ha='center', va='center', color=MUTED, fontsize=8.5, transform=ax.transAxes)
        return
    n = len(items)
    row_h = 1.0 / n
    for i, (k, v) in enumerate(items):
        y = 1.0 - row_h * (i + 0.5)
        color = (color_map or {}).get(k, ACCENT)
        label = (label_map or {}).get(k, str(k).title())
        ax.scatter([0.012], [y], s=46, color=color, zorder=3, clip_on=False)
        ax.text(0.035, y, label, fontsize=8.2, color=INK, va='center', ha='left')
        ax.text(0.98, y, str(v), fontsize=9, fontweight='bold', color=INK, va='center', ha='right')


def clean_text(s):
    """Decodes stray HTML entities and strips tags from raw scraped text
    (news titles/descriptions occasionally carry &nbsp; or a literal tag
    straight from the source feed) before it reaches a board-facing PDF —
    confirmed live 2026-09-11: an undecoded '&nbsp;&nbsp;' was rendering as
    literal text in the Daily Digest instead of a space."""
    s = html.unescape(str(s or ''))
    s = re.sub(r'<[^>]*>', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def truncate(s, n):
    s = clean_text(s)
    return s if len(s) <= n else s[:n].rsplit(' ', 1)[0] + '…'


def link_list(fig, rect, title, rows, empty_text='No data yet'):
    """Renders a compact, citation-style list of rows inside a fig-fraction
    rect: [x, y, w, h] (all in figure fraction). Each row is a dict: {tag,
    tag_color, main, sub, url, link_label}. When a row has a url, the
    line that carries it (link_label if given, else main) is drawn as a
    genuine clickable PDF link — this is the report's "proof of the data"
    mechanism: matplotlib's PDF backend only honors `url` on Text artists,
    not on bars/patches, so every citation here is a labeled link rather
    than a colored shape.

    Row height is computed from the rect's actual physical height (in
    inches, via PAGE_SIZE) rather than a fixed axes-fraction guess, so
    rows never overlap regardless of how tall or short the rect is or how
    many lines a row needs — rows that would run past the bottom of the
    rect are simply omitted instead of overlapping into whatever comes
    next on the page.
    """
    ax = fig.add_axes(rect)
    ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis('off')
    ax.text(0, 1.0, title, fontsize=9.3, fontweight='bold', color=INK, va='top', ha='left', transform=ax.transAxes)
    if not rows:
        ax.text(0.5, 0.46, empty_text, ha='center', va='center', color=MUTED, fontsize=8, transform=ax.transAxes)
        return

    rect_h_in = rect[3] * PAGE_SIZE[1]
    title_frac = (14.5 / 72) / rect_h_in  # room reserved for the title line above (9.3pt + leading)
    tag_line = (11.0 / 72) / rect_h_in  # tag badge's bbox padding needs more room than its 5.6pt text alone
    main_line = (9.6 / 72) / rect_h_in
    sub_line = (8.4 / 72) / rect_h_in
    row_pad = (4.5 / 72) / rect_h_in

    y = 1.0 - title_frac
    bottom = 0.02
    for r in rows:
        lines = 1 if r.get('tag') else 0  # tag gets its own line
        lines_h = (tag_line if r.get('tag') else 0)
        needed = lines_h + main_line + (sub_line if r.get('sub') else 0) + (sub_line if (r.get('url') and r.get('link_label')) else 0)
        if y - needed < bottom:
            break

        if r.get('tag'):
            ax.text(0, y, truncate(r['tag'], 20), fontsize=5.6, fontweight='bold', color='white', va='top', ha='left',
                     transform=ax.transAxes,
                     bbox=dict(boxstyle='round,pad=0.28', facecolor=r.get('tag_color', MUTED), linewidth=0))
            y -= tag_line

        has_explicit_link_label = bool(r.get('url') and r.get('link_label'))
        main_color = INK if has_explicit_link_label or not r.get('url') else '#1d4ed8'
        main_url = None if has_explicit_link_label else (r.get('url') or None)
        ax.text(0, y, r['main'], fontsize=7.4, fontweight='bold', color=main_color, va='top', ha='left',
                 transform=ax.transAxes, url=main_url)
        y -= main_line

        if r.get('sub'):
            ax.text(0, y, r['sub'], fontsize=6.4, color=MUTED, va='top', ha='left', transform=ax.transAxes)
            y -= sub_line

        if has_explicit_link_label:
            ax.text(0, y, r['link_label'], fontsize=6.3, color='#1d4ed8', va='top', ha='left',
                     transform=ax.transAxes, url=r['url'])
            y -= sub_line

        y -= row_pad


def find_baseline_report(history, generated_dt, target_days=7):
    """Finds the past manifest entry closest to `target_days` ago, so the
    report can show a genuine week-over-week change instead of just a
    snapshot — a board reading this needs to know the trajectory, not only
    today's totals. Returns None (rather than the nearest entry at any
    distance) when the closest match is under 3 days old, since comparing
    against a report from yesterday or the same day isn't a meaningful
    "last week" read and would understate change instead of just omitting
    the section."""
    target = generated_dt - timedelta(days=target_days)
    best = None
    for e in history:
        raw = e.get('generatedAt') or ''
        try:
            d = datetime.fromisoformat(raw.replace('Z', '+00:00'))
        except ValueError:
            continue
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        gap = abs((d - target).total_seconds())
        if best is None or gap < best[0]:
            best = (gap, d, e)
    if best is None:
        return None
    _, baseline_date, entry = best
    if (generated_dt - baseline_date).days < 3:
        return None
    return baseline_date, entry


def build_trend_rows(history, stats, generated_dt):
    """One row per headline metric: current value, change since the
    baseline report, and the baseline's own value — e.g. 'Institutions 70
    (+2 since 4 Sep)'. Deliberately no color-coded good/bad judgement (more
    open competitor roles isn't inherently bad, it's information) — just
    the number and the date it changed since.

    A metric whose underlying source was degraded on either side of the
    comparison reports its current value with no delta at all. Contacts
    come from Supabase; when that fetch can't authenticate,
    extract-crm-data.js falls back to the local seed list and the count
    collapses (reproduced 2026-09-12: 870 live vs 122 seed). Subtracting
    those two numbers yields a '−651 contacts' that looks like a mass
    deletion to anyone reading the report, and the bad figure would then
    sit in the manifest as next week's baseline and invert the error.
    Suppressing the delta is the honest output: the source, not the
    network, changed. A baseline entry predating this field is assumed
    live, which is what every historical entry in fact was."""
    found = find_baseline_report(history, generated_dt)
    if not found:
        return None, None
    baseline_date, entry = found
    b = entry.get('stats') or {}
    now_contacts_live = stats.get('contacts_is_live', True)
    base_contacts_live = b.get('contactsIsLive', True)
    contacts_comparable = now_contacts_live and base_contacts_live
    metrics = [
        ('Institutions', stats['inst_total'], b.get('institutions', 0), True),
        ('Contacts', stats['contacts_total'], b.get('contacts', 0), contacts_comparable),
        ('News Live', stats['news_total'], b.get('news', 0), True),
        ('Open Roles', stats['hiring_total'], b.get('hiring', 0), True),
    ]
    rows = []
    for label, now_v, before_v, comparable in metrics:
        if not comparable:
            # Kept to roughly the width of a normal '+97 since 05 Sep' so it
            # doesn't overrun the tile it's drawn in.
            rows.append((label, now_v, 'source incomplete'))
            continue
        delta = now_v - before_v
        sign = '+' if delta > 0 else ('' if delta == 0 else '−')
        rows.append((label, now_v, f'{sign}{abs(delta)} since {baseline_date.strftime("%d %b")}'))
    return rows, baseline_date


def compose_summary(stats, trend_rows=None, trend_baseline_date=None):
    parts = []
    # '(0 high priority)' reads as "we triaged these and none matter", when
    # it actually means nobody has triaged them at all — every contact still
    # sits on the 'medium' default (true of all 708 Belgian and 630 Danish
    # contacts as of 2026-09-12, against 115 genuinely-flagged in the
    # Netherlands). Say which one it is rather than print a misleading zero.
    if stats['contacts_high_priority']:
        contacts_clause = (f"{stats['contacts_total']} verified contacts "
                           f"({stats['contacts_high_priority']} high priority)")
    else:
        contacts_clause = (f"{stats['contacts_total']} verified contacts "
                           f"(none triaged by priority yet)")
    parts.append(
        f"Research CRM tracks {stats['inst_total']} institutions across {REGION_ARTICLE}{REGION_LABEL} "
        f"({stats['inst_university']} universities, {stats['inst_medical']} medical centres, "
        f"{stats['inst_research']} research institutes, {stats['inst_ngo']} NGOs/foundations) "
        f"and {contacts_clause}."
    )
    if stats['pending_total']:
        if stats['pending_is_live']:
            parts.append(f"{stats['pending_total']} candidate contacts are awaiting review right now.")
        else:
            parts.append(f"{stats['pending_total']} candidate contacts have been discovered via automated scraping since tracking began.")
    if stats.get('comp_matrix_total'):
        parts.append(
            f"Scopus remains active at {stats['scopus_active']} of {stats['comp_matrix_total']} tracked institutions; "
            f"Clarivate's Web of Science is cancelled or expiring at {stats['wos_at_risk']}."
        )
    if stats.get('openalex_subs_total'):
        parts.append(f"{stats['openalex_subs_total']} institution(s) have a live OpenAlex subscription.")
    if stats.get('news_total') or stats.get('hiring_total'):
        parts.append(
            f"The daily intelligence scan currently has {stats.get('news_total', 0)} live news item(s) "
            f"and {stats.get('hiring_total', 0)} open competitor role(s) tracked."
        )
    if stats['renewals_90d']:
        parts.append(f"{stats['renewals_90d']} product renewal(s) due in the next 90 days.")
    if trend_rows and trend_baseline_date:
        # Only the metrics that actually moved, so a quiet week reads as
        # "no change" rather than a list of four zeros.
        moved = []
        for label, now_v, sub in trend_rows:
            m = re.match(r'([+−])(\d+)', sub)
            if m and int(m.group(2)) > 0:
                moved.append(f"{label.lower()} {m.group(1)}{m.group(2)}")
        since = trend_baseline_date.strftime('%d %b')
        if moved:
            parts.append(f"Since {since}: {', '.join(moved)}.")
        else:
            parts.append(f"No change in the headline totals since {since}.")
    return ' '.join(parts)


def build_new_additions(pending, news, hiring):
    """Newest-first, capped small lists for the New Additions panel — each
    with its real source link where the underlying record carries one.
    These three lists render three-up in a narrow column (~163pt wide, see
    build_report), so text is truncated shorter here than the same fields
    get in the full-width lists elsewhere in the report — matplotlib Text
    doesn't wrap, so anything longer than the column can hold would just
    run on past its edge."""
    pending_sorted = sorted(pending, key=lambda c: c.get('createdAt') or '', reverse=True)[:4]
    pending_rows = []
    for c in pending_sorted:
        name = f"{c.get('first', '')} {c.get('last', '')}".strip() or 'Unknown'
        pending_rows.append({
            'main': truncate(name, 30),
            'sub': truncate(c.get('instName') or c.get('dept') or '', 40),
            'url': c.get('source') or None,
            'link_label': 'Source' if c.get('source') else None,
        })

    news_sorted = sorted(news, key=lambda a: a.get('publishedDate') or a.get('foundDate') or '', reverse=True)[:3]
    news_rows = []
    for a in news_sorted:
        cat = a.get('category', '')
        news_rows.append({
            'tag': NEWS_CATEGORY_SHORT.get(cat, (a.get('categoryLabel') or cat or 'News')[:14]),
            'tag_color': NEWS_CATEGORY_COLORS.get(cat, MUTED),
            'main': truncate(a.get('title', ''), 33),
            'url': a.get('url') or None,
            'link_label': truncate(a.get('sourceName') or 'Source', 26) if a.get('url') else None,
        })

    hiring_sorted = sorted(hiring, key=lambda j: j.get('postedDate') or j.get('foundDate') or '', reverse=True)[:3]
    hiring_rows = []
    for j in hiring_sorted:
        hiring_rows.append({
            'tag': (j.get('company') or '')[:16],
            'tag_color': '#f87171',
            'main': truncate(j.get('title', ''), 32),
            'sub': truncate(j.get('location') or '', 34),
            'url': j.get('url') or None,
            'link_label': 'View posting' if j.get('url') else None,
        })
    return pending_rows, news_rows, hiring_rows


def build_competitor_proof_rows(comp_matrix, inst_by_id):
    """Flags the notable product-status entries (anything that isn't a
    quiet 'unknown') across the whole matrix, each linked to its proof URL
    where one is on file — this is the report's direct answer to "prove
    it": a citation trail a stranger can click through themselves."""
    rows = []
    for inst_id, row in comp_matrix.items():
        inst_name = (inst_by_id.get(inst_id) or {}).get('short') or (inst_by_id.get(inst_id) or {}).get('name') or inst_id
        for p in PRODUCTS:
            status = row.get(p) or 'unknown'
            if status in ('unknown',):
                continue
            proof = row.get(PRODUCT_PROOF_KEY[p]) or ''
            renewal = row.get(f'{p}Renewal') or ''
            interesting = status in ('cancelled', 'expiring') or (status == 'yes' and p == 'wos')
            if not interesting and not proof:
                continue
            label = f"{inst_name} — {PRODUCT_LABELS[p]}: {PRODUCT_STATUS_LABELS.get(status, status.title())}"
            if renewal:
                label += f' ({renewal})'
            rows.append({
                'status': status,
                'main': truncate(label, 62),
                'url': proof or None,
                'link_label': 'Source' if proof else None,
                '_sort': 0 if status in ('cancelled', 'expiring') else 1,
            })
    rows.sort(key=lambda r: r['_sort'])
    return rows[:7]


def build_openalex_rows(openalex_subs):
    """No `sub` line here on purpose — institution + tier + source link is
    enough to answer "who is subscribing", and keeping each row to 3 lines
    instead of 4 lets several more institutions fit in the same space."""
    rows = []
    for s in sorted(openalex_subs, key=lambda s: s.get('announceDate') or s.get('foundDate') or '', reverse=True)[:5]:
        src = (s.get('sources') or [{}])[0]
        rows.append({
            'tag': (s.get('tier') or 'Member')[:12],
            'tag_color': TIER_COLORS.get(s.get('tier'), MUTED),
            'main': truncate(s.get('inst') or s.get('id') or '', 50),
            'url': src.get('url') or None,
            'link_label': 'Source' if src.get('url') else None,
        })
    return rows


def build_digest_rows(news, hiring):
    news_rows = []
    for a in sorted(news, key=lambda a: a.get('publishedDate') or a.get('foundDate') or '', reverse=True)[:6]:
        cat = a.get('category', '')
        summary = a.get('summary') or a.get('elsevierRelevance') or a.get('description') or ''
        news_rows.append({
            'tag': NEWS_CATEGORY_SHORT.get(cat, (a.get('categoryLabel') or cat or 'News')[:14]),
            'tag_color': NEWS_CATEGORY_COLORS.get(cat, MUTED),
            'main': truncate(a.get('title', ''), 60),
            'sub': truncate(summary, 90),
            'url': a.get('url') or None,
            'link_label': truncate(a.get('sourceName') or 'Source', 32) if a.get('url') else None,
        })
    hiring_rows = []
    for j in sorted(hiring, key=lambda j: j.get('postedDate') or j.get('foundDate') or '', reverse=True)[:5]:
        hiring_rows.append({
            'tag': (j.get('company') or '')[:16],
            'tag_color': '#f87171',
            'main': truncate(j.get('title', ''), 52),
            'sub': truncate(f"{j.get('location') or 'Location not listed'}", 45),
            'url': j.get('url') or None,
            'link_label': 'View posting' if j.get('url') else None,
        })
    return news_rows, hiring_rows


def build_report(data, out_path, history=None):
    institutions = data['institutions']
    contacts = data['contacts']
    pending = data.get('pending', [])
    comp_matrix = data.get('competitorMatrix') or {}
    news = data.get('news', [])
    hiring = data.get('hiring', [])
    openalex_subs = data.get('openalexSubs', [])

    inst_type_counts = Counter(i.get('type', 'research') for i in institutions)
    contact_status_counts = Counter(c.get('status', 'active') for c in contacts)
    contact_priority_counts = Counter(c.get('priority', 'medium') for c in contacts)

    inst_by_id = {i['id']: i for i in institutions}

    warmth_counts = Counter((i.get('warmth') or '') for i in institutions)

    today = datetime.now(timezone.utc).date()
    renewals = []
    for i in institutions:
        rd = i.get('renewalDate')
        if not rd:
            continue
        try:
            d = datetime.strptime(rd[:10], '%Y-%m-%d').date()
        except (ValueError, TypeError):
            continue
        delta = (d - today).days
        if 0 <= delta <= 90:
            renewals.append((i.get('short') or i.get('name') or i['id'], delta))

    tier_counts = Counter()
    for row in comp_matrix.values():
        t = row.get('openalexTier') or 'None'
        tier_counts[t] += 1
    for s in openalex_subs:
        t = s.get('tier') or 'Member'
        if t not in TIER_ORDER:
            t = 'Member'

    wos_at_risk = sum(1 for r in comp_matrix.values() if (r.get('wos') or 'unknown') in ('cancelled', 'expiring'))
    scopus_active = sum(1 for r in comp_matrix.values() if (r.get('scopus') or 'unknown') == 'yes')

    stats = {
        'inst_total': len(institutions),
        'inst_university': inst_type_counts.get('university', 0),
        'inst_medical': inst_type_counts.get('medical', 0),
        'inst_research': inst_type_counts.get('research', 0),
        'inst_ngo': inst_type_counts.get('ngo', 0),
        'contacts_total': len(contacts),
        'contacts_high_priority': contact_priority_counts.get('high', 0),
        'contacts_is_live': data.get('contactsSource') == 'supabase',
        'pending_total': len(pending),
        'pending_is_live': data.get('pendingSource') == 'supabase',
        'renewals_90d': len(renewals),
        'comp_matrix_total': len(comp_matrix),
        'scopus_active': scopus_active,
        'wos_at_risk': wos_at_risk,
        'news_total': len(news),
        'hiring_total': len(hiring),
        'openalex_subs_total': len(openalex_subs),
    }

    generated_dt = datetime.now(timezone.utc)
    generated_at = generated_dt.strftime('%d %b %Y, %H:%M UTC')
    trend_rows, trend_baseline_date = build_trend_rows(history or [], stats, generated_dt)
    summary_text = compose_summary(stats, trend_rows, trend_baseline_date)

    pending_rows, added_news_rows, added_hiring_rows = build_new_additions(pending, news, hiring)
    proof_rows = build_competitor_proof_rows(comp_matrix, inst_by_id)
    openalex_rows = build_openalex_rows(openalex_subs)
    digest_news_rows, digest_hiring_rows = build_digest_rows(news, hiring)

    with PdfPages(out_path) as pdf:
        # ── PAGE 1 — EXECUTIVE OVERVIEW ──────────────────────────────────
        fig = plt.figure(figsize=PAGE_SIZE)
        draw_header(fig, 'Research CRM — Executive Summary',
                    f'{REGION_LABEL} Academic & Research Network · {generated_dt.strftime("%A, %d %B %Y")}', 1)

        fig.text(0.06, 0.905, 'At a glance', fontsize=10, fontweight='bold', color=INK, ha='left', va='top')
        summary_ax = fig.add_axes([0.06, 0.775, 0.88, 0.12])
        summary_ax.axis('off')
        wrapped = _wrap(summary_text, 108)
        summary_ax.text(0, 1, '\n'.join(wrapped), fontsize=9, color='#334155', va='top', ha='left',
                         linespacing=1.55, transform=summary_ax.transAxes)

        tile_y, tile_h, gap = 0.700, 0.072, 0.014
        tile_w = (0.94 - 0.06 - 4 * gap) / 5
        pending_tile_sub = 'awaiting review' if stats['pending_is_live'] else 'discovered to date'
        tiles = [
            ('Institutions', stats['inst_total'], f"{stats['inst_medical']} medical · {stats['inst_university']} univ.", TYPE_COLORS['university']),
            ('Contacts', stats['contacts_total'],
             f"{stats['contacts_high_priority']} high priority" if stats['contacts_high_priority']
             else 'not yet prioritised', ACCENT),
            ('New Contacts', stats['pending_total'], pending_tile_sub, TYPE_COLORS['ngo']),
            ('News Live', stats['news_total'], 'scanned articles', NEWS_CATEGORY_COLORS['competitor_announcements']),
            ('Open Roles', stats['hiring_total'], 'at tracked competitors', '#f87171'),
        ]
        for i, (label, val, sub, col) in enumerate(tiles):
            x = 0.06 + i * (tile_w + gap)
            stat_tile(fig, [x, tile_y, tile_w, tile_h], label, val, sub, col)

        col_w = (0.94 - 0.06 - 0.06) / 2
        ax1 = fig.add_axes([0.06, 0.50, col_w, 0.155])
        bar_chart(ax1, 'Institutions by Type', inst_type_counts, TYPE_COLORS, TYPE_LABELS)
        ax2 = fig.add_axes([0.06 + col_w + 0.06, 0.50, col_w, 0.155])
        bar_chart(ax2, 'Contacts by Priority', contact_priority_counts, PRIORITY_COLORS, {k: k.title() for k in contact_priority_counts})

        fig.add_artist(plt.Line2D([0.06, 0.94], [0.455, 0.455], color=LINE, linewidth=1, transform=fig.transFigure))
        fig.text(0.06, 0.435, 'New Additions', fontsize=11.5, fontweight='bold', color=INK, ha='left', va='top')
        fig.text(0.06, 0.416, 'Newest candidate contacts, news, and competitor roles — each linked to its source', fontsize=7.6, color=MUTED, ha='left', va='top')

        add_col_w = (0.94 - 0.06 - 2 * 0.03) / 3
        link_list(fig, [0.06, 0.075, add_col_w, 0.325], 'Newly Discovered Contacts', pending_rows,
                  empty_text='No new contacts yet')
        link_list(fig, [0.06 + add_col_w + 0.03, 0.075, add_col_w, 0.325], 'Newest News', added_news_rows,
                  empty_text='No news yet')
        link_list(fig, [0.06 + 2 * (add_col_w + 0.03), 0.075, add_col_w, 0.325], 'Newest Open Roles', added_hiring_rows,
                  empty_text='No open roles tracked')

        pending_note = None if stats['pending_is_live'] else 'New Contacts total is from the local scrape audit trail, not live Supabase status.'
        draw_footer(fig, generated_at, pending_note)
        pdf.savefig(fig)
        plt.close(fig)

        # ── PAGE 2 — COMPETITIVE POSITION ─────────────────────────────────
        fig = plt.figure(figsize=PAGE_SIZE)
        draw_header(fig, 'Competitive Position',
                    "The country's Competitor Matrix, OpenAlex standing, and who is subscribing", 2)

        # Layout note: fig.add_axes takes [x, bottom, w, h] — a section's
        # visual "top" is bottom+h, not the bottom argument itself. Every
        # rect below is placed by deciding the top first and computing
        # bottom = top - h, so sections stack downward without overlap.
        ax_stack = fig.add_axes([0.08, 0.73, 0.86, 0.17])
        stacked_product_chart(ax_stack, 'Competitor Matrix — Elsevier & Clarivate Product Status', comp_matrix)

        fig.add_artist(plt.Line2D([0.06, 0.94], [0.685, 0.685], color=LINE, linewidth=1, transform=fig.transFigure))
        link_list(fig, [0.06, 0.445, 0.88, 0.215], 'Notable Status Changes — with proof', proof_rows,
                  empty_text='No notable status changes on file')

        fig.add_artist(plt.Line2D([0.06, 0.94], [0.415, 0.415], color=LINE, linewidth=1, transform=fig.transFigure))
        ax_tier = fig.add_axes([0.06, 0.28, 0.88, 0.115])
        breakdown_list(ax_tier, 'OpenAlex Tier Distribution', tier_counts, TIER_COLORS, order=[t for t in TIER_ORDER if tier_counts.get(t)])

        fig.add_artist(plt.Line2D([0.06, 0.94], [0.255, 0.255], color=LINE, linewidth=1, transform=fig.transFigure))
        link_list(fig, [0.06, 0.055, 0.88, 0.17], 'Who Is Subscribing — OpenAlex', openalex_rows,
                  empty_text='No OpenAlex subscriptions on file')

        draw_footer(fig, generated_at)
        pdf.savefig(fig)
        plt.close(fig)

        # ── PAGE 3 — DAILY DIGEST ───────────────────────────────────────────
        fig = plt.figure(figsize=PAGE_SIZE)
        draw_header(fig, 'Daily Digest',
                    "Today's scanned news and open competitor roles, condensed", 3)

        link_list(fig, [0.06, 0.575, 0.88, 0.32], "Today's News", digest_news_rows,
                  empty_text='No live news stories')

        fig.add_artist(plt.Line2D([0.06, 0.94], [0.555, 0.555], color=LINE, linewidth=1, transform=fig.transFigure))
        link_list(fig, [0.06, 0.285, 0.88, 0.25], 'Competitor Hiring — Open Roles', digest_hiring_rows,
                  empty_text='No open competitor roles tracked')

        fig.add_artist(plt.Line2D([0.06, 0.94], [0.265, 0.265], color=LINE, linewidth=1, transform=fig.transFigure))
        if trend_rows:
            fig.text(0.06, 0.235, 'Week-over-Week Trend', fontsize=11.5, fontweight='bold', color=INK, ha='left', va='top')
            fig.text(0.06, 0.216, f'Change since the {trend_baseline_date.strftime("%d %b %Y")} report', fontsize=7.6, color=MUTED, ha='left', va='top')
            t_tile_y, t_tile_h, t_gap = 0.11, 0.075, 0.014
            t_tile_w = (0.94 - 0.06 - 3 * t_gap) / 4
            t_colors = [TYPE_COLORS['university'], ACCENT, NEWS_CATEGORY_COLORS['competitor_announcements'], '#f87171']
            for i, (label, val, sub) in enumerate(trend_rows):
                x = 0.06 + i * (t_tile_w + t_gap)
                stat_tile(fig, [x, t_tile_y, t_tile_w, t_tile_h], label, val, sub, t_colors[i])
        else:
            ax_trend_note = fig.add_axes([0.06, 0.09, 0.88, 0.155])
            ax_trend_note.axis('off')
            ax_trend_note.text(0.5, 0.5, 'Week-over-week trend appears once at least 3 days of reports are on file.',
                                ha='center', va='center', color=MUTED, fontsize=8.5, transform=ax_trend_note.transAxes)

        draw_footer(fig, generated_at)
        pdf.savefig(fig)
        plt.close(fig)

    return stats, summary_text, generated_dt


def _wrap(text, width):
    import textwrap
    return textwrap.wrap(text, width=width) or ['']


def update_manifest(report_path, stats, summary_text, generated_dt):
    """Every run gets its own manifest entry — same-day re-runs no longer
    overwrite each other. The newest run is always inserted first, so the
    Summary page's "most recent report" is simply manifest[0]. Entries
    beyond MAX_REPORTS are dropped and their PDF files deleted so the repo
    doesn't grow unbounded from repeated manual runs."""
    manifest_path = 'data/summary-reports.json'
    try:
        manifest = json.load(open(manifest_path, encoding='utf-8'))
    except Exception:
        manifest = []
    entry = {
        'id': generated_dt.strftime('%Y%m%dT%H%M%SZ'),
        'date': generated_dt.strftime('%Y-%m-%d'),
        'generatedAt': generated_dt.isoformat(),
        'file': report_path.replace('data/', '', 1) if report_path.startswith('data/') else report_path,
        'summary': summary_text,
        'stats': {
            'institutions': stats['inst_total'],
            'contacts': stats['contacts_total'],
            'contactsIsLive': stats['contacts_is_live'],
            'pending': stats['pending_total'],
            'pendingIsLive': stats['pending_is_live'],
            'news': stats['news_total'],
            'hiring': stats['hiring_total'],
        },
    }
    manifest.insert(0, entry)

    MAX_REPORTS = 100
    dropped, manifest = manifest[MAX_REPORTS:], manifest[:MAX_REPORTS]
    for old in dropped:
        old_file = old.get('file')
        if not old_file:
            continue
        old_path = os.path.join('data', old_file)
        try:
            if os.path.isfile(old_path):
                os.remove(old_path)
        except OSError:
            pass

    os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2)


def main():
    if len(sys.argv) != 3:
        print('Usage: python3 daily_summary.py <input.json> <output.pdf>', file=sys.stderr)
        sys.exit(1)
    input_path, out_path = sys.argv[1], sys.argv[2]
    # Every file here is explicitly UTF-8: the input blob is JSON written by
    # Node and the report is full of non-ASCII (accented institution names,
    # €, ™). Without this, Python falls back to the platform default, which
    # is cp1252 on Windows and raises UnicodeDecodeError on the first such
    # byte — the CI runner happens to default to UTF-8, so this only bites
    # when the script is run locally.
    data = json.load(open(input_path, encoding='utf-8'))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    # Prior reports' stats feed the week-over-week trend section; read
    # before build_report so today's own entry isn't in its own baseline.
    try:
        history = json.load(open('data/summary-reports.json', encoding='utf-8'))
    except Exception:
        history = []
    stats, summary_text, generated_dt = build_report(data, out_path, history if isinstance(history, list) else [])
    update_manifest(out_path, stats, summary_text, generated_dt)
    print(f'Wrote {out_path}')
    print(f'Institutions: {stats["inst_total"]} · Contacts: {stats["contacts_total"]} · Pending: {stats["pending_total"]} · News: {stats["news_total"]} · Hiring: {stats["hiring_total"]}')


if __name__ == '__main__':
    main()
