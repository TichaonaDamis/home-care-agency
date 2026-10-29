'use strict';
const express = require('express');
const { HttpError, nowLocal, addDays } = require('../lib/util');
const { validate, idParam } = require('../lib/validate');
const { requirePerm, can } = require('../lib/auth');
const { audit, assertClientAccess, assertShiftForCaregiver } = require('../lib/core');
const alerts = require('../lib/alerts');
const { periodSummary, timeline } = require('../lib/timeline');

const MED_SCHEMA = {
  name: { type: 'string', required: true, max: 150 }, strength: { type: 'string', max: 60 }, form: { type: 'string', max: 60 },
  dose: { type: 'string', max: 100 }, route: { type: 'string', max: 60 }, frequency: { type: 'string', max: 100 },
  times: { type: 'string', max: 100 }, prn: { type: 'bool' }, prescriber: { type: 'string', max: 120 }, pharmacy: { type: 'string', max: 120 },
  start_date: { type: 'date' }, stop_date: { type: 'date' }, instructions: { type: 'text', max: 3000 }, precautions: { type: 'text', max: 3000 },
  order_source: { type: 'string', max: 200 },
};
// Which order fields map to which change type when edited.
const CHANGE_FIELDS = { dose: 'dose_change', strength: 'dose_change', frequency: 'frequency_change', times: 'frequency_change', route: 'route_change', instructions: 'instructions_updated', precautions: 'instructions_updated', prescriber: 'instructions_updated', pharmacy: 'instructions_updated' };
const ACTIONS_BY_AUTHORITY = {
  none: ['refused', 'discrepancy'],
  assist: ['assisted', 'refused', 'omitted', 'held', 'discrepancy'],
  administer: ['administered', 'assisted', 'refused', 'omitted', 'held', 'discrepancy'],
};

function validTimes(t) {
  if (!t) return null;
  const parts = t.split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.every((x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x))) throw new HttpError(400, 'Times must be HH:MM, separated by commas (e.g. 08:00, 20:00).', { times: 'Invalid' });
  return parts.join(',');
}

