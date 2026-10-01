// Saving a Contact for an Institution that has no database row (#88).
//
// The institutions table is sparse: it holds only Institutions an admin has
// edited. Contacts carry a foreign key to it, so the Institution's row has to
// exist before the Contact is written.
const { test, expect } = require('@playwright/test');
const { openApp } = require('./support/stubs');

// The stubbed database starts with no institution rows at all, so every
// Institution in the page's master list is one "with no database row". The
// ids are read from the page so this file is identical in every Region's repo.
const twoInstitutions = page => page.evaluate(() => state.institutions.slice(0, 2).map(i => i.id));

const order = writes => writes.map(w => `${w.method} ${w.table}`);

test.describe('a Contact can be saved for an Institution with no database row', () => {
  test('adding a Contact by hand creates the Institution row first', async ({ page }) => {
    const { writes, errors } = await openApp(page);
    const [INST] = await twoInstitutions(page);
    await page.evaluate(() => { nav('contacts'); openAddContact(); });
    await page.fill('#mc-first', 'Test');
    await page.fill('#mc-last', 'Person');
    await page.selectOption('#mc-inst', INST);
    await page.evaluate(() => saveContact());
    await expect(page.locator('#toast')).toHaveText('Contact added');

    const sent = order(writes);
    expect(sent).toContain('POST crm_contacts');
    expect(sent.indexOf('POST crm_institutions'), 'the Institution row is written').toBeGreaterThanOrEqual(0);
    expect(sent.indexOf('POST crm_institutions')).toBeLessThan(sent.indexOf('POST crm_contacts'));
    const instWrite = writes.find(w => w.table === 'crm_institutions');
    expect(instWrite.body.id).toBe(INST);
    expect(errors).toEqual([]);
  });

  test('importing Contacts from CSV creates each Institution row once, before its Contacts', async ({ page }) => {
    const { writes, errors } = await openApp(page);
    const [INST, OTHER] = await twoInstitutions(page);
    await page.evaluate(() => syncContacts());
    const csv = [
      'First Name,Last Name,Title,Department,Institution ID,Email',
      `Anna,de Vries,Library Director,Library,${INST},anna@example.nl`,
      `Bram,Jansen,Dean,Science,${INST},bram@example.nl`,
      `Carla,Smit,Rector,Board,${OTHER},carla@example.nl`,
    ].join('\n');
    await page.setInputFiles('#csv-file-input', { name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.locator('#csync-import-btn')).toBeEnabled();
    await page.click('#csync-import-btn');
    await expect.poll(() => writes.filter(w => w.table === 'crm_contacts').length).toBe(3);

    const instWrites = writes.filter(w => w.table === 'crm_institutions').map(w => w.body.id).sort();
    expect(instWrites, 'one Institution row per Institution, not per Contact').toEqual([INST, OTHER].sort());
    const sent = order(writes);
    expect(sent.lastIndexOf('POST crm_institutions')).toBeLessThan(sent.indexOf('POST crm_contacts'));
    expect(errors).toEqual([]);
  });

  test('editing a Contact still saves', async ({ page }) => {
    const { writes } = await openApp(page, { tables: {
      crm_contacts: [{ id: 'c1', inst_id: 'no-such-institution', first: 'Anna', last: 'de Vries', title: 'Library Director', status: 'active', priority: 'high' }],
    } });
    await page.evaluate(() => { nav('contacts'); openEditContact('c1'); });
    await page.fill('#mc-title-f', 'Head of Library');
    await page.evaluate(() => saveContact());
    await expect(page.locator('#toast')).toHaveText('Contact updated');
    const saved = writes.filter(w => w.table === 'crm_contacts').pop();
    expect(saved.body.title).toBe('Head of Library');
  });
});
