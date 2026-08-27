#!/usr/bin/env python3
"""
daily_summary.py — builds the 3-page analytics PDF (crm_summary.pdf) from the
JSON blob produced by scripts/extract-crm-data.js, using matplotlib's
PdfPages. A4 portrait.

Page 1 — KPI Summary: institution count, contact count, open deals, open
  pipeline value; institutions by type; contacts by status; contacts by
  priority; contact data quality.
Page 2 — Competitive Position: Scopus/SciVal/Pure/WoS status as a stacked
  bar across institutions; relationship warmth breakdown; upcoming renewals
  (next 90 days); OpenAlex tier distribution.
Page 3 — Pipeline & Activity: deal pipeline by stage (count and value);
  interactions by type; interaction activity trend over the last 12 weeks.

Usage: python3 scripts/daily_summary.py <input.json> <output.pdf>

Also appends a manifest entry to data/summary-reports.json, which the
"Summary" page in the CRM's Data section reads to build the report archive.
"""
import json
import os
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.patches import FancyBboxPatch

REGION_LABEL = 'Belgium'
TOTAL_PAGES = 3
PAGE_SIZE = (8.27, 11.69)  # A4 portrait, inches

# ── palette — mirrors the app's own colors ──────────────────────────────────
INK = '#0f172a'
MUTED = '#64748b'
LINE = '#e2e8f0'
BG_SOFT = '#f8fafc'
ACCENT = '#0891b2'

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

WARMTH_ORDER = ['hot', 'warm', 'cold', '']
WARMTH_COLORS = {'hot': '#ef4444', 'warm': '#f59e0b', 'cold': '#60a5fa', '': '#94a3b8'}
WARMTH_LABELS = {'hot': 'Hot', 'warm': 'Warm', 'cold': 'Cold', '': 'Not Set'}

TIER_ORDER = ['Partner', 'Member+', 'Member', 'None']
TIER_COLORS = {'Partner': '#fbbf24', 'Member+': '#60a5fa', 'Member': '#34d399', 'None': '#94a3b8'}

STAGE_ORDER = ['prospect', 'engaged', 'proposal', 'negotiation', 'closed-won', 'closed-lost']
STAGE_LABELS = {'prospect': 'Prospect', 'engaged': 'Engaged', 'proposal': 'Proposal',
                 'negotiation': 'Negotiation', 'closed-won': 'Closed\nWon', 'closed-lost': 'Closed\nLost'}
STAGE_COLORS = {'prospect': '#94a3b8', 'engaged': '#60a5fa', 'proposal': '#a78bfa',
                 'negotiation': '#f59e0b', 'closed-won': '#10b981', 'closed-lost': '#ef4444'}
OPEN_STAGES = {'prospect', 'engaged', 'proposal', 'negotiation'}

INTERACTION_TYPE_COLORS = {'call': '#0891b2', 'email': '#6366f1', 'meeting': '#10b981', 'demo': '#a855f7', 'other': '#94a3b8'}


def fmt_eur(v):
    if v >= 1_000_000:
        return f'€{v/1_000_000:.1f}M'
    if v >= 1_000:
        return f'€{v/1_000:.0f}K'
    return f'€{v:.0f}'


def draw_header(fig, title, subtitle, page_num):
    fig.text(0.06, 0.965, title, fontsize=18, fontweight='bold', color=INK, ha='left', va='top')
    fig.text(0.06, 0.943, subtitle, fontsize=9.5, color=MUTED, ha='left', va='top')
    fig.text(0.94, 0.965, f'Page {page_num} of {TOTAL_PAGES}', fontsize=8.5, color=MUTED, ha='right', va='top')
    fig.add_artist(plt.Line2D([0.06, 0.94], [0.925, 0.925], color=LINE, linewidth=1, transform=fig.transFigure))


