// CareHours in-browser demo: runs the real server modules against SQLite (WebAssembly) in the page.
// Data is sample-only and stays in this browser. Not for real client information.
import initSqlJs from 'sql.js';
import { setSqlJs } from './shims/sqlite.js';
import { Router } from './shims/express.js';

const DEMO_PASSWORD = 'Demo-Pass-2026';
const STORE = 'carehours-demo-db-v1';

async function boot() {
  const SQL = await initSqlJs({ locateFile: (f) => f });
  setSqlJs(SQL);
  const { openDb } = require('../server/db');
  const { HttpError } = require('../server/lib/util');
  const { createSettings } = require('../server/lib/core');
  const { sessionMiddleware, requireAuth } = require('../server/lib/auth');

  const db = openDb(':memory:');
  let saved = null;
  try { saved = localStorage.getItem(STORE); } catch { /* storage unavailable */ }
  if (saved && !location.search.includes('reset')) {
    db.raw.load(Uint8Array.from(atob(saved), (c) => c.charCodeAt(0)));
    db.cache.clear();
    db.exec('PRAGMA foreign_keys = ON');
  } else {
    const { hashPassword } = require('../server/lib/auth');
    db.insert('users', { username: 'admin', display_name: 'Administrator (demo)', role: 'admin', password_hash: hashPassword(DEMO_PASSWORD), must_change_password: 0 });
    require('../server/seed').seedSample(db, { password: DEMO_PASSWORD });
    if (location.search.includes('reset')) history.replaceState(null, '', location.pathname + location.hash);
  }
  const persist = () => {
    try {
      const bytes = db.raw.export();
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      localStorage.setItem(STORE, btoa(s));
    } catch { /* quota or storage disabled: demo continues in memory */ }
  };
  persist();

  const settings = createSettings(db);
  const ctx = { db, settings, secureCookies: false };
  const api = Router();
  api.use(sessionMiddleware(db, settings));
  api.use(require('../server/routes/auth')(ctx));
  api.get('/health', (req, res) => res.json({ ok: true }));
  api.use(requireAuth);
  const routes = [
    require('../server/routes/users'), require('../server/routes/settings'), require('../server/routes/clients'),
    require('../server/routes/caregivers'), require('../server/routes/schedule'), require('../server/routes/care'),
    require('../server/routes/meds'), require('../server/routes/health'), require('../server/routes/incidents'),
    require('../server/routes/finance'), require('../server/routes/reports'), require('../server/routes/dashboard'),
  ];
  for (const r of routes) api.use(r(ctx));

  let cookie = '';
  try { cookie = sessionStorage.getItem('carehours-demo-cookie') || ''; } catch { /* ignore */ }

  // Same error mapping as server/app.js.
  const toError = (err) => {
    if (err instanceof HttpError) return [err.status, { error: err.message, details: err.details ?? null }];
    if (/constraint failed/i.test(err?.message || '')) return [409, { error: /UNIQUE/.test(err.message) ? 'That record already exists (duplicate ID or name).' : 'The request conflicts with existing data.' }];
    console.error(err);
    return [500, { error: 'Something went wrong in the demo.' }];
  };

  globalThis.__carehoursFetch = async (url, opts = {}) => {
    const u = new URL(url, location.href);
    const method = (opts.method || 'GET').toUpperCase();
    const path = u.pathname.replace(/^.*\/api/, '');
    if (path === '/backup') return new Response(JSON.stringify({ error: 'Database download is not available in the browser demo.' }), { status: 400 });
    const req = {
      method, path, url: path, ip: 'demo', query: Object.fromEntries(u.searchParams),
      body: opts.body ? JSON.parse(opts.body) : {}, headers: { cookie },
      get: (h) => ({ 'x-carehours': '1' })[h.toLowerCase()],
    };
    const out = { status: 200, headers: {}, body: null };
    const res = {
      finished: false,
      status(n) { out.status = n; return res; },
      set(k, v) { if (typeof k === 'object') Object.assign(out.headers, k); else out.headers[k] = v; return res; },
      json(o) { out.body = JSON.stringify(o); out.headers['Content-Type'] = 'application/json'; res.finished = true; return res; },
      send(s) { out.body = s; res.finished = true; return res; },
    };
    await api.handle(req, res, (err) => {
      if (res.finished) return;
      const [st, body] = err ? toError(err) : [404, { error: 'Not found.' }];
      res.status(st).json(body);
    });
    const sc = out.headers['Set-Cookie'];
    if (sc) {
      cookie = /Max-Age=0/.test(sc) ? '' : sc.split(';')[0];
      try { sessionStorage.setItem('carehours-demo-cookie', cookie); } catch { /* ignore */ }
    }
    if (method !== 'GET' || path === '/alerts' || path === '/dashboard') persist();
    return new Response(out.body, { status: out.status, headers: out.headers });
  };

  // Load the normal CareHours frontend.
  const s = document.createElement('script');
  s.type = 'module';
  s.src = 'js/app.js';
  document.body.append(s);
}

boot().catch((e) => {
  document.getElementById('root').innerHTML = `<div class="loading">The demo could not start: ${String(e.message || e)}</div>`;
});
