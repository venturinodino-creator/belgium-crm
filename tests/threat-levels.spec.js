// A threat level set by hand on LeapSpace Insights is saved to the shared
// database for the Region, not kept in one browser (#108).
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { openApp } = require('./support/stubs');

// The key the browser-only overrides used to live under. Its prefix differs
// per Region, so it is read from the page rather than written here.
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const LEGACY_KEY = SOURCE.match(/'([a-z]{2}_crm_threat_overrides)'/)[1];

const LEVELS = ['high', 'medium', 'low'];
const up = auto => LEVELS.slice(0, LEVELS.indexOf(auto)).shift() || 'medium';
// The LeapSpace competitor feed, controlled here so the page lists the same
// three items in every Region (Denmark and Belgium read the Netherlands site's
// feed, which a test cannot reach). Their computed levels differ: A is high,
// B medium, C low.
const today = new Date().toISOString().slice(0, 10);
const FEED = {
  'leapspace-competitors.json': [
    { id: 'test-item-a', company: 'Acme', product: 'Test Product A', addedDate: today, eventDate: today, elements: ['literatureSearch', 'fundingDiscovery', 'deepResearchReports'], howItCompetes: 'A.' },
    { id: 'test-item-b', company: 'Acme', product: 'Test Product B', addedDate: today, eventDate: today, elements: ['literatureSearch', 'fundingDiscovery'], howItCompetes: 'B.' },
    { id: 'test-item-c', company: 'Acme', product: 'Test Product C', addedDate: '2026-07-15', eventDate: '2026-07-15', elements: ['literatureSearch'], howItCompetes: 'C.' },
  ],
};
const settingsRow = value => ({ region: 'x', key: 'threat_overrides', value });
const overrideSelects = page => page.locator('#content select', { has: page.locator('option[value="auto"]') });

