// Logging an Interaction from an Institution's page, and seeing its history (#76).
const { test, expect } = require('@playwright/test');
const { openApp } = require('./support/stubs');

const firstInstitution = page => page.evaluate(() => state.institutions[0].id);
const openInstitution = (page, id) => page.evaluate(i => nav('detail', { instId: i }), id);
const order = writes => writes.map(w => `${w.method} ${w.table}`);

// Two Interactions for the given Institution, and one for another.
const history = inst => ({
  crm_interactions: [
    { id: 'int_old', inst_id: inst, date: '2026-08-01', type: 'email', summary: 'Sent the deck' },
    { id: 'int_new', inst_id: inst, date: '2026-09-15', type: 'call', summary: 'Renewal call' },
    { id: 'int_other', inst_id: 'some-other-institution', date: '2026-09-20', type: 'meeting', summary: 'Not this one' },
  ],
});

// Opens an Institution's page with that history already in the database. The
// Institution's id is read from the page first, so this file is identical in
// every Region's repo.
async function openWithHistory(browser, opts = {}) {
  const baseURL = test.info().project.use.baseURL;
  const probe = await browser.newPage({ baseURL });
  await openApp(probe);
  const inst = await firstInstitution(probe);
  await probe.close();

  const page = await browser.newPage({ baseURL });
  const net = await openApp(page, { ...opts, tables: history(inst) });
  await openInstitution(page, inst);
  return { page, inst, ...net };
}

test.describe('Interactions on the Institution page', () => {
  test('an admin logs an Interaction and sees it listed', async ({ page }) => {
    const { writes, errors } = await openApp(page);
    const inst = await firstInstitution(page);
    await openInstitution(page, inst);

    await page.getByRole('button', { name: 'Log Interaction' }).first().click();
    await expect(page.locator('#modal-int')).toHaveClass(/open/);
    await page.selectOption('#li-type', 'meeting');
    await page.fill('#mi-summary', 'Met the library director');
    await page.locator('#modal-int').getByRole('button', { name: 'Log It' }).click();

    await expect(page.locator('#toast')).toHaveText('Interaction logged');
    await expect(page.locator('#modal-int')).not.toHaveClass(/open/);
    await expect(page.locator('#inst-interactions .int-row')).toHaveCount(1);
    await expect(page.locator('#inst-interactions')).toContainText('Met the library director');

    // The Institution's row is created before the Interaction that points at it.
    const sent = order(writes);
    expect(sent.indexOf('POST crm_institutions')).toBeGreaterThanOrEqual(0);
    expect(sent.indexOf('POST crm_institutions')).toBeLessThan(sent.indexOf('POST crm_interactions'));
    expect(writes.find(w => w.table === 'crm_interactions').body)
      .toMatchObject({ inst_id: inst, type: 'meeting', summary: 'Met the library director' });
    expect(errors).toEqual([]);
  });

  test('existing Interactions are listed newest first, for this Institution only', async ({ browser }) => {
    const { page } = await openWithHistory(browser);
    const rows = page.locator('#inst-interactions .int-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Renewal call');
    await expect(rows.nth(1)).toContainText('Sent the deck');
    await expect(page.locator('#inst-interactions')).not.toContainText('Not this one');
    await page.close();
  });

  test('an admin deletes an Interaction after confirming', async ({ browser }) => {
    const { page, writes } = await openWithHistory(browser);
    let asked = '';
    page.on('dialog', d => { asked = d.message(); d.accept(); });
    await page.locator('#inst-interactions .int-row', { hasText: 'Renewal call' }).getByRole('button').click();
    await expect(page.locator('#inst-interactions .int-row')).toHaveCount(1);
    expect(asked).toMatch(/delete/i);
    expect(order(writes)).toContain('DELETE crm_interactions');
    await page.close();
  });

  test('a viewer sees the history and no way to change it', async ({ browser }) => {
    const { page } = await openWithHistory(browser, { role: 'viewer' });
    await expect(page.locator('#inst-interactions .int-row')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Log Interaction' })).toHaveCount(0);
    await expect(page.locator('#inst-interactions').getByRole('button')).toHaveCount(0);
    await page.close();
  });

  test('a refused save says so and lists nothing', async ({ page }) => {
    await openApp(page, { failWrites: ['crm_interactions'] });
    const inst = await firstInstitution(page);
    await openInstitution(page, inst);
    await page.getByRole('button', { name: 'Log Interaction' }).first().click();
    await page.fill('#mi-summary', 'This will be refused');
    await page.locator('#modal-int').getByRole('button', { name: 'Log It' }).click();

    await expect(page.locator('#toast')).toContainText(/not saved/i);
    await expect(page.locator('#inst-interactions .int-row')).toHaveCount(0);
    expect(await page.evaluate(() => state.interactions.length)).toBe(0);
  });
});
