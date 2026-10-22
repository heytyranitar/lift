// Browser tests for Lift. Run with `npm test`.
// First time on a new machine: `npm install && npx playwright install chromium`.
// Each test drives the real index.html in headless Chromium; GitHub is mocked, fonts are blocked.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');

const ROOT = path.join(__dirname, '..');
const APP_FILES = ['index.html', 'sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];
const FILE_URL = 'file://' + path.join(ROOT, 'index.html');

/* ---- tiny harness ---- */
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function eq(got, want, msg) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) throw new Error(`${msg || 'not equal'}\n      got:  ${a}\n      want: ${b}`);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected a truthy value'); }

/* ---- static server that caches like GitHub Pages (max-age=600); the served folder can be swapped ---- */
function serve() {
  let dir = ROOT;
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
  const srv = http.createServer((req, res) => {
    const f = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'max-age=600' });
      res.end(buf);
    });
  });
  return new Promise(r => srv.listen(0, () => r({ url: `http://localhost:${srv.address().port}/`, setDir: d => { dir = d; }, close: () => srv.close() })));
}
// copy of the app into a temp folder, with text replacements applied per file
function siteCopy(edits = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lift-site-'));
  for (const f of APP_FILES) {
    let buf = fs.readFileSync(path.join(ROOT, f));
    if (edits[f]) { let t = buf.toString(); for (const [a, b] of edits[f]) { ok(t.includes(a), `${f} has no "${a}"`); t = t.replace(a, b); } buf = Buffer.from(t); }
    fs.writeFileSync(path.join(d, f), buf);
  }
  return d;
}

/* ---- page helpers ---- */
let browser;
async function open(url = FILE_URL, ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, ...ctxOpts });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const p = await ctx.newPage(), errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(url);
  return { p, ctx, errs };
}
const state = p => p.evaluate(() => JSON.parse(localStorage.getItem('lift.v1')));
// start from the app's own defaults, change them, reload
async function withState(p, fn) {
  await p.click('[data-tab=data]'); // any click saves the defaults
  const s = await state(p); fn(s);
  await p.evaluate(s => localStorage.setItem('lift.v1', JSON.stringify(s)), s);
  await p.reload();
}
const session = (daysAgo, entries, extra = {}) => ({ id: 's' + daysAgo, date: Date.now() - daysAgo * 864e5, tid: 'A', name: 'Workout A', entries, ...extra });
const entry = (exId, name, weight, sets, reps = 5) => ({ exId, name, weight, nSets: sets.length, reps, stage: 0, sets });
const texts = (p, sel) => p.$$eval(sel, els => els.map(e => e.textContent.trim()));

/* ---- tests ---- */
test('imports a pasted backup (needs the text to survive the confirm tap)', async () => {
  const { p, errs } = await open();
  await p.click('[data-tab=data]');
  const s = await state(p); s.settings.rest = 181;
  await p.fill('#imp', JSON.stringify(s));
  await p.click('[data-a=import]'); await p.click('[data-a=import]');
  eq(await p.textContent('.toast'), 'Backup imported.');
  eq((await state(p)).settings.rest, 181);
  await p.click('[data-tab=data]'); await p.fill('#imp', 'not json');
  await p.click('[data-a=import]'); await p.click('[data-a=import]');
  ok((await p.textContent('.toast')).includes('not a valid backup'));
  return errs;
});

test('warm-ups: one empty-bar set, none for deadlifts, off without a bar', async () => {
  const { p, errs } = await open();
  await withState(p, s => { for (const [id, w] of [['squat', 185], ['ohp', 95], ['dl', 225]]) s.ex.find(e => e.id === id).override = w; });
  await p.click('[data-a=start][data-t=B]');
  const chips = i => p.$$eval('.card', (cards, i) => [...cards[i - 1].querySelectorAll('.wset')].map(x => x.firstChild.textContent), i);
  eq(await chips(1), ['45×5', '75×5', '110×3', '150×2'], 'squat 185');
  eq(await chips(2), ['45×5', '55×3', '75×2'], 'press 95');
  eq(await chips(3), ['90×5', '135×3', '180×2'], 'deadlift 225');
  await p.click('[data-a=wset][data-e="0"][data-k="3"]'); // last chip first: the rest waits until every warm-up is done
  for (const k of [0, 1]) await p.click(`[data-a=wset][data-e="0"][data-k="${k}"]`);
  ok(!(await p.isVisible('#rest')), 'no rest timer until the last warm-up is done');
  await p.click('[data-a=wset][data-e="0"][data-k="2"]');
  ok(await p.isVisible('#rest'), 'finishing the warm-ups starts the rest timer');
  await p.click('[data-a=discard]'); await p.click('[data-a=discard]');
  await p.click('[data-a=start][data-t=C]');
  eq(await p.$$eval('.wset', w => w.length), 0, 'curls have no bar weight, so no warm-ups');
  return errs;
});

