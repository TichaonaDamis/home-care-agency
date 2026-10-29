'use strict';
const express = require('express');
const { HttpError, addDays } = require('../lib/util');
const { validate, idParam } = require('../lib/validate');
const { requirePerm, can } = require('../lib/auth');
const { audit, addVersionedRate, payRateFor } = require('../lib/core');

const SCHEMA = {
  code: { type: 'string', max: 30 },
  full_name: { type: 'string', required: true, max: 120 },
  phone: { type: 'string', max: 40 },
  email: { type: 'email' },
  address: { type: 'string', max: 300 },
  emergency_name: { type: 'string', max: 120 },
  emergency_phone: { type: 'string', max: 40 },
  employment_status: { type: 'enum', values: ['applicant', 'active', 'on_leave', 'terminated'], default: 'active' },
  employment_class: { type: 'enum', values: ['w2_hourly', 'w2_salaried', 'per_diem', 'contractor'], default: 'w2_hourly' },
  hire_date: { type: 'date' },
  termination_date: { type: 'date' },
  overtime_rule: { type: 'enum', values: ['weekly40', 'daily8_weekly40', 'none'], default: 'weekly40' },
  ot_multiplier: { type: 'number', min: 1, max: 3, default: 1.5 },
  mileage_rate: { type: 'money', min: 0, default: 0 },
  background_status: { type: 'enum', values: ['not_started', 'pending', 'cleared', 'flagged', 'not_required'], default: 'not_started' },
  background_date: { type: 'date' },
  med_authority: { type: 'enum', values: ['none', 'assist', 'administer'], default: 'assist' },
  responsibilities: { type: 'text', max: 2000 },
  restrictions: { type: 'text', max: 2000 },
  availability: { type: 'text', max: 1000 },
  facility_id: { type: 'id' },
};
// Visible to staff without caregivers.sensitive (e.g. nurses).
const BASIC = ['id', 'code', 'full_name', 'phone', 'email', 'employment_status', 'med_authority', 'responsibilities', 'restrictions', 'availability', 'facility_id', 'facility_name', 'is_sample'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
const toRow = (v) => { const { mileage_rate, ...rest } = v; if (mileage_rate !== undefined) rest.mileage_rate_cents = mileage_rate; return rest; };

module.exports = ({ db, settings }) => {
  const r = express.Router();
  const manage = requirePerm('caregivers.manage');

  function warningsFor(cgId) {
    const today = settings.today();
    const soon = addDays(today, settings.get('credential_warning_days'));
    const w = [];
    for (const c of db.all('SELECT * FROM credentials WHERE caregiver_id = ? AND expires_on IS NOT NULL AND expires_on <= ?', [cgId, soon])) {
      w.push({ kind: c.expires_on < today ? 'credential_expired' : 'credential_expiring', text: `${c.name} ${c.expires_on < today ? 'expired' : 'expires'} ${c.expires_on}` });
    }
    for (const c of db.all('SELECT name FROM credentials WHERE caregiver_id = ? AND required = 1 AND verified = 0', [cgId])) w.push({ kind: 'credential_unverified', text: `${c.name} not verified` });
    const cg = db.get('SELECT background_status FROM caregivers WHERE id = ?', [cgId]);
    if (cg && !['cleared', 'not_required'].includes(cg.background_status)) w.push({ kind: 'background', text: `Background check: ${cg.background_status.replace('_', ' ')}` });
    const undoc = db.get(`SELECT COUNT(*) n FROM shifts WHERE caregiver_id = ? AND status = 'completed' AND doc_complete = 0`, [cgId]).n;
    if (undoc) w.push({ kind: 'documentation', text: `${undoc} shift(s) with incomplete documentation` });
    if (payRateFor(db, cgId, today) == null) w.push({ kind: 'pay_rate', text: 'No pay rate in effect today' });
    return w;
  }

  r.get('/caregivers', requirePerm('caregivers.view', 'schedule.view'), (req, res) => {
    const where = [];
    const p = [];
    if (req.query.q) { where.push('(c.full_name LIKE ? OR c.code LIKE ?)'); p.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    if (req.query.status) { where.push('c.employment_status = ?'); p.push(String(req.query.status)); }
    if (req.query.facility_id) { where.push('c.facility_id = ?'); p.push(idParam(req.query.facility_id)); }
    const today = settings.today();
    const rows = db.all(`SELECT c.*, f.name AS facility_name,
        (SELECT COUNT(DISTINCT a.client_id) FROM assignments a WHERE a.caregiver_id = c.id AND a.status = 'active' AND a.start_date <= ? AND (a.end_date IS NULL OR a.end_date >= ?)) AS active_clients,
        (SELECT u.id FROM users u WHERE u.caregiver_id = c.id) AS user_id
      FROM caregivers c LEFT JOIN facilities f ON f.id = c.facility_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.full_name`, [today, today, ...p]);
    const sensitive = can(req.user, 'caregivers.sensitive');
    res.json(rows.map((c) => ({
      ...(sensitive ? { ...c, pay_rate_cents: payRateFor(db, c.id, today) } : pick(c, BASIC)),
      active_clients: c.active_clients, has_login: !!c.user_id, warnings: warningsFor(c.id),
    })));
  });

  r.post('/caregivers', manage, (req, res) => {
    const v = toRow(validate(SCHEMA, req.body));
    const rate = validate({ pay_rate: { type: 'money', min: 0, required: true }, rate_effective_from: { type: 'date' } }, req.body);
    const id = db.tx(() => {
      if (!v.code) {
        let n = db.get('SELECT COUNT(*) n FROM caregivers').n + 1;
        while (db.get('SELECT 1 FROM caregivers WHERE code = ?', [`CG-${String(n).padStart(4, '0')}`])) n++;
        v.code = `CG-${String(n).padStart(4, '0')}`;
      }
      const cgId = db.insert('caregivers', v);
      db.insert('caregiver_pay_rates', { caregiver_id: cgId, rate_cents: rate.pay_rate, effective_from: rate.rate_effective_from || v.hire_date || settings.today(), created_by: req.user.id });
      return cgId;
    });
    audit(db, req, 'create', 'caregiver', id, { after: { pay_rate_cents: rate.pay_rate } });
    res.status(201).json({ id, code: v.code });
  });

  r.get('/caregivers/:id', (req, res) => {
    const id = idParam(req.params.id);
    const self = req.user.role === 'caregiver' && req.user.caregiver_id === id;
    if (!self && !can(req.user, 'caregivers.view')) throw new HttpError(403, 'You do not have permission to do that.');
    const c = db.get('SELECT c.*, f.name AS facility_name FROM caregivers c LEFT JOIN facilities f ON f.id = c.facility_id WHERE c.id = ?', [id]);
    if (!c) throw new HttpError(404, 'Caregiver not found.');
    const sensitive = self || can(req.user, 'caregivers.sensitive');
    const out = sensitive ? { ...c } : pick(c, BASIC);
    if (sensitive) {
      out.pay_rates = db.all('SELECT * FROM caregiver_pay_rates WHERE caregiver_id = ? ORDER BY effective_from DESC', [id]);
      out.pay_rate_cents = payRateFor(db, id, settings.today());
    }
    out.credentials = db.all('SELECT * FROM credentials WHERE caregiver_id = ? ORDER BY expires_on', [id]);
    out.assignments = db.all(`SELECT a.*, cl.legal_name AS client_name, cl.code AS client_code FROM assignments a JOIN clients cl ON cl.id = a.client_id
      WHERE a.caregiver_id = ? ORDER BY a.status = 'active' DESC, a.start_date DESC`, [id]);
    if (!sensitive) out.assignments = out.assignments.map(({ pay_rate_cents, bill_rate_cents, ...a }) => a);
    if (self) out.assignments = out.assignments.map(({ bill_rate_cents, ...a }) => a);
    out.warnings = warningsFor(id);
    out.user = db.get('SELECT id, username, active, last_login_at FROM users WHERE caregiver_id = ?', [id]) || null;
    if (!self) audit(db, req, 'view', 'caregiver', id);
    res.json(out);
  });

  r.patch('/caregivers/:id', manage, (req, res) => {
    const id = idParam(req.params.id);
    const before = db.get('SELECT * FROM caregivers WHERE id = ?', [id]);
    if (!before) throw new HttpError(404, 'Caregiver not found.');
    const v = toRow(validate(SCHEMA, req.body, { partial: true }));
    delete v.code;
    db.update('caregivers', id, { ...v, updated_at: new Date().toISOString() });
    if (v.employment_status === 'terminated') {
      const u = db.get('SELECT id FROM users WHERE caregiver_id = ?', [id]);
      if (u) { db.run('UPDATE users SET active = 0 WHERE id = ?', [u.id]); db.run('DELETE FROM sessions WHERE user_id = ?', [u.id]); }
    }
    audit(db, req, 'update', 'caregiver', id, { before, after: v });
    res.json({ ok: true });
  });

  r.post('/caregivers/:id/pay-rates', manage, (req, res) => {
    const id = idParam(req.params.id);
    if (!db.get('SELECT 1 FROM caregivers WHERE id = ?', [id])) throw new HttpError(404, 'Caregiver not found.');
    const v = validate({ rate: { type: 'money', min: 0, required: true }, effective_from: { type: 'date', required: true } }, req.body);
    const rid = db.tx(() => addVersionedRate(db, {
      table: 'caregiver_pay_rates', whereSql: 'caregiver_id = ?', whereParams: [id], from: v.effective_from,
      row: { caregiver_id: id, rate_cents: v.rate, created_by: req.user.id },
    }));
    audit(db, req, 'create', 'caregiver_pay_rate', rid, { after: { caregiver_id: id, rate_cents: v.rate, effective_from: v.effective_from } });
    res.status(201).json({ id: rid });
  });

  const CRED = {
    name: { type: 'string', required: true, max: 120 }, number: { type: 'string', max: 60 }, issued_on: { type: 'date' },
    expires_on: { type: 'date' }, verified: { type: 'bool' }, required: { type: 'bool', default: 1 }, notes: { type: 'text', max: 1000 },
  };
  r.post('/caregivers/:id/credentials', manage, (req, res) => {
    const cgId = idParam(req.params.id);
    if (!db.get('SELECT 1 FROM caregivers WHERE id = ?', [cgId])) throw new HttpError(404, 'Caregiver not found.');
    const id = db.insert('credentials', { caregiver_id: cgId, ...validate(CRED, req.body) });
    audit(db, req, 'create', 'credential', id);
    res.status(201).json({ id });
  });
  r.patch('/credentials/:id', manage, (req, res) => {
    const id = idParam(req.params.id);
    if (!db.update('credentials', id, validate(CRED, req.body, { partial: true }))) throw new HttpError(404, 'Not found.');
    audit(db, req, 'update', 'credential', id);
    res.json({ ok: true });
  });
  r.delete('/credentials/:id', manage, (req, res) => {
    const id = idParam(req.params.id);
    if (!db.run('DELETE FROM credentials WHERE id = ?', [id]).changes) throw new HttpError(404, 'Not found.');
    audit(db, req, 'delete', 'credential', id);
    res.json({ ok: true });
  });

  return r;
};
