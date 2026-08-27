#!/usr/bin/env python3
"""
daily_summary.py — builds the 3-page "Daily Summary" executive PDF report
from the JSON blob produced by scripts/extract-crm-data.js.

Usage: python3 scripts/daily_summary.py <input.json> <output.pdf>

Also appends a manifest entry to data/summary-reports.json, which the
"Summary" page in the CRM's Data section reads to build the report archive.
"""
import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth

PAGE_W, PAGE_H = A4
MARGIN = 16 * mm
CONTENT_W = PAGE_W - 2 * MARGIN

INK = colors.HexColor('#0f172a')
MUTED = colors.HexColor('#64748b')
LINE = colors.HexColor('#e2e8f0')
BG_SOFT = colors.HexColor('#f8fafc')

TYPE_COLORS = {
    'university': colors.HexColor('#6366f1'),
    'medical': colors.HexColor('#ef4444'),
    'research': colors.HexColor('#10b981'),
    'ngo': colors.HexColor('#a855f7'),
}
TYPE_LABELS = {'university': 'University', 'medical': 'Medical Center', 'research': 'Research Inst.', 'ngo': 'NGO / Foundation'}
PRIORITY_COLORS = {'high': colors.HexColor('#ef4444'), 'medium': colors.HexColor('#f59e0b'), 'low': colors.HexColor('#64748b')}
ACCENT = colors.HexColor('#0891b2')
LINK_COLOR = colors.HexColor('#0891b2')

NEWS_CATEGORY_COLORS = {
    'ai_adoption': colors.HexColor('#1d4ed8'),
    'funding': colors.HexColor('#059669'),
    'policy': colors.HexColor('#991b1b'),
}
NEWS_CATEGORY_LABELS = {
    'ai_adoption': 'AI Development & Adoption',
    'funding': 'Funding Received',
    'policy': 'Belgium Research Policy',
}
TOTAL_PAGES = 3

WOS_BUCKET_ORDER = ['Active', 'Cancelled', 'Expiring', 'Unknown']
WOS_BUCKET_MAP = {'yes': 'Active', 'cancelled': 'Cancelled', 'expiring': 'Expiring'}
WOS_BUCKET_COLORS = {
    'Active': colors.HexColor('#a78bfa'),
    'Cancelled': colors.HexColor('#ef4444'),
    'Expiring': colors.HexColor('#f59e0b'),
    'Unknown': colors.HexColor('#64748b'),
}


def wrap_text(text, font, size, max_width):
    words = text.split()
    lines, cur = [], ''
    for w in words:
        trial = (cur + ' ' + w).strip()
        if stringWidth(trial, font, size) <= max_width:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def truncate(text, font, size, max_w):
    text = str(text)
    if stringWidth(text, font, size) <= max_w:
        return text
    while text and stringWidth(text + '…', font, size) > max_w:
        text = text[:-1]
    return text + '…'


def draw_link(c, x, y, text, url, font='Helvetica', size=8, color=LINK_COLOR):
    """Draws visible, underlined source-link text and makes it clickable in
    the PDF (canvas.linkURL overlays an invisible clickable rect — the URL
    text itself stays printed/readable for anyone reading on paper)."""
    text = truncate(text, font, size, CONTENT_W)
    c.setFillColor(color)
    c.setFont(font, size)
    c.drawString(x, y, text)
    w = stringWidth(text, font, size)
    c.setStrokeColor(color)
    c.setLineWidth(0.5)
    c.line(x, y - 1.5, x + w, y - 1.5)
    if url:
        c.linkURL(url, (x, y - 2, x + w, y + size), relative=0)
    return w