test('rest timer: normal rest, longer after a miss, survives a reload', async () => {
  const { p, errs } = await open();
  await withState(p, s => { s.settings.rest = 180; s.settings.restFail = 300; });
  await p.click('[data-a=start][data-t=A]');
  await p.click('[data-a=set][data-e="0"][data-s="0"]');
  eq(await p.textContent('#rt'), '3:00');
  await p.click('[data-a=set][data-e="0"][data-s="0"]'); // 5 -> 4 reps: now a miss
  eq(await p.textContent('#rt'), '5:00');
  await p.reload(); await p.waitForTimeout(600);
  ok(await p.isVisible('#rest'), 'rest bar should come back after reload');
  ok(/^(4:5\d|5:00)$/.test(await p.textContent('#rt')), 'remaining time kept');
  return errs;
});

test('workout note: saved as you type, Finish works in one tap, shown in History', async () => {
  const { p, errs } = await open();
  await p.click('[data-a=start][data-t=A]');
  await p.click('[data-a=set][data-e="0"][data-s="0"]');
  await p.fill('#note', 'Knee <b>ok</b>');
  await p.click('[data-a=finish]');
  ok(await p.$('.toast'), 'one tap on Finish should finish');
  eq((await state(p)).sessions.at(-1).note, 'Knee <b>ok</b>');
  await p.click('[data-tab=hist]');
  eq(await p.innerHTML('.snote'), 'Knee &lt;b&gt;ok&lt;/b&gt;', 'note is shown as text');
  return errs;
});

test('deload notice and new-PR message', async () => {
  const { p, errs } = await open();
  await withState(p, s => {
    s.sessions = [session(5, [entry('squat', 'Squat', 175, [5, 5, 5])]),
      session(4, [entry('bench', 'Bench press', 180, [5, 5, 4, 3, 3])]),
      session(3, [entry('bench', 'Bench press', 180, [5, 5, 5, 4, 4])])];
  });
  eq(await texts(p, '.trend'), ['Last try before a 10% deload']);
  await p.click('[data-a=start][data-t=A]');
  await p.click('[data-a=w][data-e="0"][data-d="1"]'); // squat 175 -> 180
  for (let j = 0; j < 3; j++) await p.click(`[data-a=set][data-e="0"][data-s="${j}"]`);
  await p.click('[data-a=finish]');
  eq(await p.textContent('.toast .pr'), 'New PR: Squat 180 lb');
  await p.click('[data-tab=hist]');
  ok((await p.textContent('.stats')).startsWith('Heaviest: '), 'History shows best lifts');
  return errs;
});

test('editing a past workout recalculates progression', async () => {
  const { p, errs } = await open();
  await withState(p, s => { s.sessions = [session(1, [entry('bench', 'Bench press', 180, [5, 5, 5, 5, 4])])]; });
  ok((await texts(p, '.line')).includes('Bench press180 · 5×5'), 'missed rep: stays at 180');
  await p.click('[data-tab=hist]'); await p.click('[data-a=hedit]');
  await p.fill('[data-f=hset][data-e="0"][data-s="4"]', '5');
  await p.click('[data-a=hdone]'); // one tap, straight from the input
  ok(!(await p.$('[data-a=hdone]')), 'edit mode closed');
  await p.click('[data-tab=today]');
  ok((await texts(p, '.line')).includes('Bench press185 · 5×5'), 'all reps now: moves to 185');
  return errs;
});

