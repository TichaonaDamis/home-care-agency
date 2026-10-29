import { api, setAuthHandler } from './api.js';
import { esc, $, toast, showError, onSubmit, fields, loading } from './ui.js';

// ---------- state ----------
const state = { me: null, perms: new Set(), lookups: null, notifTimer: null };
export const ctx = {
  get me() { return state.me; },
  can: (...p) => p.some((x) => state.perms.has(x)),
  isCaregiver: () => state.me?.user.role === 'caregiver',
  today: () => state.me?.today,
  async lookups(force = false) {
    if (!state.lookups || force) state.lookups = await api.get('/settings');
    return state.lookups;
  },
  refreshNotifications: () => loadNotifications(),
};

// ---------- routes ----------
const STAFF_NAV = [
  ['dashboard', 'Dashboard', '◧', null],
  ['clients', 'Clients', '♥', 'clients.view'],
  ['caregivers', 'Caregivers', '☺', 'caregivers.view'],
  ['schedule', 'Assignments & Scheduling', '▦', 'schedule.view'],
  ['care-logs', 'Daily Care Logs', '✎', 'care.view'],
  ['medications', 'Medication Management', '℞', 'meds.view'],
  ['health', 'Health Monitoring', '♡', 'health.view'],
  ['incidents', 'Incidents & Alerts', '⚠', 'alerts.manage', 'incidents.manage'],
  ['reports', 'Reports & Analytics', '▤', 'reports.operations', 'reports.clinical', 'reports.financial'],
  ['finance', 'Payroll & Billing', '$', 'finance.view'],
  ['settings', 'Settings', '⚙', 'settings.manage', 'users.manage', 'audit.view'],
];
const CG_NAV = [
  ['my', 'My Dashboard', '◧'],
  ['my/timesheet', 'My Timesheet', '◷'],
  ['my/incident', 'Report an Incident', '⚠'],
  ['my/profile', 'My Profile', '☺'],
];
const PAGES = {
  dashboard: () => import('./pages/dashboard.js'),
  clients: () => import('./pages/clients.js'),
  caregivers: () => import('./pages/caregivers.js'),
  schedule: () => import('./pages/schedule.js'),
  'care-logs': () => import('./pages/carelogs.js'),
  medications: () => import('./pages/medications.js'),
  health: () => import('./pages/health.js'),
  incidents: () => import('./pages/incidents.js'),
  reports: () => import('./pages/reports.js'),
  finance: () => import('./pages/finance.js'),
  settings: () => import('./pages/settings.js'),
  my: () => import('./pages/portal.js'),
  account: () => import('./pages/account.js'),
};

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, q = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  return { parts, query: Object.fromEntries(new URLSearchParams(q)) };
}

// ---------- boot ----------
async function boot() {
  setAuthHandler((err) => {
    if (err.details?.code === 'PASSWORD_CHANGE_REQUIRED') return renderChangePassword(true);
    state.me = null;
    renderLogin(err.message);
  });
  try {
    await loadMe();
  } catch {
    return renderLogin();
  }
  if (state.me.user.must_change_password) return renderChangePassword(true);
  renderShell();
}

async function loadMe() {
  state.me = await api.get('/auth/me');
  state.perms = new Set(state.me.permissions);
  document.title = state.me.agency_name || 'CareHours';
}

// ---------- auth screens ----------
function brand() {
  return `<div class="brand"><span class="logo" aria-hidden="true">♥</span><span>${esc(state.me?.agency_name || 'CareHours')}<small>Care management</small></span></div>`;
}

function renderLogin(message = '') {
  clearInterval(state.notifTimer);
  $('#root').innerHTML = `<div class="auth-wrap"><main class="auth-card">
    ${brand()}
    <h1>Sign in</h1>
    ${message && !/sign in\.?$/i.test(message) ? `<div class="notice warn">${esc(message)}</div>` : ''}
    <form class="form" id="login" autocomplete="on">
      ${fields([{ name: 'username', label: 'Username', required: true }, { name: 'password', label: 'Password', type: 'password', required: true }])}
      <button class="btn primary big" type="submit">Sign in</button>
    </form>
    <p class="hint">Accounts are created by your administrator. For help signing in, contact your office.</p>
  </main></div>`;
  const form = $('#login');
  form.querySelector('[name=username]').setAttribute('autocomplete', 'username');
  form.querySelector('[name=password]').setAttribute('autocomplete', 'current-password');
  onSubmit(form, async (v) => {
    const r = await api.post('/auth/login', v);
    await loadMe();
    if (r.must_change_password) return renderChangePassword(true);
    if (!location.hash || location.hash === '#/') location.hash = ctx.isCaregiver() ? '#/my' : '#/dashboard';
    renderShell();
  });
}

