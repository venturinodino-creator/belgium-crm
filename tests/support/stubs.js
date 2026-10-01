// Network-level stand-ins for everything outside the repo, so the shipped page
// runs unmodified: no test flag, hook or branch exists in index.html.
//
//   - the Supabase client library  -> a tiny module reporting a signed-in session
//   - the Supabase REST endpoints  -> canned rows, and a record of every write
//   - third-party images (map tiles, flags) -> a 1x1 PNG
//   - third-party JSON APIs        -> an empty object
//   - data another Region's site serves (/xx-crm/data/...) -> an empty result
//   - the CDN-hosted libraries and fonts the page really needs -> passed through
//
// Nothing here can reach the live database: every request to it is answered
// locally, and `leaks` records any external request that was let through.

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
};

// Hosts whose real responses the page depends on to run at all.
const PASS_THROUGH = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

const SESSION_USER = { id: '00000000-0000-4000-8000-000000000001', email: 'smoke@test.local' };

const supabaseModule = () => `
  const session = { access_token: 'smoke-token', user: ${JSON.stringify(SESSION_USER)} };
  export function createClient() {
    return {
      auth: {
        getSession: async () => ({ data: { session }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signOut: async () => ({ error: null }),
      },
    };
  }
`;

/**
 * @param page   Playwright page
 * @param opts.role    'admin' | 'viewer' — the role the profiles table reports
 * @param opts.tables  rows to return per table name, e.g. { crm_contacts: [...] }
 * @param opts.failWrites  table names whose writes the database refuses (status 500)
 * @returns { writes, leaks } — arrays filled in as the page runs
 */
async function installStubs(page, opts = {}) {
  const role = opts.role || 'admin';
  const tables = opts.tables || {};
  const failWrites = opts.failWrites || [];
  const writes = [];   // { method, table, query, body } for every non-GET to the database
  const leaks = [];    // external URLs that were passed through to the real network

  await page.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const host = url.hostname;

    if (host === '127.0.0.1' || host === 'localhost') {
      // The Denmark and Belgium apps read some shared data from the live
      // Netherlands site by absolute path (/netherlands-crm/data/...). That is
      // right on GitHub Pages and has no answer on a local server, so answer
      // it here with an empty result.
      const shared = url.pathname.match(/^\/[a-z]+-crm\/data\/(.+)$/);
      if (shared) {
        const empty = /battlecard/.test(shared[1]) ? 'null' : '[]';
        return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: empty });
      }
      return route.continue();
    }

    if (host === 'esm.sh' && url.pathname.includes('supabase-js')) {
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/javascript' }, body: supabaseModule() });
    }

    if (host.endsWith('.supabase.co')) {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const rest = url.pathname.match(/^\/rest\/v1\/([^/?]+)/);
      const json = body => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!rest) return json({});
      const table = rest[1];
      if (req.method() === 'GET') {
        if (table === 'profiles') return json([{ role }]);
        return json(tables[table] || []);
      }
      let body = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch (e) { body = req.postData(); }
      writes.push({ method: req.method(), table, query: url.search, body });
      if (failWrites.includes(table)) {
        return route.fulfill({ status: 500, headers: { ...CORS, 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'refused by the stubbed database' }) });
      }
      return json(Array.isArray(body) ? body : body ? [body] : []);
    }

    if (PASS_THROUGH.includes(host)) { leaks.push(req.url()); return route.continue(); }

    if (req.resourceType() === 'image') {
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'image/png' }, body: TINY_PNG });
    }
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: '{}' });
  });

  return { writes, leaks };
}

/** Collects everything the smoke check treats as a failure. */
function watchForErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push('uncaught: ' + (e && e.message ? e.message : String(e))));
  page.on('console', msg => { if (msg.type() === 'error') errors.push('console.error: ' + msg.text()); });
  return errors;
}

/** Opens the app signed in and waits until the first screen has rendered. */
async function openApp(page, opts = {}) {
  const errors = watchForErrors(page);
  const net = await installStubs(page, opts);
  await page.goto('/index.html' + (opts.query || ''));
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    const title = document.getElementById('page-title');
    return ls && getComputedStyle(ls).display === 'none' && title && title.textContent.trim().length > 0;
  }, null, { timeout: 30000 });
  return { errors, ...net };
}

module.exports = { installStubs, watchForErrors, openApp, PASS_THROUGH, SESSION_USER };
