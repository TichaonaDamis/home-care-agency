'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, PASSWORD } = require('./helpers');
const { hashPassword } = require('../server/lib/auth');

test('authentication, sessions and CSRF', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  s.makeUser('boss', 'admin');

  await t.test('rejects bad credentials without revealing which part was wrong', async () => {
    const c = s.client();
    const a = await c.post('/auth/login', { username: 'boss', password: 'wrong-password-1' });
    const b = await c.post('/auth/login', { username: 'nobody', password: 'wrong-password-1' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.body.error, b.body.error);
  });

  await t.test('session cookie is HttpOnly and SameSite=Strict; passwords are hashed', async () => {
    const c = s.client();
    await c.post('/auth/login', { username: 'boss', password: PASSWORD });
    assert.match(c.lastSetCookie, /HttpOnly/);
    assert.match(c.lastSetCookie, /SameSite=Strict/);
    const row = s.db.get(`SELECT password_hash FROM users WHERE username = 'boss'`);
    assert.match(row.password_hash, /^scrypt\$/);
    assert.ok(!row.password_hash.includes(PASSWORD));
    const tokenRow = s.db.get('SELECT token_hash FROM sessions LIMIT 1');
    assert.ok(!c.cookie.includes(tokenRow.token_hash), 'only a hash of the session token is stored');
  });

  await t.test('state-changing requests without the CSRF header are blocked', async () => {
    const c = await s.login('boss');
    const r = await c.req('POST', '/clients', { legal_name: 'X' }, { csrf: false });
    assert.equal(r.status, 403);
  });

  await t.test('account locks after repeated failures', async () => {
    s.makeUser('locky', 'manager');
    const c = s.client();
    for (let i = 0; i < 5; i++) await c.post('/auth/login', { username: 'locky', password: 'nope-nope-123' });
    const r = await c.post('/auth/login', { username: 'locky', password: PASSWORD });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /locked/i);
    assert.ok(s.db.get(`SELECT COUNT(*) n FROM audit_log WHERE action = 'login_failed'`).n >= 5);
  });

  await t.test('logout ends the session', async () => {
    const c = await s.login('boss');
    assert.equal((await c.get('/auth/me')).status, 200);
    await c.post('/auth/logout');
    assert.equal((await c.get('/clients')).status, 401);
  });

  await t.test('idle sessions expire on the server', async () => {
    const c = await s.login('boss');
    s.db.run(`UPDATE sessions SET last_seen_at = ?`, [new Date(Date.now() - 2 * 3600e3).toISOString()]);
    const r = await c.get('/clients');
    assert.equal(r.status, 401);
    assert.match(r.body.error, /expired/i);
  });

  await t.test('temporary passwords force a change before any other API use', async () => {
    s.db.insert('users', { username: 'newbie', display_name: 'Newbie', role: 'manager', password_hash: hashPassword('Temp-pass-001'), must_change_password: 1 });
    const c = await s.login('newbie', 'Temp-pass-001');
    const blocked = await c.get('/clients');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.details.code, 'PASSWORD_CHANGE_REQUIRED');
    const weak = await c.post('/auth/change-password', { current_password: 'Temp-pass-001', new_password: 'short' });
    assert.equal(weak.status, 400);
    const ok = await c.post('/auth/change-password', { current_password: 'Temp-pass-001', new_password: 'A-much-better-pass-9' });
    assert.equal(ok.status, 200);
    assert.equal((await c.get('/clients')).status, 200);
  });

  await t.test('security headers are set and errors do not leak internals', async () => {
    const c = await s.login('boss');
    const r = await c.get('/clients/999999');
    assert.equal(r.status, 404);
    assert.ok(r.headers.get('content-security-policy').includes("default-src 'self'"));
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const bad = await c.post('/clients', { legal_name: '', dob: 'not-a-date' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.details.legal_name, 'Required');
    assert.equal(bad.body.details.dob, 'Invalid date');
  });
});