function renderChangePassword(forced) {
  $('#root').innerHTML = `<div class="auth-wrap"><main class="auth-card">${brand()}
    <h1>Set a new password</h1>
    <p class="hint">${forced ? 'You must choose a new password before continuing. ' : ''}Use at least 10 characters with letters and numbers or symbols.</p>
    <form class="form" id="cpw">${fields([
    { name: 'current_password', label: 'Current (temporary) password', type: 'password', required: true },
    { name: 'new_password', label: 'New password', type: 'password', required: true },
    { name: 'confirm', label: 'Confirm new password', type: 'password', required: true },
  ])}<button class="btn primary big" type="submit">Save password</button>
    <button class="btn ghost" type="button" id="cpw-out">Sign out</button></form></main></div>`;
  onSubmit($('#cpw'), async (v) => {
    if (v.new_password !== v.confirm) throw Object.assign(new Error('Passwords do not match.'), { details: { confirm: 'Does not match' } });
    await api.post('/auth/change-password', { current_password: v.current_password, new_password: v.new_password });
    toast('Password updated.', 'ok');
    await loadMe();
    location.hash = ctx.isCaregiver() ? '#/my' : '#/dashboard';
    renderShell();
  });
  $('#cpw-out').addEventListener('click', logout);
}

async function logout() {
  try { await api.post('/auth/logout'); } catch { /* ignore */ }
  state.me = null;
  state.lookups = null;
  location.hash = '';
  renderLogin();
}

// ---------- shell ----------
function navItems() {
  if (ctx.isCaregiver()) return CG_NAV.map(([k, l, i]) => [k, l, i]);
  return STAFF_NAV.filter(([, , , ...perms]) => !perms[0] || ctx.can(...perms)).map(([k, l, i]) => [k, l, i]);
}

function renderShell() {
  const u = state.me.user;
  const initials = u.display_name.split(/\s+/).map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  $('#root').innerHTML = `<div class="shell">
    <aside class="sidebar" id="sidebar" aria-label="Main navigation">
      ${brand()}
      <nav class="nav" id="nav">${navItems().map(([k, l, i]) => `<a href="#/${k}" data-nav="${k}"><span class="ico" aria-hidden="true">${i}</span>${esc(l)}</a>`).join('')}</nav>
      <div class="nav-section">Account</div>
      <nav class="nav"><a href="#/account"><span class="ico" aria-hidden="true">🔑</span>Change password</a><a href="#" id="logout"><span class="ico" aria-hidden="true">⏻</span>Sign out</a></nav>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn menu-btn" id="menu" aria-label="Open menu">☰</button>
        <div class="search" role="search">
          <span class="ico" aria-hidden="true">⌕</span>
          <label class="sr-only" for="gsearch">Search</label>
          <input id="gsearch" type="search" placeholder="${ctx.isCaregiver() ? 'Search my clients' : 'Search clients, caregivers, invoices…'}" autocomplete="off">
          <div class="search-results hidden" id="gresults"></div>
        </div>
        <span class="spacer"></span>
        <button class="icon-btn bell" id="bell" aria-label="Notifications" aria-expanded="false">🔔<span class="count hidden" id="ncount"></span></button>
        <span class="userchip"><span class="avatar" aria-hidden="true">${esc(initials)}</span><span class="name">${esc(u.display_name)}<br><small>${esc(u.role)}</small></span></span>
      </header>
      <div class="notif-panel hidden" id="npanel" role="dialog" aria-label="Notifications"></div>
      <main class="content" id="view" tabindex="-1">${loading()}</main>
    </div>
  </div>`;
  $('#logout').addEventListener('click', (e) => { e.preventDefault(); logout(); });
  $('#menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#nav').addEventListener('click', () => $('#sidebar').classList.remove('open'));
  $('#bell').addEventListener('click', toggleNotifications);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#npanel, #bell')) { $('#npanel')?.classList.add('hidden'); $('#bell')?.setAttribute('aria-expanded', 'false'); }
    if (!e.target.closest('.search')) $('#gresults')?.classList.add('hidden');
  });
  wireSearch();
  loadNotifications();
  clearInterval(state.notifTimer);
  state.notifTimer = setInterval(loadNotifications, 120e3);
  startIdleWatch();
  route();
}