def draw_header(c, title, subtitle, page_num, total_pages):
    c.setFillColor(INK)
    c.setFont('Helvetica-Bold', 21)
    c.drawString(MARGIN, PAGE_H - MARGIN - 4, title)
    c.setFillColor(MUTED)
    c.setFont('Helvetica', 10.5)
    c.drawString(MARGIN, PAGE_H - MARGIN - 21, subtitle)
    c.setFont('Helvetica', 9)
    c.drawRightString(PAGE_W - MARGIN, PAGE_H - MARGIN - 4, f'Page {page_num} of {total_pages}')
    c.setStrokeColor(LINE)
    c.setLineWidth(1)
    c.line(MARGIN, PAGE_H - MARGIN - 30, PAGE_W - MARGIN, PAGE_H - MARGIN - 30)


def draw_footer(c, generated_at, note=None):
    top = MARGIN + (24 if note else 14)
    c.setStrokeColor(LINE)
    c.line(MARGIN, top, PAGE_W - MARGIN, top)
    if note:
        c.setFillColor(MUTED)
        c.setFont('Helvetica-Oblique', 7)
        for i, line in enumerate(wrap_text(note, 'Helvetica-Oblique', 7, CONTENT_W)[:2]):
            c.drawString(MARGIN, top - 10 - i * 9, line)
    c.setFillColor(MUTED)
    c.setFont('Helvetica', 7.5)
    c.drawRightString(PAGE_W - MARGIN, MARGIN + 4, f'Generated {generated_at}')
    c.drawString(MARGIN, MARGIN + 4, 'Research CRM · Daily Summary')


def draw_stat_tile(c, x, y, w, h, label, value, sub=None, color=ACCENT):
    c.setFillColor(BG_SOFT)
    c.roundRect(x, y, w, h, 4, fill=1, stroke=0)
    c.setStrokeColor(color)
    c.setLineWidth(3)
    c.line(x + 1.5, y, x + 1.5, y + h)
    c.setFillColor(INK)
    c.setFont('Helvetica-Bold', 20)
    c.drawString(x + 12, y + h - 27, str(value))
    c.setFillColor(MUTED)
    c.setFont('Helvetica-Bold', 8.5)
    c.drawString(x + 12, y + h - 42, label.upper())
    if sub:
        c.setFont('Helvetica', 7.5)
        c.setFillColor(MUTED)
        c.drawString(x + 12, y + 9, sub)


def draw_bar_chart(c, x, y, w, h, title, data, color_map=None, default_color=ACCENT, label_fn=None):
    c.setFillColor(INK)
    c.setFont('Helvetica-Bold', 11)
    c.drawString(x, y + h + 8, title)

    items = [(k, v) for k, v in data.items() if v > 0]
    if not items:
        c.setFillColor(MUTED)
        c.setFont('Helvetica', 8)
        c.drawString(x, y + h / 2, 'No data yet')
        return
    max_v = max(v for _, v in items)
    n = len(items)
    gap = 14
    bar_w = min(64, (w - gap * (n - 1)) / n)
    total_row_w = n * bar_w + (n - 1) * gap
    start_x = x + (w - total_row_w) / 2
    label_h = 24
    chart_h = h - label_h - 16

    for i, (k, v) in enumerate(items):
        bx = start_x + i * (bar_w + gap)
        bh = (v / max_v) * chart_h if max_v else 0
        col = (color_map or {}).get(k, default_color)
        c.setFillColor(col)
        c.roundRect(bx, y + label_h, bar_w, max(bh, 2), 3, fill=1, stroke=0)
        c.setFillColor(INK)
        c.setFont('Helvetica-Bold', 11)
        c.drawCentredString(bx + bar_w / 2, y + label_h + bh + 5, str(v))
        c.setFillColor(MUTED)
        c.setFont('Helvetica', 7.5)
        label = (label_fn(k) if label_fn else TYPE_LABELS.get(k, k.title()))
        lines = wrap_text(label, 'Helvetica', 7.5, bar_w + gap)
        for j, line in enumerate(lines):
            c.drawCentredString(bx + bar_w / 2, y + label_h - 10 - j * 9, line)


