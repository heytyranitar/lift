# Lift

Personal workout logger (replacement for StrongLifts). Installable PWA, works offline, data stays on the device.
Everything is in `index.html` (markup, styles, app code) plus `sw.js` (offline support). There is no build step.

## Features
- **Workouts** from templates (A/B alternate as "Up next"), with a weight stepper, per-side plate list and tappable sets.
- **Progression** recalculated from history every time: linear (add weight on success, 10% deload after 3 missed sessions at the same weight), double progression (climb rep steps, then add weight), or hold. Today shows when a deload is coming.
- **Warm-ups** generated from the work weight: empty bar ×5, then about 40/60/80% for 5/3/2 reps. Exercises with "deadlift" in the name skip the empty bar. Per exercise: Auto or Off (default Auto when the exercise has a bar weight).
- **Rest timer** that beeps 10 s before and at the end, keeps the screen on, survives the app being closed, and switches to a longer rest after a missed set.
- **History** with a weight chart, heaviest weight and estimated 1RM (Epley), editable past workouts, and a note per workout. New PRs are called out when a workout is saved.
- **Themes**: match device, light, dark, Sukuna, Gojo, Itachi.

## Backup
- **Auto backup to a GitHub Gist.** Create a classic token with only the `gist` scope (GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)) and paste it under Settings → Auto backup. The app writes a secret gist named `lift-backup.json` after each workout and when you leave the app with unsaved changes; failures retry later. Secret gists are unlisted, not private.
- **Restore** on a new phone: paste the same token, then Restore from Gist. A fresh install that finds an existing backup never overwrites it until you restore or tap Back up now.
- The token is stored on the phone under its own key (`lift.gist`) and is never included in exports or the gist.
- **Manual:** Export (copy text or save a file) and Import (paste) on the Settings tab.

Data lives in `localStorage` under `lift.v1`. The in-progress workout (`active`) is left out of backups.

## Updating
After changing any file, bump `CACHE` in `sw.js` (e.g. `lift-v21`) so installed copies refresh. The number is shown at the bottom of the Settings tab. Open pages reload themselves when the new version takes over, unless a workout is in progress.

## Adding a theme
1. Add a `:root[data-theme="name"]{...}` block in `index.html` that sets every colour variable (`--bg`, `--surface`, `--ink`, `--muted`, `--line`, `--accent`, `--accent-ink`, `--ok`, `--ok-ink`, `--miss`, `--soft`, `color-scheme`) and optionally `--head` for the heading font.
2. If it uses a Google Font, add it to `THEME_FONT` (loaded only when the theme is picked), and add the name to `THEMES`.
3. Add an `<option>` to the Theme select in `vData()`.
4. Optional: a `.set.fresh::after` animation inside the `prefers-reduced-motion:no-preference` block plays on the set just completed.

## Tests
```
npm install
npx playwright install chromium   # first time only
npm test
```
`tests/run.js` drives the real app in headless Chromium: import, warm-ups, rest timer, notes, deloads and PRs, history editing, Gist backup and restore (GitHub mocked), service-worker updates under HTTP caching, and themes.