def draw_footer(fig, generated_at, note=None):
    line_y = 0.042 if note else 0.035
    fig.add_artist(plt.Line2D([0.06, 0.94], [line_y, line_y], color=LINE, linewidth=1, transform=fig.transFigure))
    if note:
        fig.text(0.06, line_y - 0.010, note, fontsize=6.3, color=MUTED, style='italic', ha='left', va='top')
    fig.text(0.94, 0.014, f'Generated {generated_at}', fontsize=7, color=MUTED, ha='right', va='bottom')
    fig.text(0.06, 0.014, f'Research CRM · {REGION_LABEL} · Daily Summary', fontsize=7, color=MUTED, ha='left', va='bottom')


def stat_tile(fig, rect, label, value, sub, color):
    ax = fig.add_axes(rect)
    ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis('off')
    ax.add_patch(FancyBboxPatch((0.0, 0.0), 1.0, 1.0, boxstyle='round,pad=0,rounding_size=0.08',
                                 linewidth=0, facecolor=BG_SOFT, transform=ax.transAxes, clip_on=False))
    ax.plot([0.025, 0.025], [0.12, 0.88], color=color, linewidth=4, transform=ax.transAxes, solid_capstyle='butt')
    ax.text(0.12, 0.60, str(value), fontsize=18, fontweight='bold', color=INK, transform=ax.transAxes, va='center')
    ax.text(0.12, 0.30, label.upper(), fontsize=7, fontweight='bold', color=MUTED, transform=ax.transAxes, va='center')
    if sub:
        ax.text(0.12, 0.12, sub, fontsize=6.5, color=MUTED, transform=ax.transAxes, va='center')


def bar_chart(ax, title, data, color_map=None, label_map=None, default_color=ACCENT, order=None):
    ax.set_title(title, fontsize=10, fontweight='bold', color=INK, loc='left', pad=8)
    keys = order if order else list(data.keys())
    items = [(k, data.get(k, 0)) for k in keys if data.get(k, 0)]
    if not items:
        ax.text(0.5, 0.5, 'No data yet', ha='center', va='center', color=MUTED, fontsize=9, transform=ax.transAxes)
        ax.axis('off')
        return
    ks = [k for k, v in items]
    vs = [v for k, v in items]
    cs = [(color_map or {}).get(k, default_color) for k in ks]
    labels = [(label_map or {}).get(k, str(k).title()) for k in ks]
    bars = ax.bar(range(len(ks)), vs, color=cs, width=0.62, zorder=3)
    ax.set_xticks(range(len(ks)))
    ax.set_xticklabels(labels, fontsize=7.5, color=MUTED)
    for spine in ['top', 'right', 'left']:
        ax.spines[spine].set_visible(False)
    ax.get_yaxis().set_visible(False)
    ax.set_ylim(0, max(vs) * 1.25)
    for b, v in zip(bars, vs):
        ax.text(b.get_x() + b.get_width() / 2, b.get_height() + max(vs) * 0.03, str(v),
                 ha='center', fontsize=8.5, fontweight='bold', color=INK)
    ax.tick_params(axis='x', length=0)


def stacked_product_chart(ax, title, comp_matrix):
    ax.set_title(title, fontsize=10.5, fontweight='bold', color=INK, loc='left', pad=8)
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
            if h > 0:
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


def renewals_chart(ax, title, renewals):
    ax.set_title(title, fontsize=10, fontweight='bold', color=INK, loc='left', pad=8)
    if not renewals:
        ax.text(0.5, 0.5, 'No renewals due in the next 90 days', ha='center', va='center',
                 color=MUTED, fontsize=9, transform=ax.transAxes)
        ax.axis('off')
        return
    renewals = sorted(renewals, key=lambda r: r[1])[:8]
    names = [r[0] for r in renewals]
    days = [r[1] for r in renewals]
    colors = ['#ef4444' if d <= 30 else '#f59e0b' if d <= 60 else '#60a5fa' for d in days]
    y = range(len(names))
    ax.barh(y, days, color=colors, height=0.6, zorder=3)
    ax.set_yticks(list(y))
    ax.set_yticklabels(names, fontsize=8, color=INK)
    ax.invert_yaxis()
    for spine in ['top', 'right', 'left']:
        ax.spines[spine].set_visible(False)
    ax.get_xaxis().set_visible(False)
    for i, d in enumerate(days):
        ax.text(d + max(days) * 0.02, i, f'{d}d', va='center', fontsize=7.5, fontweight='bold', color=INK)
    ax.set_xlim(0, max(days) * 1.2)


