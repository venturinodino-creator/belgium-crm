# Coding standards

Read at review, against the diff. These are the judgement rules: what a linter cannot decide. Anything mechanical lives in `npm run check` or the test suite instead, and is listed at the bottom so a reviewer does not re-check it by eye.

## A save reaches the database before the page

A function that saves writes to the database first and changes what the page shows only once the write has succeeded. When the write is refused, it tells the user it was not saved and leaves the page as it was.

Why: the page used to change first and report success whatever happened. A refused save then looked saved and vanished on reload. The database refuses more often than it seems: a viewer's write, and any row pointing at an Institution that has no row of its own.

Look for: a `toast` announcing success that is not downstream of the awaited write; `state.<list>.push(...)` or an assignment to a record sitting above the `await`; a `catch` that only logs.

## A row that points at an Institution creates the Institution's row first

Contacts, Deals and Interactions carry a foreign key to the institutions table, which is sparse by design. Any save of one awaits `ensureInstitutionRow(instId)` before its own write.

Look for: a new `supaUpsert…` call for a table with an `inst_id` column and no `ensureInstitutionRow` ahead of it.

## Data goes into the page escaped

Text that comes from the database, a scan or a form goes through `esc()` when written into markup, and through `jsStr()` when placed inside an inline handler. Constants defined in the page (labels, colours) are exempt.

Look for: `${x.name}`, `${x.title}`, `${x.city}` and their kind inside a template that builds markup, with no `esc(` around them.

## A control that changes data is admin-only

A button, link or picker that writes, or opens a window that writes, carries `data-admin-only`. A card or row whose click opens an editing window only gets that click when the signed-in role is admin. The stylesheet hides `data-admin-only` for everyone else; nothing else is needed.

`tests/viewer.spec.js` proves this for every control it can reach, so a reviewer's job is the control it cannot: one that only appears in a state the test's data does not produce.

## One word per thing

Use the terms in `GLOSSARY.md` (kept in `netherlands-crm`) in the interface, in tests and in issue titles: Institution, Contact, Interaction, Deal, Tender, White Space target. "Opp", "opportunity" and "pipeline" are not shown to users.

## A change lands in all three repos

`netherlands-crm` is the reference; `denmark-crm` and `belgium-crm` mirror it. A pull request in one is not finished until the same change is verified in the other two. Region data, Region wording, localised patterns and storage-key prefixes are left alone. The routine is `docs/agents/mirroring.md` in `netherlands-crm`. This file is identical in all three repos.

## Already enforced, not reviewed by eye

- Every inline script parses; every stylesheet is balanced; no empty file sits at the repo root; no function is unreferenced; no style class is unused: `npm run check`.
- Every page opens without a console error; every page is reachable from the interface; a viewer can change nothing: `npm test`.
