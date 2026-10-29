'use strict';
// Incidents, alerts and care transitions (hospitalization / hospice).
const express = require('express');
const { HttpError, nowLocal } = require('../lib/util');
const { validate, idParam } = require('../lib/validate');
const { requirePerm, can } = require('../lib/auth');
const { audit, assertClientAccess, assertShiftForCaregiver } = require('../lib/core');
const alerts = require('../lib/alerts');

const TRANSITION_TYPES = ['ed_visit', 'hospital_admission', 'hospital_discharge', 'return_home', 'temporary_absence', 'hospice_referral',
  'hospice_evaluation', 'hospice_admission', 'hospice_discharge', 'facility_discharge', 'deceased', 'care_plan_change'];

/**
 * How each transition affects the client's status fields. Hospitalization and hospice are tracked
 * separately: a referral or hospitalization never marks a client as enrolled in hospice.
 */
const EFFECTS = {
  hospital_admission: { status: 'hospitalized' },
  temporary_absence: { status: 'temporarily_away' },
  hospital_discharge: {}, // discharge from hospital ≠ return; staff record return_home when the client is back
  return_home: { status: 'active' },
  facility_discharge: { status: 'discharged' },
  deceased: { status: 'deceased' },
  hospice_referral: { hospice_status: 'referred' },
  hospice_evaluation: { hospice_status: 'evaluating' },
  hospice_admission: { hospice_status: 'enrolled' },
  hospice_discharge: { hospice_status: 'discharged' },
};

