// The Deals page: reachable from the sidebar, and a Deal can be added, edited
// and deleted (#78).
const { test, expect } = require('@playwright/test');
const { openApp } = require('./support/stubs');

const firstInstitution = page => page.evaluate(() => state.institutions[0].id);
const order = writes => writes.map(w => `${w.method} ${w.table}`);
const today = () => new Date().toISOString().slice(0, 10);

// Opens the Deals page with two Deals already in the database. The
// Institution's id is read from the page first, so this file is the same in
// every Region's repo.
async function openWithDeals(browser, opts = {}) {
  const baseURL = test.info().project.use.baseURL;
  const probe = await browser.newPage({ baseURL });
  await openApp(probe);
  const inst = await firstInstitution(probe);
  await probe.close();

  const page = await browser.newPage({ baseURL });
  const net = await openApp(page, { ...opts, tables: { crm_opportunities: [
    { id: 'opp_a', inst_id: inst, name: 'Pure renewal', stage: 'proposal', value: 42000, close_date: '2026-11-30', notes: '' },
    { id: 'opp_b', inst_id: inst, name: 'SciVal upsell', stage: 'prospect', value: 15000, close_date: today(), notes: '' },
  ] } });
  await page.locator('.nav-item[data-view="pipeline"]').click();
  return { page, inst, ...net };
}

const column = (page, label) => page.locator('.pipeline-col', { has: page.locator('.pipeline-col-header', { hasText: label }) });

test.describe('the Deals page', () => {
  test('sits directly below RFP Opps in the sidebar and is called Deals', async ({ page }) => {
    await openApp(page);
    const labels = await page.locator('.nav-item[data-view]').evaluateAll(els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
    const rfp = labels.findIndex(l => l.startsWith('RFP Opps'));
    expect(rfp).toBeGreaterThanOrEqual(0);
    expect(labels[rfp + 1]).toBe('Deals');

    await page.locator('.nav-item', { hasText: 'Deals' }).click();
    await expect(page.locator('#page-title')).toHaveText('Deals');
    await expect(page.locator('#content')).not.toContainText(/pipeline/i);
  });

  test('an admin adds a Deal and it appears in its stage', async ({ page }) => {
    const { writes, errors } = await openApp(page);
    const inst = await firstInstitution(page);
    await page.locator('.nav-item[data-view="pipeline"]').click();
    await page.getByRole('button', { name: '+ New Deal' }).click();
    await expect(page.locator('#modal-opp')).toHaveClass(/open/);

    await page.fill('#mo-name', 'Scopus renewal 2027');
    await page.selectOption('#mo-inst-id', inst);
    await page.selectOption('#mo-stage', 'negotiation');
    await page.fill('#mo-value', '60000');
    await page.fill('#mo-close', '2027-01-31');
    await page.locator('#modal-opp').getByRole('button', { name: 'Save Deal' }).click();

    await expect(page.locator('#toast')).toHaveText('Deal added');
    await expect(column(page, 'Negotiation')).toContainText('Scopus renewal 2027');
    // The Institution's row is created before the Deal that points at it.
    const sent = order(writes);
    expect(sent.indexOf('POST crm_institutions')).toBeGreaterThanOrEqual(0);
    expect(sent.indexOf('POST crm_institutions')).toBeLessThan(sent.indexOf('POST crm_opportunities'));
    expect(writes.find(w => w.table === 'crm_opportunities').body)
      .toMatchObject({ inst_id: inst, name: 'Scopus renewal 2027', stage: 'negotiation', value: 60000, close_date: '2027-01-31' });
    expect(errors).toEqual([]);
  });

  test('a Deal cannot be saved without an Institution', async ({ page }) => {
    const { writes } = await openApp(page);
    await page.locator('.nav-item[data-view="pipeline"]').click();
    await page.getByRole('button', { name: '+ New Deal' }).click();
    await page.fill('#mo-name', 'No institution chosen');
    await page.locator('#modal-opp').getByRole('button', { name: 'Save Deal' }).click();
    await expect(page.locator('#toast')).toContainText(/institution/i);
    await expect(page.locator('#modal-opp')).toHaveClass(/open/);
    expect(order(writes)).not.toContain('POST crm_opportunities');
  });

  test('an admin edits a Deal and moves it to another stage', async ({ browser }) => {
    const { page, writes } = await openWithDeals(browser);
    await column(page, 'Proposal').locator('.pipeline-card', { hasText: 'Pure renewal' }).click();
    await expect(page.locator('#mo-title')).toHaveText('Edit Deal');
    await expect(page.locator('#mo-name')).toHaveValue('Pure renewal');
    await page.selectOption('#mo-stage', 'closed-won');
    await page.locator('#modal-opp').getByRole('button', { name: 'Save Deal' }).click();
    await expect(page.locator('#toast')).toHaveText('Deal updated');
    await expect(column(page, 'Closed Won')).toContainText('Pure renewal');
    await expect(column(page, 'Proposal')).not.toContainText('Pure renewal');
    expect(writes.filter(w => w.table === 'crm_opportunities').pop().body).toMatchObject({ id: 'opp_a', stage: 'closed-won' });
    await page.close();
  });

  test('an admin deletes a Deal after confirming', async ({ browser }) => {
    const { page, writes } = await openWithDeals(browser);
    let asked = '';
    page.on('dialog', d => { asked = d.message(); d.accept(); });
    await column(page, 'Proposal').locator('.pipeline-card', { hasText: 'Pure renewal' }).click();
    await page.locator('#modal-opp').getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('#toast')).toHaveText('Deal deleted');
    await expect(page.locator('#modal-opp')).not.toHaveClass(/open/);
    await expect(page.locator('.pipeline-card', { hasText: 'Pure renewal' })).toHaveCount(0);
    expect(asked).toMatch(/delete/i);
    expect(order(writes)).toContain('DELETE crm_opportunities');
    await page.close();
  });

  test('a viewer sees Deals and no way to change them', async ({ browser }) => {
    const { page, writes } = await openWithDeals(browser, { role: 'viewer' });
    await expect(page.locator('.pipeline-card')).toHaveCount(2);
    await expect(page.getByRole('button', { name: '+ New Deal' })).toHaveCount(0);
    await expect(page.locator('#content').getByRole('button')).toHaveCount(0);
    await page.locator('.pipeline-card').first().click();
    await expect(page.locator('#modal-opp')).not.toHaveClass(/open/);
    expect(writes).toEqual([]);
    await page.close();
  });

  test('an open Deal whose close date has come round shows on the Daily Digest', async ({ browser }) => {
    const { page } = await openWithDeals(browser);
    await page.evaluate(() => nav('digest'));
    await expect(page.locator('.dgx-sec', { hasText: 'Due today or overdue' })).toContainText('SciVal upsell');
    await page.close();
  });

  test('a refused save says so and adds nothing', async ({ page }) => {
    await openApp(page, { failWrites: ['crm_opportunities'] });
    const inst = await firstInstitution(page);
    await page.locator('.nav-item[data-view="pipeline"]').click();
    await page.getByRole('button', { name: '+ New Deal' }).click();
    await page.fill('#mo-name', 'This will be refused');
    await page.selectOption('#mo-inst-id', inst);
    await page.locator('#modal-opp').getByRole('button', { name: 'Save Deal' }).click();
    await expect(page.locator('#toast')).toContainText(/not saved/i);
    expect(await page.evaluate(() => state.opportunities.length)).toBe(0);
  });
});
