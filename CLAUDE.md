# belgium-crm

## Working convention

- **Code changes go through a pull request.** One pull request per ticket, squash-merged, with the smoke check green. Do not push code straight to `main`.
- **Scan workflows push data straight to `main`.** They commit their own output under `data/` and must keep working unattended, so `main` is deliberately not protected: protection rules would break every scan.
- **Rebase before merging.** The scans and other sessions push to `main` many times a day, so cut each branch from the current `main` and rebase it before the merge.
- **This repo mirrors `netherlands-crm`.** The Netherlands repo is the reference; `denmark-crm` and `belgium-crm` are near-copies kept in step by hand. Fixes and cleanups land there first and are mirrored here in the same ticket. Region data, Region wording, localised patterns and storage-key prefixes are intentionally different and are never mirrored. The routine, and the script that lands all three pull requests together, are in `netherlands-crm`: `docs/agents/mirroring.md` and `scripts/dev/land.sh`. The glossary and the issue tracker for specs and tickets live there too.
- **Work from a clean worktree.** Another session may have uncommitted work in the main checkout.
- **Review against `CODING_STANDARDS.md`.** It holds the judgement rules a check cannot decide; read it when reviewing a diff, not while building.

## Testing

The smoke check opens every page in a real browser with sign-in and the database stubbed at the network boundary, and fails on any console error.

- First time: `npm install`, then `npx playwright install chromium`.
- Every time: `npm test`. One file or one test: `npx playwright test tests/smoke.spec.js -g "<name>"`.
- Nothing in `index.html` knows it is under test. Keep it that way: stub at the network (`tests/support/stubs.js`), never add a test flag to the page.
- New behaviour and bug fixes start with a failing test at this seam.
- Before every commit: `npm run check`. It takes seconds, needs no browser, and fails on a script that does not parse, a function nothing references, an unused style class or an empty file at the repo root. A function kept unreferenced on purpose is listed with its reason in `scripts/check/run.js`.
- Styles live in `styles.css`. Every local stylesheet and script the page loads carries a `?v=` stamp, a hash of the file's content, so a browser never runs a new page against an old file. After editing any of them run `npm run stamp`; the check fails on a stale stamp.
- This Region's seed Institutions, seed Contacts and researched competitor data live in `seed-data.js`, loaded before the page's script. It is Region data, never mirrored. `scripts/extract-crm-data.js` reads it for the daily report, so keep each list a plain literal.

## Database

The three Regions share one Supabase project, `cfhljbexesdrabmadpcc`, split by a `region` column. The page only shows what the database accepted, so when a save is refused, read the table's foreign keys and access rules before changing the page: the Supabase connector answers that read-only (`list_tables`, or a `select` on `pg_policies`). Never write to the database from a session.
