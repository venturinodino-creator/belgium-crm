// Version stamps for the local files a page loads.
//
//   npm run stamp           rewrite every stamp to match its file
//   npm run check           fails when a stamp is missing, stale, or its file is gone
//
// GitHub Pages lets a browser keep a stylesheet or script for a while. A
// reference like  styles.css?v=1a2b3c4d  changes whenever the file's content
// does, so a browser can never run a new page against an old file. The stamp
// is a hash of the content with line endings normalised, so a Windows checkout
// and the CI checkout agree.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGES = ['index.html', 'landing.html'];

// A local reference: a stylesheet <link> or a <script src> that is not a URL.
const REF = /(<(?:link|script)\b[^>]*?\b(?:href|src)=")([^"#?]+\.(?:css|js))(?:\?v=([^"]*))?(")/g;
const isLocal = ref => !/^([a-z][a-z0-9+.-]*:)?\/\//i.test(ref) && !ref.startsWith('data:');

function stampOf(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
}

// Every local reference in a page: { ref, stamp (as written, or null), file }.
function references(page) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  return [...html.matchAll(REF)].filter(m => isLocal(m[2]))
    .map(m => ({ ref: m[2], stamp: m[3] === undefined ? null : m[3], file: path.join(ROOT, m[2]) }));
}

// The local stylesheets the pages load, for the checks that read CSS.
function localStylesheets() {
  const out = new Set();
  for (const page of PAGES.filter(p => fs.existsSync(path.join(ROOT, p)))) {
    for (const r of references(page)) if (r.ref.endsWith('.css') && fs.existsSync(r.file)) out.add(r.file);
  }
  return [...out];
}

function problems() {
  const out = [];
  for (const page of PAGES.filter(p => fs.existsSync(path.join(ROOT, p)))) {
    for (const r of references(page)) {
      if (!fs.existsSync(r.file)) { out.push(`${page} loads ${r.ref}, which does not exist`); continue; }
      const want = stampOf(r.file);
      if (r.stamp === null) out.push(`${page}: ${r.ref} has no version stamp (run: npm run stamp)`);
      else if (r.stamp !== want) out.push(`${page}: ${r.ref}?v=${r.stamp} is stale, the file is now ${want} (run: npm run stamp)`);
    }
  }
  return out;
}

function rewrite() {
  const changed = [];
  for (const page of PAGES.filter(p => fs.existsSync(path.join(ROOT, p)))) {
    const pagePath = path.join(ROOT, page);
    const html = fs.readFileSync(pagePath, 'utf8');
    const next = html.replace(REF, (all, head, ref, stamp, tail) => {
      if (!isLocal(ref)) return all;
      const file = path.join(ROOT, ref);
      if (!fs.existsSync(file)) return all;
      const want = stampOf(file);
      if (stamp !== want) changed.push(`${page}: ${ref} -> ?v=${want}`);
      return `${head}${ref}?v=${want}${tail}`;
    });
    if (next !== html) fs.writeFileSync(pagePath, next);
  }
  return changed;
}

module.exports = { stampOf, references, localStylesheets, problems, rewrite };

if (require.main === module) {
  const changed = rewrite();
  console.log(changed.length ? changed.join('\n') : 'every stamp is already current');
  const left = problems();
  if (left.length) { console.log(left.join('\n')); process.exit(1); }
}