test('gist backup: connect, back up after a workout, a new phone restores without overwriting', async () => {
  const srv = await serve();
  const gists = {}, calls = [];
  const mockGitHub = async ctx => ctx.route('https://api.github.com/**', async r => {
    const req = r.request(), u = new URL(req.url()), m = req.method();
    calls.push(m + ' ' + u.pathname);
    const H = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    if (req.headers().authorization !== 'Bearer good') return r.fulfill({ status: 401, headers: H, body: '{}' });
    if (m === 'GET' && u.pathname === '/gists') return r.fulfill({ status: 200, headers: H, body: JSON.stringify(Object.values(gists)) });
    if (m === 'POST') {
      const b = JSON.parse(req.postData());
      gists.g1 = { id: 'g1', public: b.public, updated_at: new Date().toISOString(), files: { 'lift-backup.json': { content: b.files['lift-backup.json'].content, truncated: false } } };
      return r.fulfill({ status: 201, headers: H, body: JSON.stringify(gists.g1) });
    }
    const g = gists[u.pathname.split('/')[2]]; if (!g) return r.fulfill({ status: 404, headers: H, body: '{}' });
    if (m === 'PATCH') { g.files['lift-backup.json'].content = JSON.parse(req.postData()).files['lift-backup.json'].content; g.updated_at = new Date().toISOString(); }
    return r.fulfill({ status: 200, headers: H, body: JSON.stringify(g) });
  });
  const phone = async () => { const o = await open(srv.url); await mockGitHub(o.ctx); await o.p.click('[data-tab=data]'); return o; };
  const connect = async (p, token) => { await p.fill('[data-f=gtoken]', token); await p.press('[data-f=gtoken]', 'Tab'); await p.waitForTimeout(500); };
  const gistSessions = () => JSON.parse(gists.g1.files['lift-backup.json'].content).sessions.length;
  const workout = async p => { await p.click('[data-tab=today]'); await p.click('[data-a=start][data-t=C]'); await p.click('[data-a=set][data-e="0"][data-s="0"]'); await p.click('[data-a=finish]'); await p.waitForTimeout(500); };
  try {
    const a = await phone();
    await connect(a.p, 'bad');
    ok((await a.p.textContent('.gstat')).includes('rejected the token'), 'bad token is reported');
    await a.p.click('[data-a=gdisc]'); await a.p.click('[data-a=gdisc]');
    await connect(a.p, 'good');
    eq(gists.g1 && gists.g1.public, false, 'gist created as secret');
    await workout(a.p);
    eq(gistSessions(), 1, 'workout backed up');
    ok((await a.p.textContent('.toast .gstat')).startsWith('Backed up'));
    calls.length = 0;
    await a.p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await a.p.waitForTimeout(300);
    eq(calls, [], 'nothing changed, nothing uploaded');

    const b = await phone();
    await connect(b.p, 'good');
    ok((await b.p.textContent('.gstat')).startsWith('Found an existing backup'));
    await workout(b.p);
    eq(gistSessions(), 1, 'a new phone must not overwrite the backup before restoring');
    await b.p.click('[data-tab=data]'); await b.p.click('[data-a=grestore]'); await b.p.click('[data-a=grestore]'); await b.p.waitForTimeout(500);
    ok((await b.p.textContent('.toast')).startsWith('Restored your backup'));
    eq((await state(b.p)).sessions.length, 1);
    ok(!JSON.stringify(await state(b.p)).includes('good'), 'token never stored in the backup data');
    return [...a.errs, ...b.errs];
  } finally { srv.close(); }
});

test('an update replaces the offline copy despite HTTP caching, and the version label follows', async () => {
  const srv = await serve();
  const v1 = siteCopy({ 'sw.js': [[/const CACHE = '[^']+'/.exec(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'))[0], "const CACHE = 'lift-test-1'"]] });
  const v2 = siteCopy({ 'sw.js': [[/const CACHE = '[^']+'/.exec(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'))[0], "const CACHE = 'lift-test-2'"]], 'index.html': [['<title>Lift</title>', '<title>Lift 2</title>']] });
  try {
    srv.setDir(v1);
    const { p, ctx, errs } = await open(srv.url);
    await p.click('[data-tab=data]');
    await p.waitForFunction(() => document.querySelector('#ver').textContent === 'lift-test-1', null, { timeout: 5000 });
    const again = await ctx.newPage(); await again.goto(srv.url); await again.waitForTimeout(500); // open it again while v1 is in charge
    srv.setDir(v2);
    const q = await ctx.newPage(); q.on('pageerror', e => errs.push(e.message));
    await q.goto(srv.url); await q.waitForTimeout(3000); await q.click('[data-tab=data]');
    eq(await q.title(), 'Lift 2', 'new page on the first open after the update');
    eq(await q.textContent('#ver'), 'lift-test-2');
    const offline = await q.evaluate(async () => {
      const c = await caches.open('lift-test-2'), out = [];
      for (const u of ['./', './index.html']) { const r = await c.match(u); out.push(!!r && (await r.text()).includes('<title>Lift 2</title>')); }
      return out;
    });
    eq(offline, [true, true], 'offline copy of the page is the new version');
    return errs;
  } finally { srv.close(); }
});

test('themes load cleanly; a removed theme falls back to the device setting', async () => {
  const { p, errs } = await open();
  await p.click('[data-tab=data]');
  const themes = await p.$$eval('[data-f=theme] option', o => o.map(x => x.value));
  eq(themes, ['', 'light', 'dark', 'sukuna', 'gojo', 'itachi', 'ultra', 'todoroki']);
  for (const t of themes.filter(Boolean)) {
    await p.selectOption('[data-f=theme]', t);
    eq(await p.evaluate(() => document.documentElement.getAttribute('data-theme')), t);
  }
  await withState(p, s => { s.settings.theme = 'prometheus'; });
  eq(await p.evaluate(() => document.documentElement.getAttribute('data-theme')), null);
  return errs;
});

test('weight sits on the card, not in an input box', async () => {
  const { p, errs } = await open();
  await p.click('[data-a=start][data-t=A]');
  eq(await p.$eval('.wrow input', el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  return errs;
});

/* ---- run ---- */
(async () => {
  browser = await chromium.launch();
  let failed = 0;
  for (const t of tests) {
    try {
      const errs = await t.fn();
      if (errs && errs.length) throw new Error('page errors: ' + errs.join('; '));
      console.log('  ✓ ' + t.name);
    } catch (e) { failed++; console.log('  ✗ ' + t.name + '\n      ' + e.message); }
  }
  await browser.close();
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