def draw_table(c, x, y, w, headers, rows, col_ratios, row_h=16, header_h=17, font_size=8.5):
    col_w = [w * r for r in col_ratios]
    cx = [x]
    for cw in col_w:
        cx.append(cx[-1] + cw)

    c.setFillColor(INK)
    c.roundRect(x, y - header_h, w, header_h, 2, fill=1, stroke=0)
    c.setFillColor(colors.white)
    c.setFont('Helvetica-Bold', 7.5)
    for i, h_ in enumerate(headers):
        c.drawString(cx[i] + 7, y - header_h + 5.5, h_.upper())

    ry = y - header_h
    for r_i, row in enumerate(rows):
        ry -= row_h
        if r_i % 2 == 1:
            c.setFillColor(BG_SOFT)
            c.rect(x, ry, w, row_h, fill=1, stroke=0)
        c.setFillColor(INK)
        c.setFont('Helvetica', font_size)
        for i, cell in enumerate(row):
            text = truncate(cell, 'Helvetica', font_size, col_w[i] - 12)
            c.drawString(cx[i] + 7, ry + 5, text)
    c.setStrokeColor(LINE)
    c.rect(x, ry, w, header_h + row_h * len(rows), fill=0, stroke=1)
    return ry


def draw_callout(c, x, y, w, label, headline, body, source_name, source_url, color=ACCENT):
    """A highlighted single-story callout box for the single most important
    news item — the one thing a board member should read even if nothing
    else on the page. Returns the y position just below the box."""
    pad = 12
    headline_lines = wrap_text(headline, 'Helvetica-Bold', 11.5, w - 2 * pad)[:2]
    body_lines = wrap_text(body, 'Helvetica', 9, w - 2 * pad)[:2] if body else []
    box_h = pad + 12 + len(headline_lines) * 15 + (len(body_lines) * 12 + 4 if body_lines else 0) + 15 + pad
    top = y
    c.setFillColor(colors.HexColor('#f8fafc'))
    c.roundRect(x, top - box_h, w, box_h, 5, fill=1, stroke=0)
    c.setStrokeColor(color)
    c.setLineWidth(3)
    c.line(x + 1.5, top - box_h, x + 1.5, top)
    ty = top - pad - 9
    c.setFillColor(color)
    c.setFont('Helvetica-Bold', 8)
    c.drawString(x + pad, ty, label.upper())
    ty -= 16
    c.setFillColor(INK)
    c.setFont('Helvetica-Bold', 11.5)
    for line in headline_lines:
        c.drawString(x + pad, ty, line)
        ty -= 15
    if body_lines:
        c.setFillColor(MUTED)
        c.setFont('Helvetica', 9)
        for line in body_lines:
            c.drawString(x + pad, ty, line)
            ty -= 12
        ty -= 4
    if source_url:
        draw_link(c, x + pad, ty, f'{source_name or "Source"} — {source_url}', source_url, size=7.5)
    elif source_name:
        c.setFillColor(MUTED)
        c.setFont('Helvetica', 7.5)
        c.drawString(x + pad, ty, source_name)
    return top - box_h - 16


def draw_news_summary(c, x, y, w, articles, max_items=6):
    """Renders each article as a compact card: headline, one-line summary
    (elsevierRelevance when the relevance filter tagged it, else the scraped
    description), category badge, and a clickable source link."""
    ny = y
    for n in articles[:max_items]:
        title = n.get('title') or '—'
        title_lines = wrap_text(title, 'Helvetica-Bold', 10, w)[:2]
        cat = n.get('category')
        cat_color = NEWS_CATEGORY_COLORS.get(cat, MUTED)
        cat_label = n.get('categoryLabel') or NEWS_CATEGORY_LABELS.get(cat, 'News')

        c.setFillColor(cat_color)
        c.setFont('Helvetica-Bold', 7)
        badge = cat_label.upper()
        c.drawString(x, ny, badge)
        badge_w = stringWidth(badge, 'Helvetica-Bold', 7)
        meta_bits = list(filter(None, [n.get('institution'), n.get('foundDate') or n.get('publishedDate')]))
        if meta_bits:
            c.setFillColor(MUTED)
            c.setFont('Helvetica', 7)
            c.drawString(x + badge_w + 8, ny, ' · '.join(meta_bits))
        ny -= 13

        c.setFillColor(INK)
        c.setFont('Helvetica-Bold', 10)
        for line in title_lines:
            c.drawString(x, ny, line)
            ny -= 12
        ny -= 1

        summary = n.get('elsevierRelevance') or n.get('description') or ''
        summary = summary.replace('&nbsp;', ' ').strip()
        if summary:
            c.setFillColor(MUTED)
            c.setFont('Helvetica', 8.5)
            for line in wrap_text(summary, 'Helvetica', 8.5, w)[:2]:
                c.drawString(x, ny, line)
                ny -= 11
        ny -= 2

        url = n.get('url')
        if url:
            draw_link(c, x, ny, n.get('sourceName') or url, url, size=7.5)
        ny -= 16
    return ny


