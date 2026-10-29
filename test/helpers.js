'use strict';
// Test harness: in-memory database, real HTTP server on an ephemeral port, cookie-aware client.
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { hashPassword } = require('../server/lib/auth');

const PASSWORD = 'Test-Password-123';

async function startServer({ timezone = 'UTC' } = {}) {
  const db = openDb(':memory:');
  db.run(`UPDATE settings SET value = ? WHERE key = 'timezone'`, [JSON.stringify(timezone)]);
  const { app, ctx } = createApp(db, { quiet: !process.env.DEBUG_ERRORS });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const makeUser = (username, role, caregiverId = null) => db.insert('users', {
    username, display_name: username, role, caregiver_id: caregiverId, password_hash: hashPassword(PASSWORD), must_change_password: 0,
  });
  return {
    db, ctx, base, makeUser,
    client: () => new Client(base),
    async login(username, password = PASSWORD) {
      const c = new Client(base);
      const r = await c.post('/auth/login', { username, password });
      if (r.status !== 200) throw new Error(`login failed for ${username}: ${JSON.stringify(r.body)}`);
      return c;
    },
    close: () => new Promise((resolve) => server.close(() => { db.close(); resolve(); })),
  };
}

class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, path, body, { csrf = true, raw = false } = {}) {
    const headers = {};
    if (csrf) headers['X-CareHours'] = '1';
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${this.base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) { this.cookie = set.split(';')[0]; this.lastSetCookie = set; }
    if (raw) return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }
  get(p, q) { return this.req('GET', q ? `${p}?${new URLSearchParams(q)}` : p); }
  post(p, b = {}, o) { return this.req('POST', p, b, o); }
  patch(p, b = {}) { return this.req('PATCH', p, b); }
  put(p, b = {}) { return this.req('PUT', p, b); }
  del(p) { return this.req('DELETE', p); }
}

/** Current UTC date and HH:MM (tests run with the agency time zone set to UTC). */
function nowUtc() {
  const iso = new Date().toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}
function plusMinutes(hhmm, m) {
  const [h, mm] = hhmm.split(':').map(Number);
  const t = (((h * 60 + mm + m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

module.exports = { startServer, PASSWORD, nowUtc, plusMinutes };
