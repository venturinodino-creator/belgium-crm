// Smoke check: every page of the CRM opens, signed in, without throwing.
//
// The seam is the rendered page in a real browser with the network stubbed
// (tests/support/stubs.js). Nothing in index.html knows it is under test.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { openApp, PASS_THROUGH } = require('./support/stubs');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// The page's own list of views, read from its render() map so a new page is
// covered the moment it is added.
function viewKeys() {
  const m = SOURCE.match(/function render\(\) \{\s*const views = \{([\s\S]*?)\n\s*\};/);
  if (!m) throw new Error('Could not find the view map in render()');
  return [...m[1].matchAll(/^\s*'?([a-z0-9-]+)'?\s*:/gm)].map(x => x[1]);
}
const VIEWS = viewKeys();

// Views that show one Institution and need its id to render.
const INST_SCOPED = ['detail', 'org-map'];

// Pages that exist but that nothing in the interface can open. Each entry is a
// known bug with a ticket; the list must stay empty unless a new one is filed.
const KNOWN_UNREACHABLE = [];

// Let late async work (data files, counts, map tiles) land before judging.
async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(400);
}

test.describe('every page opens without errors', () => {
  test('the view map was found and is not empty', () => {
    expect(VIEWS.length).toBeGreaterThan(10);
    expect(VIEWS).toContain('dashboard');
  });

  test('signing in lands on the dashboard', async ({ page }) => {
    const { errors } = await openApp(page);
    await settle(page);
    await expect(page.locator('#page-title')).toHaveText('Dashboard');
    expect(errors).toEqual([]);
  });

  for (const view of VIEWS) {
    test(`page "${view}" renders`, async ({ page }) => {
      const { errors } = await openApp(page);
      await page.evaluate(([v, scoped]) => {
        const extra = scoped ? { instId: state.institutions[0].id } : {};
        nav(v, extra);
      }, [view, INST_SCOPED.includes(view)]);
      await settle(page);

      expect(await page.evaluate(() => state.view)).toBe(view);
      expect((await page.locator('#page-title').textContent()).trim()).not.toBe('');
      expect((await page.locator('#content').innerHTML()).trim().length).toBeGreaterThan(0);
      expect(errors, `errors while showing "${view}"`).toEqual([]);
    });
  }
});

test.describe('every page can be reached from the interface', () => {
  test('every sidebar item opens a page that exists', async ({ page }) => {
    const { errors } = await openApp(page);
    const items = await page.locator('.nav-item[data-view]').evaluateAll(els => els.map(e => e.dataset.view));
    expect(items.length).toBeGreaterThan(5);
    for (const view of items) {
      expect(VIEWS, `sidebar item "${view}" has no page`).toContain(view);
      await page.locator(`.nav-item[data-view="${view}"]`).click();
      await settle(page);
      expect(await page.evaluate(() => state.view)).toBe(view);
    }
    expect(errors).toEqual([]);
  });

  test('no page is orphaned', () => {
    // A page is reachable when the source holds a sidebar item for it or a
    // call that navigates to it. The dashboard is where sign-in lands.
    const reachable = v => v === 'dashboard'
      || SOURCE.includes(`data-view="${v}"`)
      || new RegExp(`nav\\(\\\\?['"]${v}\\\\?['"]`).test(SOURCE);
    const orphaned = VIEWS.filter(v => !reachable(v));
    expect(orphaned.sort()).toEqual([...KNOWN_UNREACHABLE].sort());
  });
});

test.describe('the check is safe to run anywhere', () => {
  test('nothing reaches the live database or an unexpected host', async ({ page }) => {
    const { leaks } = await openApp(page);
    await settle(page);
    const hosts = [...new Set(leaks.map(u => new URL(u).hostname))];
    for (const h of hosts) expect(PASS_THROUGH).toContain(h);
    expect(hosts.some(h => h.endsWith('supabase.co'))).toBe(false);
  });

  test('a viewer sees no admin-only controls', async ({ page }) => {
    const { errors } = await openApp(page, { role: 'viewer' });
    await page.evaluate(() => nav('institutions'));
    await settle(page);
    // Name each offender so a failure says which control leaked.
    const visibleAdminControls = await page.locator('[data-admin-only]').evaluateAll(els => els
      .filter(e => getComputedStyle(e).display !== 'none' && e.offsetParent !== null)
      .map(e => (e.textContent.trim() || e.getAttribute('title') || e.id || e.tagName).slice(0, 60)));
    expect(visibleAdminControls).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('an admin still sees the admin-only controls', async ({ page }) => {
    await openApp(page, { role: 'admin' });
    await settle(page);
    // The sidebar's Import Contacts item is the one that leaked to viewers (#84);
    // the fix must not hide it from the people it is for.
    await expect(page.locator('.nav-item[data-admin-only]').first()).toBeVisible();
  });
});