def draw_competitor_watch(c, x, y, w, competitors, max_items=5):
    cy = y
    for comp in competitors[:max_items]:
        label = f"{comp.get('company', '—')} — {comp.get('product', '—')}"
        c.setFillColor(INK)
        c.setFont('Helvetica-Bold', 9.5)
        c.drawString(x, cy, truncate(label, 'Helvetica-Bold', 9.5, w))
        cy -= 12

        elements = comp.get('elements') or []
        if elements:
            tag_labels = {
                'literatureSearch': 'Literature Search', 'authorSearch': 'Author Search',
                'fundingDiscovery': 'Funding Discovery', 'writingCoach': 'Writing Coach',
                'trustClaimRadar': 'Trust/Claim Radar', 'deepResearchReports': 'Deep Research',
                'readingAssistant': 'Reading Assistant', 'compareFeature': 'Compare',
            }
            tags = ' · '.join(tag_labels.get(e, e) for e in elements[:3])
            c.setFillColor(colors.HexColor('#7c3aed'))
            c.setFont('Helvetica', 7.5)
            c.drawString(x, cy, f'Challenges: {tags}')
            cy -= 11

        source_url = comp.get('sourceUrl')
        if source_url:
            draw_link(c, x, cy, comp.get('sourceName') or source_url, source_url, size=7.5)
        cy -= 15
    return cy


def compose_summary(stats):
    parts = []
    parts.append(
        f"Research CRM tracks {stats['inst_total']} institutions across Belgium "
        f"({stats['inst_university']} universities, {stats['inst_medical']} medical centres, "
        f"{stats['inst_research']} research institutes, {stats['inst_ngo']} NGOs/foundations) "
        f"and {stats['contacts_total']} verified contacts ({stats['contacts_high_priority']} high priority)."
    )
    if stats['pending_total']:
        if stats['pending_is_live']:
            parts.append(f"{stats['pending_total']} candidate contacts are awaiting review right now.")
        else:
            parts.append(f"{stats['pending_total']} candidate contacts have been discovered via automated scraping since tracking began.")
    if stats['news_total']:
        parts.append(
            f"{stats['news_total']} news items are being tracked"
            + (f", {stats['news_today']} new today" if stats['news_today'] else '') + '.'
        )
    if stats['tenders_total']:
        parts.append(f"{stats['tenders_open']} of {stats['tenders_total']} tracked tenders/RFPs are still open.")
    if stats['openalex_total']:
        parts.append(
            f"{stats['openalex_subscribers']} of {stats['openalex_total']} monitored institutions "
            f"are confirmed OpenAlex subscribers."
        )
    if stats.get('comp_matrix_total'):
        parts.append(
            f"Scopus remains active at {stats['scopus_active']} of {stats['comp_matrix_total']} tracked Belgian "
            f"universities; Clarivate's Web of Science is cancelled or expiring at {stats['wos_at_risk']} of them."
        )
    return ' '.join(parts)


