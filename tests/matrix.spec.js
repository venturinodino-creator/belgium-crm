// The Competitor Matrix shows an Institution's name and city character for
// character, never as markup (#89).
const { test, expect } = require('@playwright/test');
const { openApp } = require('./support/stubs');

// Text that would become elements if it were written into the page unescaped.
const SHORT = 'A&B <mark-x>short</mark-x>';
const CITY = "O'Brien <mark-x>city</mark-x>";

// Opens the matrix with one of its Institutions renamed, through the same
// database row an admin's edit would produce. The Institution is picked from
// what the matrix actually lists, so this file is the same in every Region.
async function openMatrixWithAwkwardName(browser) {
  const baseURL = test.info().project.use.baseURL;
  const probe = await browser.newPage({ baseURL });
  await openApp(probe);
  await probe.evaluate(() => nav('subscriptions'));
  await probe.waitForTimeout(400);
  const inst = await probe.evaluate(() => {
    const text = document.getElementById('content').textContent;
    const x = state.institutions.find(i => i.type === 'university' && text.includes(i.short || i.name));
    return { id: x.id, name: x.name, type: x.type };
  });
  await probe.close();

  const page = await browser.newPage({ baseURL });
  const net = await openApp(page, { tables: { crm_institutions: [{ ...inst, short: SHORT, city: CITY }] } });
  await page.evaluate(() => nav('subscriptions'));
  await page.waitForTimeout(400);
  return { page, ...net };
}

for (const view of ['table', 'cards']) {
  test(`the ${view} view shows an awkward name and city as text`, async ({ browser }) => {
    const { page, errors } = await openMatrixWithAwkwardName(browser);
    await page.evaluate(v => cmxSetView(v), view);
    await page.waitForTimeout(300);

    const content = page.locator('#content');
    await expect(content).toContainText(SHORT);
    await expect(content).toContainText(CITY);
    // Nothing in the name or city was turned into an element.
    expect(await page.locator('#content mark-x').count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });
}