module.exports = ({ db, settings }) => {
  const r = express.Router();
  const manage = requirePerm('meds.manage');
  const now = () => nowLocal(settings.get('timezone'));
  const access = (req, id) => assertClientAccess(db, settings, req, id);

  r.get('/clients/:id/medications', (req, res) => {
    const id = idParam(req.params.id);
    access(req, id);
    if (req.user.role !== 'caregiver' && !can(req.user, 'meds.view')) throw new HttpError(403, 'You do not have permission to do that.');
    const meds = db.all(`SELECT * FROM medications WHERE client_id = ? ORDER BY status = 'active' DESC, name`, [id]);
    if (req.user.role === 'caregiver') return res.json(meds.filter((m) => m.status === 'active'));
    res.json(meds);
  });

  r.get('/medications', requirePerm('meds.view'), (req, res) => {
    const where = [];
    const p = [];
    if (req.query.status) { where.push('m.status = ?'); p.push(String(req.query.status)); }
    if (req.query.client_id) { where.push('m.client_id = ?'); p.push(idParam(req.query.client_id)); }
    res.json(db.all(`SELECT m.*, c.legal_name AS client_name, c.meds_reconciled_on FROM medications m JOIN clients c ON c.id = m.client_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.legal_name, m.name`, p));
  });

  r.post('/clients/:id/medications', manage, (req, res) => {
    const clientId = idParam(req.params.id);
    access(req, clientId);
    const v = validate(MED_SCHEMA, req.body);
    v.times = validTimes(v.times);
    const change = validate({ verified: { type: 'bool' }, follow_up: { type: 'text', max: 2000 } }, req.body);
    const id = db.tx(() => {
      const mid = db.insert('medications', { ...v, client_id: clientId, status: 'active', created_by: req.user.id });
      db.insert('medication_changes', {
        medication_id: mid, client_id: clientId, change_type: 'started', effective_date: v.start_date || settings.today(),
        new_value: [v.strength, v.dose, v.route, v.frequency].filter(Boolean).join(' '), order_source: v.order_source,
        documented_by: req.user.id, verified: change.verified, verified_by: change.verified ? req.user.id : null,
        verified_at: change.verified ? new Date().toISOString() : null, follow_up: change.follow_up,
      });
      return mid;
    });
    audit(db, req, 'create', 'medication', id, { clientId });
    res.status(201).json({ id });
  });

  /** Order changes always go through here and are recorded in medication_changes. */
  r.patch('/medications/:id', manage, (req, res) => {
    const id = idParam(req.params.id);
    const before = db.get('SELECT * FROM medications WHERE id = ?', [id]);
    if (!before) throw new HttpError(404, 'Medication not found.');
    const v = validate({ ...MED_SCHEMA, name: { type: 'string', max: 150 }, status: { type: 'enum', values: ['active', 'on_hold', 'discontinued'] } }, req.body, { partial: true });
    if ('times' in v) v.times = validTimes(v.times);
    const meta = validate({ effective_date: { type: 'date', required: true }, details: { type: 'text', max: 2000 }, verified: { type: 'bool' }, follow_up: { type: 'text', max: 2000 }, order_source: { type: 'string', max: 200 } }, req.body);
    const changed = Object.keys(v).filter((k) => (v[k] ?? null) !== (before[k] ?? null));
    if (!changed.length) return res.json({ ok: true, changes: 0 });
    const types = new Set();
    for (const k of changed) {
      if (k === 'status') types.add(v.status === 'discontinued' ? 'discontinued' : v.status === 'on_hold' ? 'held' : 'resumed');
      else if (CHANGE_FIELDS[k]) types.add(CHANGE_FIELDS[k]);
      else types.add('other');
    }
    db.tx(() => {
      const row = { ...v, updated_at: new Date().toISOString() };
      if (v.status === 'discontinued' && !v.stop_date && !before.stop_date) row.stop_date = meta.effective_date;
      db.update('medications', id, row);
      for (const t of types) {
        const fields = changed.filter((k) => (k === 'status' ? ['discontinued', 'held', 'resumed'].includes(t) : (CHANGE_FIELDS[k] || 'other') === t));
        db.insert('medication_changes', {
          medication_id: id, client_id: before.client_id, change_type: t, effective_date: meta.effective_date,
          previous_value: fields.map((k) => `${k}: ${before[k] ?? '—'}`).join('; '), new_value: fields.map((k) => `${k}: ${v[k] ?? '—'}`).join('; '),
          details: meta.details, order_source: meta.order_source || v.order_source || before.order_source, documented_by: req.user.id,
          verified: meta.verified, verified_by: meta.verified ? req.user.id : null, verified_at: meta.verified ? new Date().toISOString() : null, follow_up: meta.follow_up,
        });
      }
    });
    audit(db, req, 'update', 'medication', id, { clientId: before.client_id, before, after: v });
    res.json({ ok: true, changes: types.size });
  });

  r.get('/medication-changes', requirePerm('meds.view'), (req, res) => {
    const where = [];
    const p = [];
    if (req.query.client_id) { where.push('mc.client_id = ?'); p.push(idParam(req.query.client_id)); }
    if (req.query.review_status) { where.push('mc.review_status = ?'); p.push(String(req.query.review_status)); }
    if (req.query.unverified) where.push('mc.verified = 0');
    if (req.query.from) { where.push('mc.effective_date >= ?'); p.push(String(req.query.from)); }
    if (req.query.to) { where.push('mc.effective_date <= ?'); p.push(String(req.query.to)); }
    res.json(db.all(`SELECT mc.*, m.name AS medication_name, c.legal_name AS client_name, u.display_name AS documented_by_name, v.display_name AS verified_by_name
      FROM medication_changes mc JOIN medications m ON m.id = mc.medication_id JOIN clients c ON c.id = mc.client_id
      JOIN users u ON u.id = mc.documented_by LEFT JOIN users v ON v.id = mc.verified_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY mc.effective_date DESC, mc.id DESC`, p));
  });

  r.post('/medication-changes/:id/verify', requirePerm('meds.verify'), (req, res) => {
    const id = idParam(req.params.id);
    const c = db.get('SELECT * FROM medication_changes WHERE id = ?', [id]);
    if (!c) throw new HttpError(404, 'Change not found.');
    db.update('medication_changes', id, { verified: 1, verified_by: req.user.id, verified_at: new Date().toISOString() });
    audit(db, req, 'verify', 'medication_change', id, { clientId: c.client_id });
    res.json({ ok: true });
  });
  r.patch('/medication-changes/:id', requirePerm('meds.verify'), (req, res) => {
    const id = idParam(req.params.id);
    const c = db.get('SELECT * FROM medication_changes WHERE id = ?', [id]);
    if (!c) throw new HttpError(404, 'Change not found.');
    const v = validate({ review_status: { type: 'enum', values: ['pending', 'in_review', 'closed'] }, follow_up: { type: 'text', max: 2000 } }, req.body, { partial: true });
    db.update('medication_changes', id, v);
    audit(db, req, 'update', 'medication_change', id, { clientId: c.client_id, after: v });
    res.json({ ok: true });
  });

  /**
   * Before/after review of a medication change: documented observations in equal windows either side.
   * Presents temporal association only.
   */
  r.get('/medication-changes/:id/compare', requirePerm('meds.view'), (req, res) => {
    const c = db.get(`SELECT mc.*, m.name AS medication_name FROM medication_changes mc JOIN medications m ON m.id = mc.medication_id WHERE mc.id = ?`, [idParam(req.params.id)]);
    if (!c) throw new HttpError(404, 'Change not found.');
    const days = Math.min(Math.max(Number(req.query.days) || 14, 3), 90);
    const beforeFrom = addDays(c.effective_date, -days);
    const beforeTo = addDays(c.effective_date, -1);
    const afterTo = addDays(c.effective_date, days - 1);
    const otherChanges = db.all(`SELECT mc.change_type, mc.effective_date, m.name FROM medication_changes mc JOIN medications m ON m.id = mc.medication_id
      WHERE mc.client_id = ? AND mc.id <> ? AND mc.effective_date BETWEEN ? AND ?`, [c.client_id, c.id, beforeFrom, afterTo]);
    const otherEvents = db.all(`SELECT event_type, event_date FROM transitions WHERE client_id = ? AND event_date BETWEEN ? AND ?`, [c.client_id, beforeFrom, afterTo]);
    res.json({
      change: c, days,
      before: periodSummary(db, c.client_id, beforeFrom, beforeTo),
      after: periodSummary(db, c.client_id, c.effective_date, afterTo),
      after_timeline: timeline(db, c.client_id, c.effective_date, afterTo, { limit: 200 }),
      confounders: { other_medication_changes: otherChanges, care_transitions: otherEvents },
      disclaimer: 'This view shows documented observations before and after the change date. A temporal association does not mean the medication caused any change. Clinical evaluation is required.',
    });
  });

  r.post('/clients/:id/reconcile-medications', requirePerm('meds.verify'), (req, res) => {
    const id = idParam(req.params.id);
    access(req, id);
    const v = validate({ date: { type: 'date', required: true } }, req.body);
    db.update('clients', id, { meds_reconciled_on: v.date, meds_reconciled_by: req.user.id });
    audit(db, req, 'reconcile', 'medication_list', id, { clientId: id });
    res.json({ ok: true });
  });

  // ----- administration / assistance records -----
  r.post('/med-events', requirePerm('meds.document'), (req, res) => {
    const v = validate({
      medication_id: { type: 'id', required: true }, shift_id: { type: 'id' }, scheduled_for: { type: 'datetime' },
      action: { type: 'enum', values: ['administered', 'assisted', 'refused', 'omitted', 'held', 'discrepancy'], required: true },
      actual_time: { type: 'datetime' }, dose_given: { type: 'string', max: 100 }, notes: { type: 'text', max: 2000 }, adverse_observation: { type: 'text', max: 2000 },
    }, req.body);
    const med = db.get('SELECT * FROM medications WHERE id = ?', [v.medication_id]);
    if (!med) throw new HttpError(404, 'Medication not found.');
    assertClientAccess(db, settings, req, med.client_id);
    assertShiftForCaregiver(db, req, v.shift_id, med.client_id);
    if (req.user.role === 'caregiver') {
      const auth = db.get('SELECT med_authority FROM caregivers WHERE id = ?', [req.user.caregiver_id]).med_authority;
      if (!ACTIONS_BY_AUTHORITY[auth].includes(v.action)) {
        throw new HttpError(403, `Your medication role (${auth}) does not permit recording "${v.action}". Report a discrepancy or contact your supervisor.`);
      }
    }
    if (med.status !== 'active' && v.action !== 'discrepancy') throw new HttpError(400, 'This medication is not active. Record a discrepancy if a dose was found or given.');
    if (['refused', 'omitted', 'held', 'discrepancy'].includes(v.action) && !v.notes) throw new HttpError(400, 'Add a note describing what happened.', { notes: 'Required' });
    const t = now();
    if (['administered', 'assisted'].includes(v.action)) v.actual_time = v.actual_time || t;
    if (v.actual_time && v.actual_time > t) throw new HttpError(400, 'Time cannot be in the future.');
    const id = db.insert('med_events', { ...v, client_id: med.client_id, author_id: req.user.id });
    alerts.onMedEvent(db, { ...v, id, client_id: med.client_id }, med.name);
    audit(db, req, 'create', 'med_event', id, { clientId: med.client_id, after: { status: v.action } });
    res.status(201).json({ id });
  });

  r.get('/med-events', (req, res) => {
    const isCg = req.user.role === 'caregiver';
    if (!isCg && !can(req.user, 'meds.view')) throw new HttpError(403, 'You do not have permission to do that.');
    const where = [];
    const p = [];
    if (isCg) { where.push('e.author_id = ?'); p.push(req.user.id); }
    if (req.query.client_id) { where.push('e.client_id = ?'); p.push(idParam(req.query.client_id)); }
    if (req.query.action) { where.push('e.action = ?'); p.push(String(req.query.action)); }
    if (req.query.from) { where.push('substr(e.created_at,1,10) >= ?'); p.push(String(req.query.from)); }
    if (req.query.to) { where.push('substr(e.created_at,1,10) <= ?'); p.push(String(req.query.to)); }
    res.json(db.all(`SELECT e.*, m.name AS medication_name, m.dose, c.legal_name AS client_name, u.display_name AS author
      FROM med_events e JOIN medications m ON m.id = e.medication_id JOIN clients c ON c.id = e.client_id JOIN users u ON u.id = e.author_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.created_at DESC LIMIT 1000`, p));
  });

  return r;
};