def trend_chart(ax, title, weekly_counts, week_labels):
    ax.set_title(title, fontsize=10, fontweight='bold', color=INK, loc='left', pad=8)
    if not any(weekly_counts):
        ax.text(0.5, 0.5, 'No interactions logged yet', ha='center', va='center',
                 color=MUTED, fontsize=9, transform=ax.transAxes)
        ax.axis('off')
        return
    x = range(len(weekly_counts))
    ax.plot(x, weekly_counts, color=ACCENT, linewidth=2, marker='o', markersize=4, zorder=3)
    ax.fill_between(x, weekly_counts, color=ACCENT, alpha=0.12)
    ax.set_xticks(list(x))
    ax.set_xticklabels(week_labels, fontsize=6.5, color=MUTED, rotation=45, ha='right')
    for spine in ['top', 'right']:
        ax.spines[spine].set_visible(False)
    ax.spines['left'].set_color(LINE)
    ax.tick_params(axis='y', labelsize=7, colors=MUTED, length=0)
    ax.grid(axis='y', color=LINE, linewidth=0.6, zorder=0)
    ax.set_ylim(bottom=0)


def compose_summary(stats):
    parts = []
    parts.append(
        f"Research CRM tracks {stats['inst_total']} institutions across Belgium "
        f"({stats['inst_university']} universities, {stats['inst_medical']} medical centres, "
        f"{stats['inst_research']} research institutes, {stats['inst_ngo']} NGOs/foundations) "
        f"and {stats['contacts_total']} verified contacts ({stats['contacts_high_priority']} high priority)."
    )
    if stats['deals_open']:
        parts.append(f"{stats['deals_open']} open deals in the pipeline worth {fmt_eur(stats['pipeline_value'])}.")
    if stats['pending_total']:
        if stats['pending_is_live']:
            parts.append(f"{stats['pending_total']} candidate contacts are awaiting review right now.")
        else:
            parts.append(f"{stats['pending_total']} candidate contacts have been discovered via automated scraping since tracking began.")
    if stats['renewals_90d']:
        parts.append(f"{stats['renewals_90d']} product renewal(s) due in the next 90 days.")
    if stats.get('comp_matrix_total'):
        parts.append(
            f"Scopus remains active at {stats['scopus_active']} of {stats['comp_matrix_total']} tracked Belgian "
            f"institutions; Clarivate's Web of Science is cancelled or expiring at {stats['wos_at_risk']} of them."
        )
    return ' '.join(parts)