// Opens LeapSpace Insights. The item is the last one the page ranks. opts.dbLevel / opts.legacyLevel: a level
// for it that the database / this browser already holds.
async function openInsights(browser, opts = {}) {
  const baseURL = test.info().project.use.baseURL;
  const probe = await browser.newPage({ baseURL });
  await openApp(probe, { feeds: FEED });
  await probe.evaluate(() => nav('ai-insights'));
  const sel = overrideSelects(probe).last();
  await sel.waitFor();
  const item = await sel.evaluate(el => ({
    id: JSON.parse(/setThreatOverride\((".*?"),/.exec(el.getAttribute('onchange'))[1]),
    auto: el.querySelector('option[value="auto"]').textContent.match(/\((\w+)\)/)[1].toLowerCase(),
  }));
  await probe.close();
  const pick = auto => up(auto);

  const page = await browser.newPage({ baseURL });
  const reads = [];
  page.on('request', r => { if (r.method() === 'GET' && r.url().includes('crm_region_settings')) reads.push(r.url()); });
  const legacyLevel = opts.legacyLevel && (typeof opts.legacyLevel === 'function' ? opts.legacyLevel(item) : opts.legacyLevel);
  if (legacyLevel) {
    await page.addInitScript(([key, blob]) => {
      if (!sessionStorage.getItem('seeded')) { localStorage.setItem(key, JSON.stringify(blob)); sessionStorage.setItem('seeded', '1'); }
    }, [LEGACY_KEY, { [item.id]: legacyLevel }]);
  }
  const dbLevel = opts.dbLevel && (typeof opts.dbLevel === 'function' ? opts.dbLevel(item) : opts.dbLevel);
  const net = await openApp(page, {
    role: opts.role, failWrites: opts.failWrites, feeds: FEED,
    tables: dbLevel ? { crm_region_settings: [settingsRow({ [item.id]: dbLevel })] } : {},
  });
  await page.evaluate(() => nav('ai-insights'));
  // Found by its item, not by position: a new level can re-rank the list.
  const select = page.locator(`#content select[onchange*="${item.id}"]`);
  const settingsWrites = () => net.writes.filter(w => w.table === 'crm_region_settings');
  const legacyLeft = () => page.evaluate(k => localStorage.getItem(k), LEGACY_KEY);
  return { page, item, pick, up, select, dbValue: dbLevel, reads, settingsWrites, legacyLeft, ...net };
}

test.describe('Threat levels on LeapSpace Insights', () => {
  test('a level in the database is shown in place of the computed one', async ({ browser }) => {
    const { page, select, dbValue } = await openInsights(browser, { dbLevel: item => up(item.auto) });
    expect(LEVELS).toContain(dbValue);
    await expect(select).toHaveValue(dbValue);
    await page.close();
  });

  test('an admin\'s change is written to the database before the page shows it', async ({ browser }) => {
    const { page, item, pick, select, settingsWrites, errors } = await openInsights(browser);
    const level = pick(item.auto);
    await select.selectOption(level);

    await expect.poll(() => settingsWrites().length).toBe(1);
    expect(settingsWrites()[0].body).toMatchObject({ key: 'threat_overrides', value: { [item.id]: level } });
    await expect(select).toHaveValue(level);
    expect(errors).toEqual([]);
    await page.close();
  });

  test('choosing Auto removes the override for everyone', async ({ browser }) => {
    const { page, select, settingsWrites } = await openInsights(browser, { dbLevel: i => up(i.auto) });
    await select.selectOption('auto');
    await expect.poll(() => settingsWrites().length).toBe(1);
    expect(settingsWrites()[0].body.value).toEqual({});
    await expect(select).toHaveValue('auto');
    await page.close();
  });

  test('a refused save says so and the level stays as it was', async ({ browser }) => {
    const { page, item, pick, select } = await openInsights(browser, { failWrites: ['crm_region_settings'] });
    await select.selectOption(pick(item.auto));
    await expect(page.locator('#toast')).toContainText(/not saved/i);
    await expect(select).toHaveValue('auto');
    await page.close();
  });

  test('a viewer sees the level and has no control to change it', async ({ browser }) => {
    const { page, select, settingsWrites } = await openInsights(browser, { role: 'viewer', dbLevel: i => up(i.auto) });
    await expect(select).toHaveCount(1);          // it is on the page, just not offered
    await expect(select).toBeHidden();
    await expect(page.locator('#content')).toContainText(/High|Medium|Low/);
    expect(settingsWrites()).toHaveLength(0);
    await page.close();
  });

  test('only this Region\'s levels are read and written', async ({ browser }) => {
    const { page, item, pick, select, reads, settingsWrites } = await openInsights(browser);
    const region = await page.evaluate(() => CRM_REGION);
    await select.selectOption(pick(item.auto));
    await expect.poll(() => settingsWrites().length).toBe(1);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(u => u.includes('region=eq.' + region))).toBe(true);
    expect(settingsWrites()[0].body.region).toBe(region);
    await page.close();
  });

  test('a level kept in this browser is carried into the database once', async ({ browser }) => {
    const { page, item, select, settingsWrites, legacyLeft } = await openInsights(browser, { legacyLevel: i => up(i.auto) });
    await expect.poll(() => settingsWrites().length).toBe(1);
    expect(settingsWrites()[0].body.value).toHaveProperty(item.id);
    await expect.poll(legacyLeft).toBeNull();
    await expect(select).not.toHaveValue('auto');
    await page.close();
  });

  test('a level in the database is never overwritten by one kept in a browser', async ({ browser }) => {
    const { page, item, select, settingsWrites, legacyLeft } = await openInsights(browser, { dbLevel: i => up(i.auto), legacyLevel: i => (up(i.auto) === 'high' ? 'medium' : 'high') });
    await expect.poll(legacyLeft).toBeNull();
    expect(settingsWrites()).toHaveLength(0);
    await expect(select).toHaveValue(up(item.auto));
    await page.close();
  });

  test('a viewer\'s browser carries nothing into the database', async ({ browser }) => {
    const { page, settingsWrites, legacyLeft } = await openInsights(browser, { role: 'viewer', legacyLevel: 'high' });
    await page.waitForTimeout(600);
    expect(settingsWrites()).toHaveLength(0);
    expect(await legacyLeft()).not.toBeNull();
    await page.close();
  });
});