test('role-based access control is enforced on the server', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  s.makeUser('admin', 'admin');
  s.makeUser('nurse', 'nurse');
  const admin = await s.login('admin');
  const cl1 = (await admin.post('/clients', { legal_name: 'Assigned Client' })).body.id;
  const cl2 = (await admin.post('/clients', { legal_name: 'Other Client' })).body.id;
  const cg = (await admin.post('/caregivers', { full_name: 'Casey Giver', pay_rate: 20 })).body.id;
  const cg2 = (await admin.post('/caregivers', { full_name: 'Other Giver', pay_rate: 25 })).body.id;
  s.makeUser('casey', 'caregiver', cg);
  const today = s.ctx.settings.today();
  const a = (await admin.post('/assignments', { caregiver_id: cg, client_id: cl1, start_date: today, days_of_week: [0, 1, 2, 3, 4, 5, 6], shift_start: '08:00', shift_end: '10:00' })).body.id;
  await admin.post(`/assignments/${a}/approve`);
  const casey = await s.login('casey');
  const nurse = await s.login('nurse');

  await t.test('caregiver sees only assigned clients, with limited fields', async () => {
    const list = await casey.get('/clients');
    assert.deepEqual(list.body.map((c) => c.id), [cl1]);
    assert.equal(list.body[0].consent_notes, undefined);
    assert.equal((await casey.get(`/clients/${cl2}`)).status, 403);
    assert.equal((await casey.get(`/clients/${cl1}`)).status, 200);
    assert.equal((await casey.get(`/clients/${cl2}/medications`)).status, 403);
  });

  await t.test('caregiver cannot reach other caregivers, finance, users, or change orders', async () => {
    assert.equal((await casey.get(`/caregivers/${cg2}`)).status, 403);
    assert.equal((await casey.get(`/caregivers/${cg}`)).status, 200);
    for (const p of ['/caregivers', '/payroll/preview?from=2026-01-01&to=2026-01-31', '/invoices', '/users', '/audit', '/dashboard', '/alerts', '/reports/monthly?type=financial&month=2026-01']) {
      assert.equal((await casey.get(p)).status, 403, p);
    }
    const med = (await admin.post(`/clients/${cl1}/medications`, { name: 'Test med' })).body.id;
    assert.equal((await casey.patch(`/medications/${med}`, { dose: '2 tablets', effective_date: today })).status, 403);
    assert.equal((await casey.post(`/clients/${cl1}/medications`, { name: 'X' })).status, 403);
  });

  await t.test('assignment ending removes caregiver access', async () => {
    await admin.patch(`/assignments/${a}`, { status: 'ended', end_date: s.ctx.settings.today() });
    // Still has access today (assignment covers today); move end date into the past.
    s.db.run('UPDATE assignments SET end_date = ?, start_date = ? WHERE id = ?', ['2000-01-02', '2000-01-01', a]);
    assert.equal((await casey.get(`/clients/${cl1}`)).status, 403);
  });

  await t.test('nurse has clinical access but no payroll, billing or user management', async () => {
    assert.equal((await nurse.get(`/clients/${cl1}`)).status, 200);
    assert.equal((await nurse.get('/invoices')).status, 403);
    assert.equal((await nurse.get('/payroll/runs')).status, 403);
    assert.equal((await nurse.get('/users')).status, 403);
    const cgView = await nurse.get(`/caregivers/${cg}`);
    assert.equal(cgView.status, 200);
    assert.equal(cgView.body.pay_rates, undefined, 'pay history hidden from nurses');
  });

  await t.test('access to protected records is audit-logged', async () => {
    await admin.get(`/clients/${cl1}`);
    const row = s.db.get(`SELECT * FROM audit_log WHERE action = 'view' AND entity = 'client' AND entity_id = ? ORDER BY id DESC`, [cl1]);
    assert.ok(row);
    assert.equal(row.username, 'admin');
  });
});
