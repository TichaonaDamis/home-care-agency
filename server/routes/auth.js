'use strict';
const express = require('express');
const { HttpError } = require('../lib/util');
const { validate } = require('../lib/validate');
const {
  verifyPassword, hashPassword, DUMMY_HASH, passwordProblem, createSession, sessionCookie, ROLE_PERMS, COOKIE,
} = require('../lib/auth');
const { audit } = require('../lib/core');

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

module.exports = ({ db, settings, secureCookies }) => {
  const r = express.Router();

  // Simple per-IP throttle on top of per-account lockout.
  const hits = new Map();
  const throttle = (ip) => {
    const now = Date.now();
    const h = (hits.get(ip) || []).filter((t) => now - t < 15 * 60e3);
    h.push(now);
    hits.set(ip, h);
    if (h.length > 30) throw new HttpError(429, 'Too many sign-in attempts. Try again later.');
  };

  r.post('/auth/login', (req, res) => {
    throttle(req.ip);
    const { username, password } = validate({ username: { type: 'string', required: true, max: 100 }, password: { type: 'string', required: true, max: 200 } }, req.body);
    const u = db.get('SELECT * FROM users WHERE username = ?', [username]);
    const fail = (msg = 'Incorrect username or password.') => {
      audit(db, req, 'login_failed', 'user', u?.id ?? null, { note: u ? null : 'unknown username' });
      throw new HttpError(401, msg);
    };
    if (!u) { verifyPassword(password, DUMMY_HASH); fail(); }
    if (u.locked_until && Date.parse(u.locked_until) > Date.now()) fail('This account is temporarily locked after repeated failed sign-ins. Try again later or contact an administrator.');
    if (!verifyPassword(password, u.password_hash)) {
      const fails = u.failed_logins + 1;
      const lock = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60e3).toISOString() : null;
      db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', [lock ? 0 : fails, lock, u.id]);
      fail();
    }
    if (!u.active) fail('This account is disabled.');
    db.run('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', [new Date().toISOString(), u.id]);
    const s = createSession(db, settings, u.id, req.ip);
    res.set('Set-Cookie', sessionCookie(s.token, { secure: secureCookies, maxAgeSec: s.maxAgeSec }));
    req.user = u;
    audit(db, req, 'login', 'user', u.id);
    res.json({ ok: true, must_change_password: !!u.must_change_password });
  });

  r.post('/auth/logout', (req, res) => {
    if (req.sessionHash) {
      db.run('DELETE FROM sessions WHERE token_hash = ?', [req.sessionHash]);
      audit(db, req, 'logout', 'user', req.user.id);
    }
    res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  r.get('/auth/me', (req, res) => {
    if (!req.user) throw new HttpError(401, req.sessionExpired ? 'Your session expired. Please sign in again.' : 'Please sign in.');
    res.json({
      user: req.user,
      permissions: [...ROLE_PERMS[req.user.role]],
      agency_name: settings.get('agency_name'),
      idle_minutes: settings.get('session_idle_minutes'),
      today: settings.today(),
    });
  });

  r.post('/auth/change-password', (req, res) => {
    if (!req.user) throw new HttpError(401, 'Please sign in.');
    const { current_password, new_password } = validate({
      current_password: { type: 'string', required: true, max: 200 }, new_password: { type: 'string', required: true, max: 200 },
    }, req.body);
    const u = db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!verifyPassword(current_password, u.password_hash)) throw new HttpError(400, 'Current password is incorrect.', { current_password: 'Incorrect' });
    const problem = passwordProblem(new_password, u.username);
    if (problem) throw new HttpError(400, problem, { new_password: problem });
    if (verifyPassword(new_password, u.password_hash)) throw new HttpError(400, 'Choose a different password.', { new_password: 'Same as current' });
    db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hashPassword(new_password), u.id]);
    // End all other sessions for this user.
    db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [u.id, req.sessionHash]);
    audit(db, req, 'password_change', 'user', u.id);
    res.json({ ok: true });
  });

  return r;
};
