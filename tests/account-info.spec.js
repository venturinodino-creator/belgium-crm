// Recording an Institution's Account Info from its page (#77).
const { test, expect } = require('@playwright/test');
const { openApp } = require('./support/stubs');

const firstInstitution = page => page.evaluate(() => state.institutions[0].id);
const openInstitution = (page, id) => page.evaluate(i => nav('detail', { instId: i }), id);
const today = () => new Date().toISOString().slice(0, 10);

// Opens an Institution's page with Account Info already on its database row.
// The id is read from the page first, so this file is the same in every
// Region's repo.
async function openWithAccount(browser, opts = {}) {
  const baseURL = test.info().project.use.baseURL;
  const probe = await browser.newPage({ baseURL });
  await openApp(probe);
  const inst = await firstInstitution(probe);
  const seed = await probe.evaluate(i => { const x = state.institutions.find(s => s.id === i); return { name: x.name, short: x.short, type: x.type, city: x.city }; }, inst);
  await probe.close();

  const page = await browser.newPage({ baseURL });
  const net = await openApp(page, { ...opts, tables: { crm_institutions: [{
    id: inst, ...seed, warmth: 'warm', contract_value: 120000, renewal_date: '2026-12-31',
    products: 'Scopus, ScienceDirect', next_action: 'Send renewal proposal', next_action_date: '2026-11-15',
  }] } });
  await openInstitution(page, inst);
  return { page, inst, ...net };
}

test.describe('Account Info on the Institution page', () => {
  test('an admin records Account Info and sees it on the page', async ({ page }) => {
    const { writes, errors } = await openApp(page);
    const inst = await firstInstitution(page);
    await openInstitution(page, inst);

    await page.locator('#inst-account').getByRole('button', { name: /Account Info/ }).click();
    await expect(page.locator('#modal-acct')).toHaveClass(/open/);
    await page.selectOption('#ma-warmth', 'hot');
    await page.fill('#ma-products', 'Scopus, Pure');
    await page.fill('#ma-value', '85000');
    await page.fill('#ma-renewal', '2027-01-31');
    await page.fill('#ma-action', 'Book a demo');
    await page.fill('#ma-action-date', '2026-12-01');
    await page.locator('#modal-acct').getByRole('button', { name: 'Save' }).click();

    await expect(page.locator('#toast')).toHaveText('Account info saved');
    await expect(page.locator('#modal-acct')).not.toHaveClass(/open/);
    const card = page.locator('#inst-account');
    await expect(card).toContainText('Hot');
    await expect(card).toContainText('Scopus, Pure');
    await expect(card).toContainText('€85k');
    await expect(card).toContainText('2027-01-31');
    await expect(card).toContainText('Book a demo');

    const saved = writes.filter(w => w.table === 'crm_institutions').pop();
    expect(saved.body).toMatchObject({
      id: inst, warmth: 'hot', products: 'Scopus, Pure', contract_value: 85000,
      renewal_date: '2027-01-31', next_action: 'Book a demo', next_action_date: '2026-12-01',
    });
    expect(errors).toEqual([]);
  });

  test('the window opens filled with the current values', async ({ browser }) => {
    const { page } = await openWithAccount(browser);
    await expect(page.locator('#inst-account')).toContainText('Warm');
    await expect(page.locator('#inst-account')).toContainText('€120k');
    await page.locator('#inst-account').getByRole('button', { name: /Account Info/ }).click();
    await expect(page.locator('#ma-warmth')).toHaveValue('warm');
    await expect(page.locator('#ma-products')).toHaveValue('Scopus, ScienceDirect');
    await expect(page.locator('#ma-value')).toHaveValue('120000');
    await expect(page.locator('#ma-renewal')).toHaveValue('2026-12-31');
    await expect(page.locator('#ma-action')).toHaveValue('Send renewal proposal');
    await expect(page.locator('#ma-action-date')).toHaveValue('2026-11-15');
    await page.close();
  });

  test('a next action that has come due shows on the Daily Digest', async ({ page }) => {
    await openApp(page);
    const inst = await firstInstitution(page);
    await openInstitution(page, inst);
    await page.locator('#inst-account').getByRole('button', { name: /Account Info/ }).click();
    await page.fill('#ma-action', 'Call the library director');
    await page.fill('#ma-action-date', today());
    await page.locator('#modal-acct').getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#toast')).toHaveText('Account info saved');

    await page.evaluate(() => nav('digest'));
    await expect(page.locator('.dgx-sec', { hasText: 'Due today or overdue' })).toContainText('Call the library director');
  });

  test('a viewer sees the Account Info and no way to change it', async ({ browser }) => {
    const { page } = await openWithAccount(browser, { role: 'viewer' });
    await expect(page.locator('#inst-account')).toContainText('Send renewal proposal');
    await expect(page.locator('#inst-account').getByRole('button')).toHaveCount(0);
    await page.close();
  });

  test('a refused save says so and changes nothing on the page', async ({ browser }) => {
    const { page } = await openWithAccount(browser, { failWrites: ['crm_institutions'] });
    await page.locator('#inst-account').getByRole('button', { name: /Account Info/ }).click();
    await page.fill('#ma-action', 'This will be refused');
    await page.locator('#modal-acct').getByRole('button', { name: 'Save' }).click();

    await expect(page.locator('#toast')).toContainText(/not saved/i);
    await expect(page.locator('#inst-account')).toContainText('Send renewal proposal');
    await expect(page.locator('#inst-account')).not.toContainText('This will be refused');
    await page.close();
  });
});