let renderToken = 0;
async function route() {
  if (!state.me) return;
  const view = $('#view');
  if (!view) return;
  let { parts, query } = parseHash();
  if (!parts.length) { location.hash = ctx.isCaregiver() ? '#/my' : '#/dashboard'; return; }
  if (ctx.isCaregiver() && parts[0] !== 'my' && parts[0] !== 'account') { location.hash = '#/my'; return; }
  if (!ctx.isCaregiver() && parts[0] === 'my') { location.hash = '#/dashboard'; return; }
  const key = parts[0];
  const navKey = key === 'my' ? (parts[1] && ['timesheet', 'incident', 'profile'].includes(parts[1]) ? `my/${parts[1]}` : 'my') : key;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === navKey));
  const loader = PAGES[key];
  const token = ++renderToken;
  view.innerHTML = loading();
  if (!loader) { view.innerHTML = '<div class="card">Page not found.</div>'; return; }
  try {
    const mod = await loader();
    if (token !== renderToken) return;
    const fresh = view.cloneNode(false); // drop listeners from the previous page
    view.replaceWith(fresh);
    await mod.render(fresh, parts.slice(1), query, ctx);
    fresh.focus({ preventScroll: true });
  } catch (e) {
    if (token !== renderToken) return;
    if (e.status === 401) return;
    $('#view').innerHTML = e.status === 403
      ? `<div class="card"><h2>No access</h2><p>${esc(e.message)} Ask an administrator if you need this page.</p></div>`
      : `<div class="card"><h2>Something went wrong</h2><p>${esc(e.message)}</p></div>`;
  }
}
window.addEventListener('hashchange', route);
export const rerender = () => route();

// ---------- notifications ----------
let notifications = [];
async function loadNotifications() {
  try {
    notifications = await api.get('/notifications');
    const c = $('#ncount');
    if (!c) return;
    const n = notifications.filter((x) => x.severity !== 'info').length || notifications.length;
    c.textContent = n;
    c.classList.toggle('hidden', !notifications.length);
  } catch { /* handled by auth handler */ }
}
function toggleNotifications() {
  const p = $('#npanel');
  const open = p.classList.toggle('hidden') === false;
  $('#bell').setAttribute('aria-expanded', String(open));
  if (!open) return;
  const icon = { high: '🔴', medium: '🟠', info: '🔵' };
  p.innerHTML = notifications.length
    ? notifications.map((n) => `<a href="${esc(n.link)}"><span aria-hidden="true">${icon[n.severity] || '•'}</span><span>${esc(n.text)}</span></a>`).join('')
    : '<div class="empty">You\'re all caught up.</div>';
  p.addEventListener('click', (e) => { if (e.target.closest('a')) p.classList.add('hidden'); }, { once: true });
}

// ---------- global search ----------
function wireSearch() {
  const input = $('#gsearch');
  const out = $('#gresults');
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { out.classList.add('hidden'); return; }
      try {
        const rows = await api.get('/search', { q });
        out.innerHTML = rows.length ? rows.map((r) => `<a href="${esc(r.link)}">${esc(r.label)}<small>${esc(r.type)} · ${esc(r.sub || '')}</small></a>`).join('') : '<div class="empty">No matches.</div>';
        out.classList.remove('hidden');
      } catch (e) { showError(e); }
    }, 220);
  });
  out.addEventListener('click', (e) => { if (e.target.closest('a')) { out.classList.add('hidden'); input.value = ''; } });
}

// ---------- idle timeout (server enforces; this warns the user first) ----------
let idleTimer;
let lastActive = Date.now();
function startIdleWatch() {
  const mark = () => { lastActive = Date.now(); };
  ['click', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, mark, { passive: true }));
  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    if (!state.me) return;
    const idle = (Date.now() - lastActive) / 60000;
    const limit = state.me.idle_minutes;
    if (idle >= limit) { toast('Signed out after inactivity.'); logout(); }
    else if (idle >= limit - 2 && !document.querySelector('.toast[data-idle]')) {
      toast('You will be signed out soon due to inactivity. Click anywhere to stay signed in.');
      document.querySelector('.toast:last-child')?.setAttribute('data-idle', '1');
    }
  }, 30e3);
  // Keep server session alive while the user is active.
  setInterval(() => { if (state.me && Date.now() - lastActive < 60e3) api.get('/auth/me').catch(() => {}); }, 4 * 60e3);
}

boot();
