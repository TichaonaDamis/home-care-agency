'use strict';
const crypto = require('node:crypto');
const { HttpError } = require('./util');

// ---------- passwords (scrypt) ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, actual);
}
// Used to equalize timing when the username does not exist.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

function passwordProblem(pw, username) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'Password must not contain the username.';
  if (/^(.)\1+$/.test(pw)) return 'Password is too simple.';
  if (!/[a-zA-Z]/.test(pw) || !/[^a-zA-Z]/.test(pw)) return 'Use a mix of letters and numbers or symbols.';
  return null;
}

// ---------- permissions ----------
const ALL = [
  'clients.view', 'clients.manage', 'caregivers.view', 'caregivers.manage', 'caregivers.sensitive',
  'schedule.view', 'schedule.manage', 'time.approve', 'care.view', 'care.document', 'careplan.manage',
  'meds.view', 'meds.manage', 'meds.verify', 'meds.document', 'health.view', 'health.record', 'thresholds.manage',
  'incidents.report', 'incidents.manage', 'alerts.manage', 'transitions.manage', 'progress.review',
  'reports.clinical', 'reports.operations', 'reports.financial', 'finance.view', 'finance.manage', 'payroll.approve',
  'users.manage', 'settings.manage', 'audit.view',
];
const ROLE_PERMS = {
  admin: new Set(ALL),
  manager: new Set(ALL.filter((p) => !['users.manage', 'settings.manage'].includes(p))),
  nurse: new Set([
    'clients.view', 'caregivers.view', 'schedule.view', 'care.view', 'care.document', 'careplan.manage',
    'meds.view', 'meds.manage', 'meds.verify', 'meds.document', 'health.view', 'health.record', 'thresholds.manage',
    'incidents.report', 'incidents.manage', 'alerts.manage', 'transitions.manage', 'progress.review', 'reports.clinical',
  ]),
  // Caregivers get self-service permissions; every client-level read is further scoped by assignment.
  caregiver: new Set(['portal', 'care.document', 'meds.document', 'health.record', 'incidents.report']),
};
const can = (user, perm) => !!user && ROLE_PERMS[user.role]?.has(perm);
const isStaff = (user) => !!user && user.role !== 'caregiver';

// ---------- sessions ----------
const COOKIE = 'ch_sid';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, { secure, maxAgeSec }) {
  return [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', secure ? 'Secure' : null,
    `Max-Age=${maxAgeSec}`].filter(Boolean).join('; ');
}

function createSession(db, settings, userId, ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + settings.get('session_max_hours') * 3600e3);
  db.run('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, ip) VALUES (?,?,?,?,?,?)',
    [sha256(token), userId, now.toISOString(), now.toISOString(), expires.toISOString(), ip]);
  return { token, maxAgeSec: Math.floor((expires - now) / 1000) };
}

/** Express middleware: attaches req.user when a valid, non-idle session cookie is present. */
function sessionMiddleware(db, settings) {
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return next();
    const hash = sha256(token);
    const row = db.get(`SELECT s.*, u.username, u.display_name, u.role, u.caregiver_id, u.active, u.must_change_password
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, [hash]);
    if (!row) return next();
    const now = Date.now();
    const idleMs = settings.get('session_idle_minutes') * 60e3;
    if (!row.active || now > Date.parse(row.expires_at) || now - Date.parse(row.last_seen_at) > idleMs) {
      db.run('DELETE FROM sessions WHERE token_hash = ?', [hash]);
      req.sessionExpired = true;
      return next();
    }
    if (now - Date.parse(row.last_seen_at) > 30e3) {
      db.run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', [new Date(now).toISOString(), hash]);
    }
    req.sessionHash = hash;
    req.user = {
      id: row.user_id, username: row.username, display_name: row.display_name, role: row.role,
      caregiver_id: row.caregiver_id, must_change_password: !!row.must_change_password,
    };
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, req.sessionExpired ? 'Your session expired. Please sign in again.' : 'Please sign in.'));
  if (req.user.must_change_password && !req.path.startsWith('/auth/')) {
    return next(new HttpError(403, 'You must change your password before continuing.', { code: 'PASSWORD_CHANGE_REQUIRED' }));
  }
  next();
}
const requirePerm = (...perms) => (req, res, next) => {
  if (!perms.some((p) => can(req.user, p))) return next(new HttpError(403, 'You do not have permission to do that.'));
  next();
};

/**
 * CSRF defence: state-changing requests must carry a custom header, which browsers will not
 * send cross-origin without a CORS preflight (which we never grant). Combined with SameSite=Strict.
 */
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-CareHours') !== '1') return next(new HttpError(403, 'Request blocked.'));
  next();
}

module.exports = {
  hashPassword, verifyPassword, DUMMY_HASH, passwordProblem, ROLE_PERMS, ALL_PERMS: ALL, can, isStaff,
  createSession, sessionMiddleware, sessionCookie, requireAuth, requirePerm, csrfGuard, sha256, COOKIE,
};
