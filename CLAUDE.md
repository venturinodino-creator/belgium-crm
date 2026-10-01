# belgium-crm

## Working convention

- **Code changes go through a pull request.** One pull request per ticket, squash-merged, with the smoke check green once it exists here. Do not push code straight to `main`.
- **Scan workflows push data straight to `main`.** They commit their own output under `data/` and must keep working unattended, so `main` is deliberately not protected: protection rules would break every scan.
- **Rebase before merging.** The scans and other sessions push to `main` many times a day, so cut each branch from the current `main` and rebase it before the merge.
- **This repo mirrors `netherlands-crm`.** The Netherlands repo is the reference; `denmark-crm` and `belgium-crm` are near-copies kept in step by hand. Fixes and cleanups land there first and are mirrored here in the same ticket. Region data, Region wording, localised patterns and storage-key prefixes are intentionally different and are never mirrored.
- **Work from a clean worktree.** Another session may have uncommitted work in the main checkout.