def build_report(data, out_path):
    institutions = data['institutions']
    contacts = data['contacts']
    pending = data['pending']
    news = data['news']
    tenders = data['tenders']
    competitors = data['competitors']
    openalex = data['openalexSubs']

    inst_by_id = {i['id']: i for i in institutions}
    inst_type_counts = Counter(i.get('type', 'research') for i in institutions)
    contact_status_counts = Counter(c.get('status', 'active') for c in contacts)
    contact_priority_counts = Counter(c.get('priority', 'medium') for c in contacts)
    contacts_per_inst = Counter(c.get('instId', '') for c in contacts)

    def resolve_type(inst_id):
        inst = inst_by_id.get(inst_id)
        return inst['type'] if inst else 'research'

    def resolve_name(inst_id, fallback):
        inst = inst_by_id.get(inst_id)
        return inst['name'] if inst else (fallback or inst_id or '—')

    pending_type_counts = Counter(resolve_type(p.get('instId', '')) for p in pending)

    comp_matrix = data.get('competitorMatrix') or {}
    wos_counts = {b: 0 for b in WOS_BUCKET_ORDER}
    scopus_active = 0
    for row in comp_matrix.values():
        wos_counts[WOS_BUCKET_MAP.get((row or {}).get('wos'), 'Unknown')] += 1
        if (row or {}).get('scopus') == 'yes':
            scopus_active += 1
    comp_matrix_total = len(comp_matrix)

    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    news_today = sum(1 for n in news if (n.get('foundDate') or n.get('publishedDate') or '') == today)
    tenders_open = sum(1 for t in tenders if t.get('status') in ('identified', 'inprogress'))
    openalex_subscribers = sum(1 for o in openalex if o.get('status') == 'subscriber')

    stats = {
        'inst_total': len(institutions),
        'inst_university': inst_type_counts.get('university', 0),
        'inst_medical': inst_type_counts.get('medical', 0),
        'inst_research': inst_type_counts.get('research', 0),
        'inst_ngo': inst_type_counts.get('ngo', 0),
        'contacts_total': len(contacts),
        'contacts_active': contact_status_counts.get('active', 0),
        'contacts_prospect': contact_status_counts.get('prospect', 0),
        'contacts_high_priority': contact_priority_counts.get('high', 0),
        'pending_total': len(pending),
        'pending_is_live': data['pendingSource'] == 'supabase',
        'news_total': len(news),
        'news_today': news_today,
        'tenders_total': len(tenders),
        'tenders_open': tenders_open,
        'competitors_total': len(competitors),
        'openalex_total': len(openalex),
        'openalex_subscribers': openalex_subscribers,
        'comp_matrix_total': comp_matrix_total,
        'scopus_active': scopus_active,
        'wos_at_risk': wos_counts['Cancelled'] + wos_counts['Expiring'],
    }

    generated_dt = datetime.now(timezone.utc)
    generated_at = generated_dt.strftime('%d %b %Y, %H:%M UTC')

    news_sorted = sorted(news, key=lambda n: n.get('foundDate') or n.get('publishedDate') or '', reverse=True)
    # The single most important story leads page 1 — prefer a policy-category
    # item (subscription/licensing/assessment-reform news directly touches
    # Elsevier's own business) over a generic AI-adoption or funding item.
    top_story = next((n for n in news_sorted if n.get('category') == 'policy'), None) or (news_sorted[0] if news_sorted else None)

    c = canvas.Canvas(out_path, pagesize=A4)

    # ---------- PAGE 1 — EXECUTIVE SUMMARY ----------
    draw_header(c, 'Research CRM — Daily Summary',
                f'Belgium Academic & Research Network · {generated_dt.strftime("%A, %d %B %Y")}', 1, TOTAL_PAGES)

    summary_text = compose_summary(stats)
    c.setFillColor(INK)
    c.setFont('Helvetica', 10.5)
    y = PAGE_H - MARGIN - 50
    for line in wrap_text(summary_text, 'Helvetica', 10.5, CONTENT_W):
        c.drawString(MARGIN, y, line)
        y -= 14

    if top_story:
        y = draw_callout(
            c, MARGIN, y - 6, CONTENT_W, 'This week\'s top story',
            top_story.get('title', '—'),
            (top_story.get('elsevierRelevance') or top_story.get('description') or '').replace('&nbsp;', ' ').strip(),
            top_story.get('sourceName'), top_story.get('url'),
            color=NEWS_CATEGORY_COLORS.get(top_story.get('category'), ACCENT),
        )
    else:
        y -= 10

    tiles_y = y - 4
    tile_w = (CONTENT_W - 3 * 10) / 4
    tile_h = 60
    pending_label = 'awaiting review' if stats['pending_is_live'] else 'discovered to date'
    tiles = [
        ('Institutions', stats['inst_total'], f"{stats['inst_medical']} medical · {stats['inst_university']} university", TYPE_COLORS['university']),
        ('Contacts', stats['contacts_total'], f"{stats['contacts_high_priority']} high priority", ACCENT),
        ('New Contacts', stats['pending_total'], pending_label, colors.HexColor('#a855f7')),
        ('News Tracked', stats['news_total'], f"{stats['news_today']} new today", colors.HexColor('#3b82f6')),
    ]
    for i, (label, val, sub, col) in enumerate(tiles):
        tx = MARGIN + i * (tile_w + 10)
        draw_stat_tile(c, tx, tiles_y - tile_h, tile_w, tile_h, label, val, sub, col)

    tiles2_y = tiles_y - tile_h - 14
    avg_per_inst = round(stats['contacts_total'] / stats['inst_total'], 1) if stats['inst_total'] else 0
    tiles2 = [
        ('Open Tenders / RFPs', f"{stats['tenders_open']}/{stats['tenders_total']}", 'open of tracked', colors.HexColor('#f59e0b')),
        ('Competitors Tracked', stats['competitors_total'], 'products monitored', TYPE_COLORS['medical']),
        ('OpenAlex Subscribers', f"{stats['openalex_subscribers']}/{stats['openalex_total']}", 'confirmed of tracked', TYPE_COLORS['research']),
        ('Avg Contacts / Institution', avg_per_inst, 'CRM coverage density', colors.HexColor('#0ea5e9')),
    ]
    for i, (label, val, sub, col) in enumerate(tiles2):
        tx = MARGIN + i * (tile_w + 10)
        draw_stat_tile(c, tx, tiles2_y - tile_h, tile_w, tile_h, label, val, sub, col)

    charts_top = tiles2_y - tile_h - 34
    chart_w = (CONTENT_W - 24) / 2
    chart_h = 165
    draw_bar_chart(c, MARGIN, charts_top - chart_h, chart_w, chart_h,
                    'Institutions by Type', inst_type_counts, TYPE_COLORS)
    if comp_matrix_total:
        draw_bar_chart(c, MARGIN + chart_w + 24, charts_top - chart_h, chart_w, chart_h,
                        'Web of Science Status — Clarivate (Belgian Universities)', wos_counts, WOS_BUCKET_COLORS,
                        label_fn=lambda k: k)
    else:
        draw_bar_chart(c, MARGIN + chart_w + 24, charts_top - chart_h, chart_w, chart_h,
                        'Contacts by Priority', contact_priority_counts, PRIORITY_COLORS,
                        label_fn=lambda k: k.title())

    pending_note = None if stats['pending_is_live'] else 'New Contacts total is from the local scrape audit trail, not live Supabase status — see the Summary archive for context.'
    draw_footer(c, generated_at, pending_note)
    c.showPage()

    # ---------- PAGE 2 — PIPELINE & INSTITUTIONS ----------
    draw_header(c, 'Pipeline & Institutions', 'Where contact coverage is strongest, and what needs review', 2, TOTAL_PAGES)

    top_insts = sorted(contacts_per_inst.items(), key=lambda kv: kv[1], reverse=True)[:6]
    list_top = PAGE_H - MARGIN - 50
    c.setFillColor(INK)
    c.setFont('Helvetica-Bold', 12)
    c.drawString(MARGIN, list_top, 'Top Institutions by Contact Count')
    ly = list_top - 24
    bar_area_w = CONTENT_W - 170
    max_c = top_insts[0][1] if top_insts else 1
    if top_insts:
        for inst_id, cnt in top_insts:
            name = resolve_name(inst_id, inst_id)
            c.setFillColor(INK)
            c.setFont('Helvetica', 9)
            c.drawString(MARGIN, ly + 3, truncate(name, 'Helvetica', 9, 150))
            bw = (cnt / max_c) * bar_area_w if max_c else 0
            c.setFillColor(colors.HexColor('#0891b2'))
            c.roundRect(MARGIN + 160, ly, max(bw, 4), 11, 2, fill=1, stroke=0)
            c.setFillColor(INK)
            c.setFont('Helvetica-Bold', 9)
            c.drawString(MARGIN + 160 + bw + 6, ly + 3, str(cnt))
            ly -= 20
    else:
        c.setFillColor(MUTED)
        c.setFont('Helvetica', 9)
        c.drawString(MARGIN, ly, 'No contacts recorded yet.')
        ly -= 20

    y2 = ly - 20
    c.setFillColor(INK)
    c.setFont('Helvetica-Bold', 12)
    c.drawString(MARGIN, y2, 'Latest New Contacts')
    y2 -= 22
    recent_pending = sorted(pending, key=lambda p: p.get('createdAt') or '', reverse=True)[:8]
    if recent_pending:
        rows = [[f"{p.get('first','')} {p.get('last','')}".strip() or '—',
                  resolve_name(p.get('instId', ''), p.get('instName')),
                  TYPE_LABELS.get(resolve_type(p.get('instId', '')), '—'),
                  p.get('dept') or '—'] for p in recent_pending]
        end_y = draw_table(c, MARGIN, y2, CONTENT_W,
                            ['Name', 'Institution', 'Type', 'Department'], rows,
                            [0.24, 0.34, 0.20, 0.22])
        y2 = end_y - 28
    else:
        c.setFillColor(MUTED)
        c.setFont('Helvetica', 9)
        c.drawString(MARGIN, y2 - 4, 'No pending contacts recorded.')
        y2 -= 30

    col_w = (CONTENT_W - 24) / 2
    c.setFillColor(INK)
    c.setFont('Helvetica-Bold', 12)
    c.drawString(MARGIN, y2, 'Open Tenders / RFPs')
    open_tenders = [t for t in tenders if t.get('status') in ('identified', 'inprogress')][:5]
    ty = y2 - 22
    if open_tenders:
        for t in open_tenders:
            c.setFillColor(INK)
            c.setFont('Helvetica-Bold', 9)
            title = t.get('title', '—')
            lines = wrap_text(title, 'Helvetica-Bold', 9, col_w)[:2]
            for line in lines:
                c.drawString(MARGIN, ty, line)
                ty -= 11
            c.setFillColor(MUTED)
            c.setFont('Helvetica', 8)
            c.drawString(MARGIN, ty, f"{t.get('institution','—')} · {t.get('status','—')}")
            ty -= 20
    else:
        c.setFillColor(MUTED)
        c.setFont('Helvetica', 9)
        c.drawString(MARGIN, ty, 'None currently open.')
        ty -= 16

    c.setFillColor(INK)
    c.setFont('Helvetica-Bold', 12)
    c.drawString(MARGIN + col_w + 24, y2, 'Institutions by Contact Coverage')
    cov_bins = Counter()
    for i in institutions:
        n = contacts_per_inst.get(i['id'], 0)
        cov_bins['0'] += 1 if n == 0 else 0
        cov_bins['1-2'] += 1 if 1 <= n <= 2 else 0
        cov_bins['3-5'] += 1 if 3 <= n <= 5 else 0
        cov_bins['6+'] += 1 if n >= 6 else 0
    cov_labels = {'0': 'No contacts', '1-2': '1–2 contacts', '3-5': '3–5 contacts', '6+': '6+ contacts'}
    cov_colors = {'0': colors.HexColor('#ef4444'), '1-2': colors.HexColor('#f59e0b'),
                  '3-5': colors.HexColor('#10b981'), '6+': colors.HexColor('#0891b2')}
    cy = y2 - 22
    cov_max = max(cov_bins.values()) if cov_bins else 1
    for key in ['0', '1-2', '3-5', '6+']:
        cnt = cov_bins.get(key, 0)
        c.setFillColor(INK)
        c.setFont('Helvetica', 9)
        c.drawString(MARGIN + col_w + 24, cy + 3, cov_labels[key])
        bar_w = col_w - 70
        bw = (cnt / cov_max) * bar_w if cov_max else 0
        c.setFillColor(cov_colors[key])
        c.roundRect(MARGIN + col_w + 24 + 88, cy, max(bw, 4) if cnt else 0, 11, 2, fill=1, stroke=0)
        c.setFillColor(INK)
        c.setFont('Helvetica-Bold', 9)
        c.drawString(MARGIN + col_w + 24 + 88 + bw + 6, cy + 3, str(cnt))
        cy -= 20

    draw_footer(c, generated_at)
    c.showPage()

    # ---------- PAGE 3 — NEWS & MARKET INTELLIGENCE ----------
    draw_header(c, 'News & Market Intelligence',
                'This week\'s key stories with sourced links, plus tracked LeapSpace competitor activity', 3, TOTAL_PAGES)

    y3 = PAGE_H - MARGIN - 50
    c.setFillColor(INK)
    c.setFont('Helvetica-Bold', 12)
    c.drawString(MARGIN, y3, 'Top Stories This Week')
    y3 -= 22
    if news_sorted:
        y3 = draw_news_summary(c, MARGIN, y3, CONTENT_W, news_sorted, max_items=5)
    else:
        c.setFillColor(MUTED)
        c.setFont('Helvetica', 9)
        c.drawString(MARGIN, y3, 'No news items tracked yet.')
        y3 -= 20

    y3 -= 8
    c.setStrokeColor(LINE)
    c.setLineWidth(1)
    c.line(MARGIN, y3, PAGE_W - MARGIN, y3)
    y3 -= 22

    c.setFillColor(INK)
    c.setFont('Helvetica-Bold', 12)
    c.drawString(MARGIN, y3, 'Competitor Watch — LeapSpace')
    y3 -= 22
    if competitors:
        comp_sorted = sorted(competitors, key=lambda x: x.get('addedDate') or '', reverse=True)
        draw_competitor_watch(c, MARGIN, y3, CONTENT_W, comp_sorted, max_items=5)
    else:
        c.setFillColor(MUTED)
        c.setFont('Helvetica', 9)
        c.drawString(MARGIN, y3, 'None tracked yet.')

    draw_footer(c, generated_at)
    c.showPage()
    c.save()

    return stats, summary_text, generated_dt


