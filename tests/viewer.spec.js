// A viewer can look at everything and change nothing (#87).
//
// For every page: sign in as a viewer with realistic rows in the database,
// click every distinct control the page shows, and require that no write is
// sent, no editing window opens and no admin-only control is visible.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { openApp } = require('./support/stubs');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const VIEWS = [...SOURCE.match(/function render\(\) \{\s*const views = \{([\s\S]*?)\n\s*\};/)[1]
  .matchAll(/^\s*'?([a-z0-9-]+)'?\s*:/gm)].map(x => x[1]);
const INST_SCOPED = ['detail', 'org-map'];

// Windows that exist to change data. A viewer must never be shown one.
const WRITE_WINDOWS = ['modal-inst', 'modal-contact', 'modal-opp', 'modal-int', 'modal-acct', 'modal-del',
  'modal-sync-contacts', 'modal-gh-token', 'alog-modal'];

const today = () => new Date().toISOString().slice(0, 10);
const rows = inst => ({
  crm_institutions: [{ id: inst.id, name: inst.name, short: inst.short, type: inst.type, city: inst.city,
    warmth: 'warm', next_action: 'Send proposal', next_action_date: today(), ws_pinned: true, product_status: { pure: 'no' } }],
  crm_contacts: [
    { id: 'c1', inst_id: inst.id, first: 'Anna', last: 'de Vries', title: 'Library Director', dept: 'Library', email: 'a@example.org', status: 'active', priority: 'high', quality: 'verified' },
    { id: 'c2', inst_id: inst.id, first: 'Bram', last: 'Jansen', title: 'Rector', dept: 'Board', email: '', status: 'prospect', priority: 'medium' },
  ],
  crm_opportunities: [{ id: 'o1', inst_id: inst.id, name: 'Pure renewal', stage: 'proposal', value: 42000, close_date: today() }],
  crm_interactions: [{ id: 'i1', inst_id: inst.id, contact_id: 'c1', date: today(), type: 'call', summary: 'Intro call' }],
  crm_tenders: [{ id: 't1', title: 'Research information system', institution: inst.name, published_date: today(), deadline: '2027-01-31', status: 'identified', product: 'Pure', url: 'https://example.org/t1', created_at: today() }],
  pending_contacts: [{ id: 'p1', institution_id: inst.id, first: 'Eva', last: 'Smit', title: 'Research Director', department: 'Research', email: 'e@example.org', status: 'pending', source_url: 'https://example.org/staff', created_at: today() }],
});

async function openAsViewer(browser) {
  const baseURL = test.info().project.use.baseURL;
  const probe = await browser.newPage({ baseURL });
  await openApp(probe);
  const inst = await probe.evaluate(() => { const x = state.institutions[0]; return { id: x.id, name: x.name, short: x.short, type: x.type, city: x.city }; });
  await probe.close();

  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  // Anything a click opens in a new tab is closed straight away.
  context.on('page', p => { if (p !== page) p.close().catch(() => {}); });
  page.on('dialog', d => d.accept().catch(() => {}));
  const net = await openApp(page, { role: 'viewer', tables: rows(inst) });
  return { page, context, inst, ...net };
}

test.describe('a viewer can look at everything and change nothing', () => {
  for (const view of VIEWS) {
    test(`on "${view}"`, async ({ browser }) => {
      test.setTimeout(150000);
      const { page, context, inst, writes } = await openAsViewer(browser);
      const go = () => page.evaluate(([v, id]) => nav(v, id ? { instId: id } : {}), [view, INST_SCOPED.includes(view) ? inst.id : null]);
      const closeWindows = () => page.evaluate(ids => ids.forEach(id => { const el = document.getElementById(id); if (el) el.classList.remove('open'); }), WRITE_WINDOWS);
      const visibleAdminOnly = () => page.locator('[data-admin-only]').evaluateAll(els => els
        .filter(e => getComputedStyle(e).display !== 'none' && e.offsetParent !== null)
        .map(e => (e.textContent.trim() || e.getAttribute('title') || e.tagName).replace(/\s+/g, ' ').slice(0, 40)));

      await go();
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(400);

      const offenders = [];
      for (const label of await visibleAdminOnly()) offenders.push(`admin-only control visible on arrival: "${label}"`);

      // One representative per kind of control: ids and numbers are collapsed
      // so forty rows with the same button count once.
      const controls = await page.evaluate(() => {
        const seen = new Map();
        document.querySelectorAll('#content [onclick], #topbar-actions [onclick], #content [onchange], #topbar-actions [onchange]').forEach(el => {
          if (el.offsetParent === null) return;
          const attr = el.hasAttribute('onclick') ? 'onclick' : 'onchange';
          const code = el.getAttribute(attr);
          const shape = attr + ':' + code.replace(/'[^']*'|"[^"]*"/g, "'_'").replace(/\d+/g, 'N');
          if (!seen.has(shape)) seen.set(shape, { attr, code, label: (el.textContent || el.title || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40) });
        });
        return [...seen.values()];
      });

      for (const c of controls.slice(0, 45)) {
        if (/logout\(|location\.href|\.reload\(/.test(c.code)) continue;
        await closeWindows();
        await go();
        await page.waitForTimeout(120);
        const before = writes.length;
        const clicked = await page.evaluate(([attr, code]) => {
          const el = [...document.querySelectorAll('[' + attr + ']')].find(e => e.getAttribute(attr) === code && e.offsetParent !== null);
          if (!el) return false;
          if (attr === 'onchange') {
            if (el.tagName === 'SELECT' && el.options.length > 1) el.selectedIndex = (el.selectedIndex + 1) % el.options.length;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else el.click();
          return true;
        }, [c.attr, c.code]).catch(() => false);
        if (!clicked) continue;
        await page.waitForTimeout(350);

        const name = `"${c.label || c.code.slice(0, 40)}"`;
        if (writes.length > before) offenders.push(`${name} sent ${writes.slice(before).map(w => w.method + ' ' + w.table).join(', ')}`);
        const opened = await page.evaluate(ids => ids.filter(id => { const el = document.getElementById(id); return el && el.classList.contains('open'); }), WRITE_WINDOWS).catch(() => []);
        if (opened.length) offenders.push(`${name} opened ${opened.join(', ')}`);
        for (const label of await visibleAdminOnly().catch(() => [])) offenders.push(`${name} revealed admin-only control "${label}"`);
      }

      expect([...new Set(offenders)], `what a viewer could change on "${view}"`).toEqual([]);
      await context.close();
    });
  }
});
