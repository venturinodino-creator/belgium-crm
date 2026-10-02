// What an admin enters in the Edit Institution window is saved on the
// Institution in the shared database, database first (#107).
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { openApp } = require('./support/stubs');

// The key the browser-only competitor details used to live under. Its prefix
// differs per Region, so it is read from the page rather than written here.
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const LEGACY_KEY = SOURCE.match(/'([a-z]{2}_crm_comp_data)'/)[1];

const other = (current, a, b) => (current === a ? b : a);

// Opens the app with an Institution's database row as given. The Institution
// is the first one the page lists, so this file is the same in every Region.
// opts.row: extra columns on its row; opts.noRow: no row at all;
// opts.legacy: (inst) => the blob this browser held before the page loads.
async function openApp107(browser, opts = {}) {
  const baseURL = test.info().project.use.baseURL;
  const probe = await browser.newPage({ baseURL });
  await openApp(probe);
  const probed = await probe.evaluate(() => {
    const x = state.institutions[0];
    return { id: x.id, name: x.name, short: x.short, type: x.type, city: x.city, pure: getProductStatus(x.id, 'pure') };
  });
  await probe.close();
  const { pure, ...inst } = probed;

  const page = await browser.newPage({ baseURL });
  if (opts.legacy) {
    await page.addInitScript(([key, blob]) => {
      if (!sessionStorage.getItem('seeded')) { localStorage.setItem(key, JSON.stringify(blob)); sessionStorage.setItem('seeded', '1'); }
    }, [LEGACY_KEY, { [inst.id]: opts.legacy({ ...inst, pure }) }]);
  }
  const net = await openApp(page, {
    role: opts.role, failWrites: opts.failWrites,
    tables: { crm_institutions: opts.noRow ? [] : [{ ...inst, ...opts.row }] },
  });
  const instWrites = () => net.writes.filter(w => w.table === 'crm_institutions' && w.body && w.body.id === inst.id);
  const legacyLeft = () => page.evaluate(k => localStorage.getItem(k), LEGACY_KEY);
  return { page, inst, pure, instWrites, legacyLeft, ...net };
}

const openWindow = async (page, id) => {
  await page.evaluate(i => openEditInstitution(i), id);
  await expect(page.locator('#modal-inst')).toHaveClass(/open/);
};
const save = page => page.locator('#modal-inst').getByRole('button', { name: 'Save' }).click();