def update_manifest(report_path, stats, summary_text, generated_dt):
    """Every run gets its own manifest entry — same-day re-runs no longer
    overwrite each other. The newest run is always inserted first, so the
    Summary page's "most recent report" is simply manifest[0]. Entries
    beyond MAX_REPORTS are dropped and their PDF files deleted so the repo
    doesn't grow unbounded from repeated manual runs."""
    manifest_path = 'data/summary-reports.json'
    try:
        manifest = json.load(open(manifest_path))
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
            'pending': stats['pending_total'],
            'pendingIsLive': stats['pending_is_live'],
            'news': stats['news_total'],
            'tendersOpen': stats['tenders_open'],
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
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)


def main():
    if len(sys.argv) != 3:
        print('Usage: python3 daily_summary.py <input.json> <output.pdf>', file=sys.stderr)
        sys.exit(1)
    input_path, out_path = sys.argv[1], sys.argv[2]
    data = json.load(open(input_path))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    stats, summary_text, generated_dt = build_report(data, out_path)
    update_manifest(out_path, stats, summary_text, generated_dt)
    print(f'Wrote {out_path}')
    print(f'Institutions: {stats["inst_total"]} · Contacts: {stats["contacts_total"]} · Pending: {stats["pending_total"]}')


if __name__ == '__main__':
    main()
