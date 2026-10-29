'use strict';
const express = require('express');
const { HttpError, nowLocal, daysBetween, round2 } = require('../lib/util');
const { validate, idParam } = require('../lib/validate');
const { requirePerm, can } = require('../lib/auth');
const { audit, assertClientAccess, assertShiftForCaregiver } = require('../lib/core');
const alerts = require('../lib/alerts');

module.exports = ({ db, settings }) => {
  const r = express.Router();
  const now = () => nowLocal(settings.get('timezone'));

  r.get('/measurement-types', (req, res) => {
    let rows = db.all('SELECT * FROM measurement_types WHERE active = 1 ORDER BY sort');
    if (req.user.role === 'caregiver') rows = rows.filter((t) => t.caregiver_may_record);
    res.json(rows);
  });

  /** Record one or more measurements taken together. */
  r.post('/measurements', requirePerm('health.record'), (req, res) => {
    const base = validate({
      client_id: { type: 'id', required: true }, shift_id: { type: 'id' }, measured_at: { type: 'datetime' },
      method: { type: 'string', max: 200 }, symptoms: { type: 'text', max: 2000 }, follow_up: { type: 'text', max: 2000 }, clinician_notified: { type: 'bool' },
    }, req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) throw new HttpError(400, 'Enter at least one measurement.');
    assertClientAccess(db, settings, req, base.client_id);
    assertShiftForCaregiver(db, req, base.shift_id, base.client_id);
    const t = now();
    base.measured_at = base.measured_at || t;
    if (base.measured_at > t) throw new HttpError(400, 'Time cannot be in the future.', { measured_at: 'In the future' });
    const created = [];
    const raised = [];
    db.tx(() => {
      for (const it of items) {
        const x = validate({ type_code: { type: 'string', required: true, max: 20 }, value: { type: 'number', required: true }, value2: { type: 'number' }, unit: { type: 'string', max: 20 } }, it);
        const type = db.get('SELECT * FROM measurement_types WHERE code = ? AND active = 1', [x.type_code]);
        if (!type) throw new HttpError(400, `Unknown measurement: ${x.type_code}`);
        if (req.user.role === 'caregiver' && !type.caregiver_may_record) throw new HttpError(403, `${type.name} must be recorded by authorized clinical staff.`);
        if (type.has_second_value && x.value2 == null) throw new HttpError(400, `${type.name} needs both values (e.g. systolic and diastolic).`);
        if (x.value < 0 || (x.value2 != null && x.value2 < 0)) throw new HttpError(400, `${type.name}: value cannot be negative.`);
        const row = { ...base, type_code: x.type_code, value: x.value, value2: type.has_second_value ? x.value2 : null, unit: x.unit || type.unit, recorded_by: req.user.id };
        const id = db.insert('measurements', row);
        created.push(id);
        const alertId = alerts.onMeasurement(db, { ...row, id });
        if (alertId) raised.push(db.get('SELECT id, message, escalation FROM alerts WHERE id = ?', [alertId]));
      }
    });
    audit(db, req, 'create', 'measurement', null, { clientId: base.client_id, note: `${created.length} value(s)` });
    // Escalation instructions are returned so the UI can display them immediately.
    res.status(201).json({ ids: created, alerts: raised });
  });

  r.get('/measurements', (req, res) => {
    const isCg = req.user.role === 'caregiver';
    if (!isCg && !can(req.user, 'health.view')) throw new HttpError(403, 'You do not have permission to do that.');
    const where = ['m.entered_in_error = 0'];
    const p = [];
    if (isCg) { where.push('m.recorded_by = ?'); p.push(req.user.id); }
    if (req.query.client_id) { where.push('m.client_id = ?'); p.push(idParam(req.query.client_id)); }
    if (req.query.type_code) { where.push('m.type_code = ?'); p.push(String(req.query.type_code)); }
    if (req.query.from) { where.push('substr(m.measured_at,1,10) >= ?'); p.push(String(req.query.from)); }
    if (req.query.to) { where.push('substr(m.measured_at,1,10) <= ?'); p.push(String(req.query.to)); }
    res.json(db.all(`SELECT m.*, t.name AS type_name, c.legal_name AS client_name, u.display_name AS recorded_by_name
      FROM measurements m JOIN measurement_types t ON t.code = m.type_code JOIN clients c ON c.id = m.client_id JOIN users u ON u.id = m.recorded_by
      WHERE ${where.join(' AND ')} ORDER BY m.measured_at DESC LIMIT 2000`, p));
  });

  r.post('/measurements/:id/entered-in-error', requirePerm('health.view'), (req, res) => {
    const id = idParam(req.params.id);
    const m = db.get('SELECT client_id FROM measurements WHERE id = ?', [id]);
    if (!m) throw new HttpError(404, 'Not found.');
    const v = validate({ reason: { type: 'text', required: true, max: 500 } }, req.body);
    db.update('measurements', id, { entered_in_error: 1 });
    audit(db, req, 'entered_in_error', 'measurement', id, { clientId: m.client_id, note: v.reason });
    res.json({ ok: true });
  });

  /** Latest / previous value per type with change, and overdue measurements. Missing data is reported, never estimated. */
  r.get('/clients/:id/health-summary', requirePerm('health.view'), (req, res) => {
    const clientId = idParam(req.params.id);
    assertClientAccess(db, settings, req, clientId);
    const today = settings.today();
    const out = [];
    for (const t of db.all('SELECT * FROM measurement_types WHERE active = 1 ORDER BY sort')) {
      const [latest, prev] = db.all(`SELECT * FROM measurements WHERE client_id = ? AND type_code = ? AND entered_in_error = 0 ORDER BY measured_at DESC LIMIT 2`, [clientId, t.code]);
      const th = alerts.thresholdsFor(db, clientId, t.code);
      const item = { code: t.code, name: t.name, unit: t.unit, has_second_value: t.has_second_value, latest: latest || null, previous: prev || null, thresholds: th };
      if (latest && prev) {
        item.change = round2(latest.value - prev.value);
        item.change_pct = prev.value ? round2(((latest.value - prev.value) / prev.value) * 100) : null;
        if (t.has_second_value) item.change2 = round2(latest.value2 - prev.value2);
      }
      if (latest) item.out_of_range = alerts.outOfRange(th, latest.value, latest.value2);
      if (th.expected_every_days) {
        const age = latest ? daysBetween(latest.measured_at.slice(0, 10), today) : null;
        item.overdue = age == null || age > th.expected_every_days;
        item.days_since = age;
        item.expected_every_days = th.expected_every_days;
      }
      out.push(item);
    }
    res.json(out);
  });

  /** All clients with overdue scheduled measurements. */
  r.get('/health/overdue', requirePerm('health.view'), (req, res) => {
    const today = settings.today();
    const out = [];
    for (const c of db.all(`SELECT id, legal_name FROM clients WHERE status = 'active'`)) {
      for (const t of db.all('SELECT code, name FROM measurement_types WHERE active = 1')) {
        const th = alerts.thresholdsFor(db, c.id, t.code);
        if (!th.expected_every_days) continue;
        const last = db.get('SELECT MAX(measured_at) at FROM measurements WHERE client_id = ? AND type_code = ? AND entered_in_error = 0', [c.id, t.code]).at;
        const age = last ? daysBetween(last.slice(0, 10), today) : null;
        if (age == null || age > th.expected_every_days) out.push({ client_id: c.id, client_name: c.legal_name, type: t.name, last: last || null, days_since: age, expected_every_days: th.expected_every_days });
      }
    }
    res.json(out);
  });

  return r;
};
