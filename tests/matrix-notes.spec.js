// Competitor Matrix notes are saved on the Institution in the shared database,
// not in one browser (#106).
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { openApp } = require('./support/stubs');

// The key the browser-only notes used to live under. Its prefix differs per
// Region, so it is read from the page rather than written here.
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const LEGACY_KEY = SOURCE.match(/'([a-z]{2}_crm_matrix_notes)'/)[1];

const NOTE = 'Renewal talks start in March';
const AWKWARD = 'A&B "quoted" <mark-x>note</mark-x>';

// Opens the matrix table and picks an Institution it lists, so this file is
// the same in every Region.
async function pickInstitution(browser) {
  const probe = await browser.newPage({ baseURL: test.info().project.use.baseURL });
  await openApp(probe);
  await probe.evaluate(() => { nav('subscriptions'); cmxSetView('table'); });
  await probe.waitForTimeout(400);
  const inst = await probe.evaluate(() => {
    const text = document.getElementById('content').textContent;
    const x = state.institutions.find(i => i.type === 'university' && text.includes(i.short || i.name));
    return { id: x.id, name: x.name, short: x.short, type: x.type, city: x.city };
  });
  await probe.close();
  return inst;
}

// opts.note: the note already on the Institution's database row.
// opts.legacy: notes held in this browser's storage before the page loads.
async function openMatrix(browser, opts = {}) {
  const inst = await pickInstitution(browser);
  const page = await browser.newPage({ baseURL: test.info().project.use.baseURL });
  if (opts.legacy) {
    await page.addInitScript(([key, id, note]) => {
      if (!sessionStorage.getItem('seeded')) { localStorage.setItem(key, JSON.stringify({ [id]: note })); sessionStorage.setItem('seeded', '1'); }
    }, [LEGACY_KEY, inst.id, opts.legacy]);
  }
  const row = { ...inst };
  if (opts.note !== undefined) row.matrix_note = opts.note;
  const net = await openApp(page, { role: opts.role, failWrites: opts.failWrites, tables: { crm_institutions: opts.noRow ? [] : [row] } });
  await page.evaluate(() => { nav('subscriptions'); cmxSetView('table'); });
  await page.waitForTimeout(400);
  const noteWrites = () => net.writes.filter(w => w.table === 'crm_institutions' && w.body && w.body.id === inst.id && 'matrix_note' in w.body);
  return { page, inst, noteWrites, ...net };
}

const field = (page, inst) => page.locator(`[data-note-for="${inst.id}"]`);

test.describe('Competitor Matrix notes', () => {
  test('a note in the database is shown, as text', async ({ browser }) => {
    const { page, inst, errors } = await openMatrix(browser, { note: AWKWARD });
    await expect(field(page, inst)).toHaveValue(AWKWARD);
    expect(await page.locator('#content mark-x').count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  test('an admin writes a note and it is saved when the field is left', async ({ browser }) => {
    const { page, inst, noteWrites, errors } = await openMatrix(browser, { noRow: true });
    await field(page, inst).fill(NOTE);
    expect(noteWrites()).toHaveLength(0);          // nothing is sent while typing
    await field(page, inst).blur();

    await expect(page.locator('#toast')).toHaveText('Note saved');
    expect(noteWrites()).toHaveLength(1);
    // The write is the Institution's own row, so the row exists once it lands.
    expect(noteWrites()[0].body).toMatchObject({ id: inst.id, name: inst.name, matrix_note: NOTE });

    // It survives the matrix being drawn again and can be searched for.
    await page.evaluate(() => renderSubscriptionMatrix());
    await expect(field(page, inst)).toHaveValue(NOTE);
    expect(errors).toEqual([]);
    await page.close();
  });

  test('clearing a note removes it for everyone', async ({ browser }) => {
    const { page, inst, noteWrites } = await openMatrix(browser, { note: NOTE });
    await field(page, inst).fill('');
    await field(page, inst).blur();
    await expect(page.locator('#toast')).toHaveText('Note cleared');
    expect(noteWrites().pop().body.matrix_note).toBeNull();
    await page.close();
  });

  test('leaving the field unchanged sends nothing', async ({ browser }) => {
    const { page, inst, noteWrites } = await openMatrix(browser, { note: NOTE });
    await field(page, inst).focus();
    await field(page, inst).blur();
    await page.waitForTimeout(300);
    expect(noteWrites()).toHaveLength(0);
    await page.close();
  });

  test('typing in the note does not open the Institution', async ({ browser }) => {
    const { page, inst } = await openMatrix(browser, { note: NOTE });
    await field(page, inst).click();
    await expect(page.locator('#page-title')).toContainText('Competitor Matrix');
    await page.close();
  });

  test('a refused save says so and puts the saved note back', async ({ browser }) => {
    const { page, inst } = await openMatrix(browser, { note: NOTE, failWrites: ['crm_institutions'] });
    await field(page, inst).fill('This will be refused');
    await field(page, inst).blur();

    await expect(page.locator('#toast')).toContainText(/not saved/i);
    await expect(field(page, inst)).toHaveValue(NOTE);
    await page.evaluate(() => renderSubscriptionMatrix());
    await expect(field(page, inst)).toHaveValue(NOTE);
    await page.close();
  });

  test('a viewer reads the note and has no field to edit', async ({ browser }) => {
    const { page, inst, noteWrites } = await openMatrix(browser, { note: AWKWARD, role: 'viewer' });
    await expect(page.locator('#content')).toContainText(AWKWARD);
    await expect(field(page, inst)).toBeHidden();
    expect(await page.locator('#content mark-x').count()).toBe(0);
    expect(noteWrites()).toHaveLength(0);
    await page.close();
  });

  test('a note kept in this browser is carried into the database once', async ({ browser }) => {
    const { page, inst, noteWrites } = await openMatrix(browser, { legacy: NOTE });
    await expect.poll(() => noteWrites().length).toBe(1);
    expect(noteWrites()[0].body.matrix_note).toBe(NOTE);
    await expect(field(page, inst)).toHaveValue(NOTE);
    await expect.poll(() => page.evaluate(k => localStorage.getItem(k), LEGACY_KEY)).toBeNull();
    await page.close();
  });

  test('a note in the database is never overwritten by one kept in a browser', async ({ browser }) => {
    const { page, inst, noteWrites } = await openMatrix(browser, { note: NOTE, legacy: 'An older note from this browser' });
    await page.waitForTimeout(500);
    expect(noteWrites()).toHaveLength(0);
    await expect(field(page, inst)).toHaveValue(NOTE);
    await page.close();
  });

  test('a viewer\'s browser carries nothing into the database', async ({ browser }) => {
    const { page, noteWrites } = await openMatrix(browser, { legacy: NOTE, role: 'viewer' });
    await page.waitForTimeout(500);
    expect(noteWrites()).toHaveLength(0);
    await expect(page.locator('#content')).toContainText(NOTE);
    expect(await page.evaluate(k => localStorage.getItem(k), LEGACY_KEY)).not.toBeNull();
    await page.close();
  });
});