module.exports = ({ db, settings }) => {
  const r = express.Router();
  const now = () => nowLocal(settings.get('timezone'));

  // ================= incidents =================
  r.post('/incidents', requirePerm('incidents.report'), (req, res) => {
    const v = validate({
      client_id: { type: 'id' }, shift_id: { type: 'id' }, occurred_at: { type: 'datetime', required: true },
      type: { type: 'enum', values: ['fall', 'injury', 'medication_discrepancy', 'missed_task', 'sudden_change', 'behavior', 'elopement', 'property', 'other'], required: true },
      severity: { type: 'enum', values: ['low', 'moderate', 'high', 'critical'], required: true },
      description: { type: 'text', required: true, max: 5000 }, immediate_action: { type: 'text', max: 3000 }, notified: { type: 'string', max: 300 },
    }, req.body);
    if (v.occurred_at > now()) throw new HttpError(400, 'Time cannot be in the future.', { occurred_at: 'In the future' });
    if (v.client_id) {
      assertClientAccess(db, settings, req, v.client_id);
      if (req.user.role === 'caregiver' && v.shift_id) assertShiftForCaregiver(db, req, v.shift_id, v.client_id);
    } else if (req.user.role === 'caregiver' && v.shift_id) throw new HttpError(400, 'Select the client involved.');
    const id = db.insert('incidents', { ...v, reported_by: req.user.id, status: 'open' });
    alerts.onIncident(db, { ...v, id });
    audit(db, req, 'create', 'incident', id, { clientId: v.client_id });
    res.status(201).json({ id, emergency_note: ['high', 'critical'].includes(v.severity) ? 'If anyone is in immediate danger, call 911 and follow your emergency procedures.' : null });
  });

  r.get('/incidents', (req, res) => {
    const isCg = req.user.role === 'caregiver';
    if (!isCg && !can(req.user, 'incidents.manage')) throw new HttpError(403, 'You do not have permission to do that.');
    const where = [];
    const p = [];
    if (isCg) { where.push('i.reported_by = ?'); p.push(req.user.id); }
    if (req.query.client_id) { where.push('i.client_id = ?'); p.push(idParam(req.query.client_id)); }
    if (req.query.status) { where.push('i.status = ?'); p.push(String(req.query.status)); }
    if (req.query.severity) { where.push('i.severity = ?'); p.push(String(req.query.severity)); }
    if (req.query.type) { where.push('i.type = ?'); p.push(String(req.query.type)); }
    if (req.query.from) { where.push('substr(i.occurred_at,1,10) >= ?'); p.push(String(req.query.from)); }
    if (req.query.to) { where.push('substr(i.occurred_at,1,10) <= ?'); p.push(String(req.query.to)); }
    res.json(db.all(`SELECT i.*, c.legal_name AS client_name, u.display_name AS reporter, rv.display_name AS reviewer
      FROM incidents i LEFT JOIN clients c ON c.id = i.client_id JOIN users u ON u.id = i.reported_by LEFT JOIN users rv ON rv.id = i.reviewed_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.occurred_at DESC LIMIT 1000`, p));
  });

  r.patch('/incidents/:id', requirePerm('incidents.manage'), (req, res) => {
    const id = idParam(req.params.id);
    const before = db.get('SELECT * FROM incidents WHERE id = ?', [id]);
    if (!before) throw new HttpError(404, 'Incident not found.');
    const v = validate({ status: { type: 'enum', values: ['open', 'under_review', 'closed'] }, follow_up: { type: 'text', max: 5000 }, severity: { type: 'enum', values: ['low', 'moderate', 'high', 'critical'] } }, req.body, { partial: true });
    if (v.status === 'closed' && !(v.follow_up || before.follow_up)) throw new HttpError(400, 'Document the follow-up before closing.', { follow_up: 'Required to close' });
    const row = { ...v, reviewed_by: req.user.id };
    if (v.status === 'closed') row.closed_at = new Date().toISOString();
    db.update('incidents', id, row);
    if (v.status === 'closed') db.run(`UPDATE alerts SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution = 'Incident closed' WHERE source_type = 'incident' AND source_id = ? AND status <> 'resolved'`, [req.user.id, new Date().toISOString(), id]);
    audit(db, req, 'update', 'incident', id, { clientId: before.client_id, before, after: v });
    res.json({ ok: true });
  });

  // ================= alerts =================
  r.get('/alerts', requirePerm('alerts.manage'), (req, res) => {
    alerts.sweep(db, settings);
    const where = [];
    const p = [];
    if (req.query.status === 'unresolved') where.push(`a.status <> 'resolved'`);
    else if (req.query.status) { where.push('a.status = ?'); p.push(String(req.query.status)); }
    if (req.query.client_id) { where.push('a.client_id = ?'); p.push(idParam(req.query.client_id)); }
    if (req.query.severity) { where.push('a.severity = ?'); p.push(String(req.query.severity)); }
    if (req.query.category) { where.push('a.category = ?'); p.push(String(req.query.category)); }
    res.json(db.all(`SELECT a.*, c.legal_name AS client_name, ua.display_name AS acknowledged_by_name, ue.display_name AS escalated_by_name, ur.display_name AS resolved_by_name
      FROM alerts a LEFT JOIN clients c ON c.id = a.client_id LEFT JOIN users ua ON ua.id = a.acknowledged_by
      LEFT JOIN users ue ON ue.id = a.escalated_by LEFT JOIN users ur ON ur.id = a.resolved_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.status = 'resolved', CASE a.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, a.created_at DESC LIMIT 1000`, p));
  });

  r.post('/alerts/:id/:action', requirePerm('alerts.manage'), (req, res) => {
    const id = idParam(req.params.id);
    const a = db.get('SELECT * FROM alerts WHERE id = ?', [id]);
    if (!a) throw new HttpError(404, 'Alert not found.');
    const t = new Date().toISOString();
    const note = validate({ note: { type: 'text', max: 3000 } }, req.body).note;
    switch (req.params.action) {
      case 'acknowledge':
        if (a.status !== 'open') throw new HttpError(400, 'Alert is already acknowledged.');
        db.update('alerts', id, { status: 'acknowledged', acknowledged_by: req.user.id, acknowledged_at: t });
        break;
      case 'escalate':
        if (!note) throw new HttpError(400, 'Describe who was contacted and how.', { note: 'Required' });
        db.update('alerts', id, { status: 'escalated', escalated_by: req.user.id, escalated_at: t, escalation_note: note, acknowledged_by: a.acknowledged_by ?? req.user.id, acknowledged_at: a.acknowledged_at ?? t });
        break;
      case 'resolve':
        if (!note) throw new HttpError(400, 'Document the resolution.', { note: 'Required' });
        db.update('alerts', id, { status: 'resolved', resolved_by: req.user.id, resolved_at: t, resolution: note, acknowledged_by: a.acknowledged_by ?? req.user.id, acknowledged_at: a.acknowledged_at ?? t });
        break;
      default: throw new HttpError(404, 'Not found.');
    }
    audit(db, req, req.params.action, 'alert', id, { clientId: a.client_id });
    res.json({ ok: true });
  });

  // ================= care transitions =================
  r.get('/transitions', requirePerm('transitions.manage', 'clients.view'), (req, res) => {
    const where = [];
    const p = [];
    if (req.query.client_id) { where.push('t.client_id = ?'); p.push(idParam(req.query.client_id)); }
    if (req.query.event_type) { where.push('t.event_type = ?'); p.push(String(req.query.event_type)); }
    if (req.query.follow_up_pending) where.push('t.follow_up_due IS NOT NULL AND t.follow_up_done IS NULL');
    if (req.query.from) { where.push('t.event_date >= ?'); p.push(String(req.query.from)); }
    if (req.query.to) { where.push('t.event_date <= ?'); p.push(String(req.query.to)); }
    res.json(db.all(`SELECT t.*, c.legal_name AS client_name, u.display_name AS created_by_name FROM transitions t JOIN clients c ON c.id = t.client_id
      JOIN users u ON u.id = t.created_by ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.event_date DESC, t.id DESC`, p));
  });

  r.post('/clients/:id/transitions', requirePerm('transitions.manage'), (req, res) => {
    const clientId = idParam(req.params.id);
    assertClientAccess(db, settings, req, clientId);
    const v = validate({
      event_type: { type: 'enum', values: TRANSITION_TYPES, required: true }, event_date: { type: 'date', required: true },
      status: { type: 'string', max: 60 }, location: { type: 'string', max: 200 }, provider: { type: 'string', max: 200 }, contact: { type: 'string', max: 200 },
      source: { type: 'string', required: true, max: 200 }, notes: { type: 'text', max: 4000 }, service_impact: { type: 'text', max: 2000 },
      follow_up_due: { type: 'date' }, cancel_shifts: { type: 'bool' },
    }, req.body);
    if (v.event_type === 'hospice_admission' && !v.provider) throw new HttpError(400, 'Record the hospice provider for an admission.', { provider: 'Required' });
    const { cancel_shifts: cancelShifts, ...row } = v;
    const result = db.tx(() => {
      const id = db.insert('transitions', { ...row, client_id: clientId, created_by: req.user.id });
      const effect = EFFECTS[v.event_type] || {};
      const clientRow = { ...effect, updated_at: new Date().toISOString() };
      if (['facility_discharge', 'deceased'].includes(v.event_type)) clientRow.discharge_date = v.event_date;
      db.update('clients', clientId, clientRow);
      const upcoming = db.all(`SELECT id FROM shifts WHERE client_id = ? AND date >= ? AND status IN ('scheduled','open')`, [clientId, v.event_date]);
      let cancelled = 0;
      if (cancelShifts && ['hospital_admission', 'temporary_absence', 'facility_discharge', 'deceased'].includes(v.event_type)) {
        cancelled = db.run(`UPDATE shifts SET status = 'cancelled', override_reason = ?, updated_at = ? WHERE client_id = ? AND date >= ? AND status IN ('scheduled','open')`,
          [`Client ${v.event_type.replace(/_/g, ' ')} ${v.event_date}`, new Date().toISOString(), clientId, v.event_date]).changes;
      }
      alerts.onTransition(db, { ...row, id, client_id: clientId }, upcoming.length - cancelled);
      return { id, upcoming_shifts: upcoming.length, cancelled_shifts: cancelled };
    });
    audit(db, req, 'create', 'transition', result.id, { clientId, after: { status: EFFECTS[v.event_type]?.status ?? null }, note: v.event_type });
    res.status(201).json(result);
  });

  r.patch('/transitions/:id', requirePerm('transitions.manage'), (req, res) => {
    const id = idParam(req.params.id);
    const t = db.get('SELECT client_id FROM transitions WHERE id = ?', [id]);
    if (!t) throw new HttpError(404, 'Not found.');
    db.update('transitions', id, validate({ follow_up_done: { type: 'date' }, notes: { type: 'text', max: 4000 }, service_impact: { type: 'text', max: 2000 }, follow_up_due: { type: 'date' } }, req.body, { partial: true }));
    audit(db, req, 'update', 'transition', id, { clientId: t.client_id });
    res.json({ ok: true });
  });

  return r;
};