def build_report(data, out_path):
    institutions = data['institutions']
    contacts = data['contacts']
    pending = data.get('pending', [])
    opportunities = data.get('opportunities', [])
    interactions = data.get('interactions', [])
    comp_matrix = data.get('competitorMatrix') or {}

    inst_type_counts = Counter(i.get('type', 'research') for i in institutions)
    contact_status_counts = Counter(c.get('status', 'active') for c in contacts)
    contact_priority_counts = Counter(c.get('priority', 'medium') for c in contacts)
    contact_quality_counts = Counter(c.get('quality', 'verified') for c in contacts)

    inst_by_id = {i['id']: i for i in institutions}

    open_deals = [o for o in opportunities if o.get('stage') in OPEN_STAGES]
    pipeline_value = sum(o.get('value') or 0 for o in open_deals)
    stage_counts = Counter(o.get('stage', 'prospect') for o in opportunities)
    stage_values = {}
    for o in opportunities:
        stage_values[o.get('stage', 'prospect')] = stage_values.get(o.get('stage', 'prospect'), 0) + (o.get('value') or 0)

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

    interaction_type_counts = Counter(n.get('type', 'other') for n in interactions)

    week_labels, weekly_counts = [], []
    for w in range(11, -1, -1):
        week_start = today - timedelta(days=today.weekday() + w * 7)
        week_end = week_start + timedelta(days=6)
        cnt = 0
        for n in interactions:
            dt = n.get('date')
            if not dt:
                continue
            try:
                d = datetime.strptime(dt[:10], '%Y-%m-%d').date()
            except (ValueError, TypeError):
                continue
            if week_start <= d <= week_end:
                cnt += 1
        weekly_counts.append(cnt)
        week_labels.append(week_start.strftime('%d %b'))

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
        'deals_open': len(open_deals),
        'pipeline_value': pipeline_value,
        'pending_total': len(pending),
        'pending_is_live': data.get('pendingSource') == 'supabase',
        'renewals_90d': len(renewals),
        'comp_matrix_total': len(comp_matrix),
        'scopus_active': scopus_active,
        'wos_at_risk': wos_at_risk,
    }

    generated_dt = datetime.now(timezone.utc)
    generated_at = generated_dt.strftime('%d %b %Y, %H:%M UTC')
    summary_text = compose_summary(stats)

    with PdfPages(out_path) as pdf:
        # ── PAGE 1 — KPI SUMMARY ──────────────────────────────────────────
        fig = plt.figure(figsize=PAGE_SIZE)
        draw_header(fig, 'Research CRM — Daily Summary',
                    f'{REGION_LABEL} Academic & Research Network · {generated_dt.strftime("%A, %d %B %Y")}', 1)

        tile_y, tile_h, gap = 0.845, 0.075, 0.015
        tile_w = (0.94 - 0.06 - 3 * gap) / 4
        tiles = [
            ('Institutions', stats['inst_total'], f"{stats['inst_medical']} medical · {stats['inst_university']} university", TYPE_COLORS['university']),
            ('Contacts', stats['contacts_total'], f"{stats['contacts_high_priority']} high priority", ACCENT),
            ('Open Deals', stats['deals_open'], f"{len(opportunities)} total tracked", STAGE_COLORS['negotiation']),
            ('Open Pipeline Value', fmt_eur(stats['pipeline_value']), 'across open-stage deals', TYPE_COLORS['research']),
        ]
        for i, (label, val, sub, col) in enumerate(tiles):
            x = 0.06 + i * (tile_w + gap)
            stat_tile(fig, [x, tile_y, tile_w, tile_h], label, val, sub, col)

        gs_top, gs_bottom = 0.78, 0.09
        row_h = (gs_top - gs_bottom - 0.06) / 2
        col_w = (0.94 - 0.06 - 0.06) / 2
        positions = [
            [0.06, gs_bottom + row_h + 0.06, col_w, row_h],
            [0.06 + col_w + 0.06, gs_bottom + row_h + 0.06, col_w, row_h],
            [0.06, gs_bottom, col_w, row_h],
            [0.06 + col_w + 0.06, gs_bottom, col_w, row_h],
        ]
        ax1 = fig.add_axes(positions[0])
        bar_chart(ax1, 'Institutions by Type', inst_type_counts, TYPE_COLORS, TYPE_LABELS)
        ax2 = fig.add_axes(positions[1])
        bar_chart(ax2, 'Contacts by Status', contact_status_counts, STATUS_COLORS, {k: k.title() for k in contact_status_counts})
        ax3 = fig.add_axes(positions[2])
        bar_chart(ax3, 'Contacts by Priority', contact_priority_counts, PRIORITY_COLORS, {k: k.title() for k in contact_priority_counts})
        ax4 = fig.add_axes(positions[3])
        bar_chart(ax4, 'Contact Data Quality', contact_quality_counts, QUALITY_COLORS, {k: k.title() for k in contact_quality_counts})

        pending_note = None if stats['pending_is_live'] else 'New Contacts total is from the local scrape audit trail, not live Supabase status.'
        draw_footer(fig, generated_at, pending_note)
        pdf.savefig(fig)
        plt.close(fig)

        # ── PAGE 2 — COMPETITIVE POSITION ─────────────────────────────────
        fig = plt.figure(figsize=PAGE_SIZE)
        draw_header(fig, 'Competitive Position',
                    'Elsevier vs. Clarivate product status, relationship warmth, and upcoming renewals', 2)

        ax_stack = fig.add_axes([0.08, 0.62, 0.86, 0.26])
        stacked_product_chart(ax_stack, 'Competitor Product Status Across Institutions', comp_matrix)

        ax_warmth = fig.add_axes([0.06, 0.34, col_w, 0.20])
        bar_chart(ax_warmth, 'Relationship Warmth', warmth_counts, WARMTH_COLORS, WARMTH_LABELS, order=WARMTH_ORDER)

        ax_tier = fig.add_axes([0.06 + col_w + 0.06, 0.34, col_w, 0.20])
        bar_chart(ax_tier, 'OpenAlex Tier Distribution', tier_counts, TIER_COLORS, order=[t for t in TIER_ORDER if tier_counts.get(t)])

        ax_renew = fig.add_axes([0.08, 0.09, 0.86, 0.19])
        renewals_chart(ax_renew, 'Upcoming Renewals — Next 90 Days (days remaining)', renewals)

        draw_footer(fig, generated_at)
        pdf.savefig(fig)
        plt.close(fig)

        # ── PAGE 3 — PIPELINE & ACTIVITY ───────────────────────────────────
        fig = plt.figure(figsize=PAGE_SIZE)
        draw_header(fig, 'Pipeline & Activity',
                    'Deal pipeline by stage, interaction mix, and recent engagement trend', 3)

        ax_stage_count = fig.add_axes([0.06, 0.62, col_w, 0.26])
        bar_chart(ax_stage_count, 'Deal Pipeline — Count by Stage', stage_counts, STAGE_COLORS, STAGE_LABELS, order=STAGE_ORDER)

        ax_stage_val = fig.add_axes([0.06 + col_w + 0.06, 0.62, col_w, 0.26])
        stage_val_fmt = {k: fmt_eur(v) for k, v in stage_values.items() if v}
        bar_chart(ax_stage_val, 'Deal Pipeline — Value by Stage', stage_values, STAGE_COLORS, STAGE_LABELS, order=STAGE_ORDER)
        # Overwrite the auto count labels on the value chart with currency
        for txt in ax_stage_val.texts:
            try:
                v = float(txt.get_text())
            except ValueError:
                continue
            txt.set_text(fmt_eur(v))

        ax_inter = fig.add_axes([0.06, 0.34, col_w, 0.20])
        bar_chart(ax_inter, 'Interactions by Type', interaction_type_counts, INTERACTION_TYPE_COLORS, {k: k.title() for k in interaction_type_counts})

        ax_trend = fig.add_axes([0.06 + col_w + 0.06, 0.30, col_w, 0.24])
        trend_chart(ax_trend, 'Interaction Activity — Last 12 Weeks', weekly_counts, week_labels)

        draw_footer(fig, generated_at)
        pdf.savefig(fig)
        plt.close(fig)

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
            'openDeals': stats['deals_open'],
            'pipelineValue': stats['pipeline_value'],
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
    print(f'Institutions: {stats["inst_total"]} · Contacts: {stats["contacts_total"]} · Open deals: {stats["deals_open"]}')


if __name__ == '__main__':
    main()