test.describe('Competitor details in the Edit Institution window', () => {
  test('details in the database fill the window', async ({ browser }) => {
    const { page, inst } = await openApp107(browser, {
      row: { competitor_details: { scopusRenewal: 'Mar 2032', openalexFee: '$1,234/yr', openalex: 'direct', openalexTier: 'Direct' } },
    });
    await openWindow(page, inst.id);
    await expect(page.locator('#mi-scopus-renewal')).toHaveValue('Mar 2032');
    await expect(page.locator('#mi-openalex-fee')).toHaveValue('$1,234/yr');
    await expect(page.locator('#mi-openalex')).toHaveValue('direct');
    await page.close();
  });

  test('a status in the database is the one the window shows', async ({ browser }) => {
    const { page, pure } = await openApp107(browser, {});
    const chosen = other(pure, 'no', 'yes');
    await page.close();
    const again = await openApp107(browser, { row: { product_status: { pure: chosen } } });
    await openWindow(again.page, again.inst.id);
    await expect(again.page.locator('#mi-pure')).toHaveValue(chosen);
    await again.page.close();
  });

  test('an admin saves details and they are written on the Institution', async ({ browser }) => {
    const { page, inst, instWrites, errors } = await openApp107(browser);
    await openWindow(page, inst.id);
    const tier = other(await page.inputValue('#mi-openalex'), 'direct', 'member');
    await page.fill('#mi-scopus-renewal', 'Jun 2031');
    await page.fill('#mi-openalex-fee', '$9,999/yr');
    await page.selectOption('#mi-openalex', tier);
    await save(page);

    await expect(page.locator('#toast')).toContainText('Institution updated');
    await expect(page.locator('#modal-inst')).not.toHaveClass(/open/);
    const body = instWrites().pop().body;
    // Only what differs from what the page already knew is kept on the row.
    expect(body.competitor_details).toEqual({
      scopusRenewal: 'Jun 2031', openalexFee: '$9,999/yr',
      openalex: tier, openalexTier: tier.charAt(0).toUpperCase() + tier.slice(1),
    });

    await openWindow(page, inst.id);
    await expect(page.locator('#mi-scopus-renewal')).toHaveValue('Jun 2031');
    await expect(page.locator('#mi-openalex-fee')).toHaveValue('$9,999/yr');
    await expect(page.locator('#mi-openalex')).toHaveValue(tier);
    expect(errors).toEqual([]);
    await page.close();
  });

  test('a status chosen in the window is the Product status everywhere', async ({ browser }) => {
    const { page, inst, pure, instWrites } = await openApp107(browser);
    const chosen = other(pure, 'no', 'yes');
    await openWindow(page, inst.id);
    await page.selectOption('#mi-pure', chosen);
    await save(page);

    await expect(page.locator('#toast')).toContainText('Institution updated');
    expect(instWrites().pop().body.product_status).toMatchObject({ pure: chosen });
    // The White Space page and the Competitor Matrix read this same value.
    expect(await page.evaluate(i => getProductStatus(i, 'pure'), inst.id)).toBe(chosen);
    await page.close();
  });

  test('saving without touching the competitor fields keeps nothing hand-set', async ({ browser }) => {
    const { page, inst, instWrites } = await openApp107(browser);
    await openWindow(page, inst.id);
    await save(page);
    await expect(page.locator('#toast')).toContainText('Institution updated');
    const body = instWrites().pop().body;
    expect(body.competitor_details).toBeNull();
    expect(body.product_status).toEqual({});
    await page.close();
  });

  test('a refused save says so and leaves the window and the page as they were', async ({ browser }) => {
    const { page, inst } = await openApp107(browser, {
      row: { competitor_details: { scopusRenewal: 'Mar 2032' } }, failWrites: ['crm_institutions'],
    });
    await openWindow(page, inst.id);
    await page.fill('#mi-scopus-renewal', 'Nov 2040');
    await save(page);

    await expect(page.locator('#toast')).toContainText(/not saved/i);
    await expect(page.locator('#modal-inst')).toHaveClass(/open/);   // still there to retry
    await page.evaluate(() => closeModal('modal-inst'));
    await openWindow(page, inst.id);
    await expect(page.locator('#mi-scopus-renewal')).toHaveValue('Mar 2032');
    await page.close();
  });

  test('adding an Institution writes it to the database before it is listed', async ({ browser }) => {
    const { page, writes, errors } = await openApp107(browser);
    await page.evaluate(() => openAddInstitution());
    await page.fill('#mi-name', 'Test Institute of Delft');
    await page.fill('#mi-city', 'Delft');
    await save(page);

    await expect(page.locator('#toast')).toContainText('Institution added');
    expect(writes.some(w => w.table === 'crm_institutions' && w.body && w.body.name === 'Test Institute of Delft')).toBe(true);
    await page.evaluate(() => nav('institutions'));
    await expect(page.locator('#content')).toContainText('Test Institute of Delft');
    expect(errors).toEqual([]);
    await page.close();
  });

  test('a refused add says so and lists nothing', async ({ browser }) => {
    const { page } = await openApp107(browser, { failWrites: ['crm_institutions'] });
    await page.evaluate(() => openAddInstitution());
    await page.fill('#mi-name', 'Test Institute of Delft');
    await page.fill('#mi-city', 'Delft');
    await save(page);

    await expect(page.locator('#toast')).toContainText(/not saved/i);
    await page.evaluate(() => { closeModal('modal-inst'); nav('institutions'); });
    await expect(page.locator('#content')).not.toContainText('Test Institute of Delft');
    await page.close();
  });

  test('details and a status kept in this browser are carried into the database once', async ({ browser }) => {
    let chosen;
    const { page, inst, instWrites, legacyLeft } = await openApp107(browser, {
      legacy: i => { chosen = other(i.pure, 'no', 'yes'); return { scopusRenewal: 'Mar 2030', openalexFee: '$1/yr', pure: chosen }; },
    });
    await expect.poll(() => instWrites().length).toBe(1);
    const body = instWrites()[0].body;
    expect(body.competitor_details).toEqual({ scopusRenewal: 'Mar 2030', openalexFee: '$1/yr' });
    expect(body.product_status).toMatchObject({ pure: chosen });
    await expect.poll(legacyLeft).toBeNull();
    await openWindow(page, inst.id);
    await expect(page.locator('#mi-scopus-renewal')).toHaveValue('Mar 2030');
    await page.close();
  });

  test('a value in the database is never overwritten by one kept in a browser', async ({ browser }) => {
    const { page, inst, instWrites, legacyLeft } = await openApp107(browser, {
      row: { competitor_details: { scopusRenewal: 'Jan 2029' } },
      legacy: () => ({ scopusRenewal: 'Mar 2030' }),
    });
    await expect.poll(legacyLeft).toBeNull();
    expect(instWrites()).toHaveLength(0);
    await openWindow(page, inst.id);
    await expect(page.locator('#mi-scopus-renewal')).toHaveValue('Jan 2029');
    await page.close();
  });

  test('a viewer\'s browser carries nothing into the database', async ({ browser }) => {
    const { page, instWrites, legacyLeft } = await openApp107(browser, {
      role: 'viewer', legacy: () => ({ scopusRenewal: 'Mar 2030' }),
    });
    await page.waitForTimeout(600);
    expect(instWrites()).toHaveLength(0);
    expect(await legacyLeft()).not.toBeNull();
    await page.close();
  });
});
