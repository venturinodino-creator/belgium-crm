# belgium-crm

## Working convention

- **Code changes go through a pull request.** One pull request per ticket, squash-merged, with the smoke check green once it exists here. Do not push code straight to `main`.
- **Scan workflows push data straight to `main`.** They commit their own output under `data/` and must keep working unattended, so `main` is deliberately not protected: protection rules would break every scan.
- **Rebase before merging.** The scans and other sessions push to `main` many times a day, so cut each branch from the current `main` and rebase it before the merge.
- **This repo mirrors `netherlands-crm`.** The Netherlands repo is the reference; `denmark-crm` and `belgium-crm` are near-copies kept in step by hand. Fixes and cleanups land there first and are mirrored here in the same ticket. Region data, Region wording, localised patterns and storage-key prefixes are intentionally different and are never mirrored.
- **Work from a clean worktree.** Another session may have uncommitted work in the main checkout.

## Testing

The smoke check opens every page in a real browser with sign-in and the database stubbed at the network boundary, and fails on any console error.

- First time: `npm install`, then `npx playwright install chromium`.
- Every time: `npm test`. One file or one test: `npx playwright test tests/smoke.spec.js -g "<name>"`.
- Nothing in `index.html` knows it is under test. Keep it that way: stub at the network (`tests/support/stubs.js`), never add a test flag to the page.
- New behaviour and bug fixes start with a failing test at this seam.
