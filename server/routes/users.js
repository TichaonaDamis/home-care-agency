'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { HttpError } = require('../lib/util');
const { validate, idParam } = require('../lib/validate');
const { requirePerm, hashPassword, passwordProblem } = require('../lib/auth');
const { audit } = require('../lib/core');

const ROLES = ['admin', 'manager', 'nurse', 'caregiver'];

/** Readable one-time password, e.g. "tulip-4821-river". */
function tempPassword() {
  const words = ['maple', 'river', 'cedar', 'harbor', 'meadow', 'tulip', 'summit', 'willow', 'aspen', 'coral', 'birch', 'lark'];
  const w = () => words[crypto.randomInt(words.length)];
  return `${w()}-${crypto.randomInt(1000, 9999)}-${w()}`;
}

module.exports = ({ db }) => {
  const r = express.Router();
  const guard = requirePerm('users.manage');

  r.get('/users', guard, (req, res) => {
    res.json(db.all(`SELECT u.id, u.username, u.display_name, u.role, u.caregiver_id, u.active, u.must_change_password,
      u.last_login_at, u.locked_until, u.created_at, c.full_name AS caregiver_name
      FROM users u LEFT JOIN caregivers c ON c.id = u.caregiver_id ORDER BY u.display_name`));
  });

  r.post('/users', guard, (req, res) => {
    const v = validate({
      username: { type: 'string', required: true, max: 60 },
      display_name: { type: 'string', required: true, max: 120 },
      role: { type: 'enum', values: ROLES, required: true },
      caregiver_id: { type: 'id' },
      password: { type: 'string', max: 200 },
    }, req.body);
    if (!/^[a-zA-Z0-9._@-]{3,60}$/.test(v.username)) throw new HttpError(400, 'Username may contain letters, numbers, dot, dash, underscore and @.', { username: 'Invalid' });
    if (v.role === 'caregiver' && !v.caregiver_id) throw new HttpError(400, 'Link the account to a caregiver profile.', { caregiver_id: 'Required for caregiver accounts' });
    if (v.role !== 'caregiver') v.caregiver_id = null;
    const pw = v.password || tempPassword();
    if (v.password) {
      const p = passwordProblem(v.password, v.username);
      if (p) throw new HttpError(400, p, { password: p });
    }
    const id = db.insert('users', {
      username: v.username, display_name: v.display_name, role: v.role, caregiver_id: v.caregiver_id,
      password_hash: hashPassword(pw), must_change_password: 1,
    });
    audit(db, req, 'create', 'user', id, { after: { role: v.role, caregiver_id: v.caregiver_id } });
    // The temporary password is shown once to the administrator and never stored in plain text.
    res.status(201).json({ id, temporary_password: pw });
  });

  r.patch('/users/:id', guard, (req, res) => {
    const id = idParam(req.params.id);
    const before = db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!before) throw new HttpError(404, 'User not found.');
    const v = validate({
      display_name: { type: 'string', max: 120 }, role: { type: 'enum', values: ROLES }, active: { type: 'bool' }, caregiver_id: { type: 'id' },
    }, req.body, { partial: true });
    if (id === req.user.id && (v.active === 0 || (v.role && v.role !== 'admin'))) throw new HttpError(400, 'You cannot disable or demote your own account.');
    const role = v.role ?? before.role;
    if (role === 'caregiver' && !(v.caregiver_id ?? before.caregiver_id)) throw new HttpError(400, 'Caregiver accounts must be linked to a caregiver profile.');
    if (role !== 'caregiver' && v.role) v.caregiver_id = null;
    db.update('users', id, v);
    if (v.active === 0 || (v.role && v.role !== before.role)) db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
    audit(db, req, 'update', 'user', id, { before, after: v });
    res.json({ ok: true });
  });

  r.post('/users/:id/reset-password', guard, (req, res) => {
    const id = idParam(req.params.id);
    if (!db.get('SELECT id FROM users WHERE id = ?', [id])) throw new HttpError(404, 'User not found.');
    const pw = tempPassword();
    db.run('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE id = ?', [hashPassword(pw), id]);
    db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
    audit(db, req, 'reset_password', 'user', id);
    res.json({ temporary_password: pw });
  });

  return r;
};

module.exports.tempPassword = tempPassword;
