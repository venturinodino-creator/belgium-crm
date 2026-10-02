// `npm run check`: fast, deterministic checks on the page itself. No browser.
// Runs in CI beside the smoke check and should run before every commit.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PAGES = ['index.html', 'landing.html'].filter(f => fs.existsSync(path.join(ROOT, f)));

// Functions that nothing calls and that are kept on purpose. Each needs a
// reason; an entry is a debt, so the list should shrink.
//   syncOpenAlex: the only way into the OpenAlex institution sync window.
//                 Restore or remove is an open decision: netherlands-crm#97.
const KEEP_FUNCTIONS = ['syncOpenAlex'];

const failed = [];
function check(name, fn) {
  let problems;
  try { problems = fn() || []; } catch (e) { problems = ['the check itself threw: ' + e.message]; }
  if (problems.length) { failed.push(name); console.log('FAIL  ' + name); problems.slice(0, 30).forEach(p => console.log('        ' + p)); }
  else console.log('ok    ' + name);
}

const inlineScripts = html => [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter(m => !/type=["']module["']/.test(m[1])).map(m => m[2]);
const styleBlocks = html => [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]);

check('every inline script parses', () => {
  const out = [];
  for (const page of PAGES) inlineScripts(read(page)).forEach((code, i) => {
    try { new vm.Script(code, { filename: `${page} <script ${i + 1}>` }); }
    catch (e) { out.push(`${page} script ${i + 1}: ${e.message}`); }
  });
  return out;
});

check('every stylesheet has balanced braces', () => {
  const out = [];
  for (const page of PAGES) styleBlocks(read(page)).forEach((css, i) => {
    const open = (css.match(/{/g) || []).length, close = (css.match(/}/g) || []).length;
    if (open !== close) out.push(`${page} style block ${i + 1}: ${open} "{" against ${close} "}"`);
  });
  return out;
});

// A script fragment that reaches cmd.exe leaves an empty file named after
// whatever followed a ">". They are harmless until a broad `git add` commits one.
check('no empty file at the repo root', () =>
  fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isFile() && !d.name.startsWith('.') && fs.statSync(path.join(ROOT, d.name)).size === 0)
    .map(d => `"${d.name}" is empty: delete it`));

const python = ['python3', 'python'].find(cmd => {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  return r.status === 0 && /Python 3/.test((r.stdout || '') + (r.stderr || ''));
});
function analyser(script, args) {
  if (!python) return ['Python 3 is not installed, so this check could not run'];
  const r = spawnSync(python, [path.join(__dirname, script), ROOT, ...args], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (r.status === 0) return [];
  return (r.stdout + r.stderr).split('\n').map(l => l.trimEnd()).filter(Boolean);
}

// The check that would have caught Log Interaction, Account Info and Deals
// losing their buttons: a function nothing references is either dead code to
// delete or a feature whose way in went missing.
check('no function is unreferenced', () => analyser('dead-functions.py', KEEP_FUNCTIONS.map(f => '--keep=' + f)));
check('no style class is unused', () => analyser('unused-styles.py', []));

console.log(failed.length ? `\n${failed.length} check(s) failed.` : '\nAll checks passed.');
process.exit(failed.length ? 1 : 0);
