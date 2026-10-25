# Working on Lift

## Pushing
- Push every finished change straight to `main`; no pull request and no need to ask first. If you work on another branch, fast-forward `main` to it.
- Before pushing: run `npm test` (all must pass) and bump `CACHE` in `sw.js` so installed copies update.
- Never force-push `main`. If it can't be fast-forwarded (someone else pushed), stop and ask.
