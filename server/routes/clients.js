'use strict';
const express = require('express');
const { HttpError, addDays } = require('../lib/util');
const { validate, idParam } = require('../lib/validate');
const { requirePerm, can, isStaff } = require('../lib/auth');
const { audit, assertClientAccess, caregiverClientIds, addVersionedRate } = require('../lib/core');
const { computeTrend } = require('../lib/trends');
const { timeline, periodSummary } = require('../lib/timeline');

const STATUSES = ['active', 'hospitalized', 'temporarily_away', 'discharged', 'deceased', 'other'];
const CLIENT_SCHEMA = {
  code: { type: 'string', max: 30 },
  legal_name: { type: 'string', required: true, max: 120 },
  preferred_name: { type: 'string', max: 80 },
  dob: { type: 'date' },
  address: { type: 'string', max: 300 },
  facility_id: { type: 'id' },
  room: { type: 'string', max: 30 },
  phone: { type: 'string', max: 40 },
  email: { type: 'email' },
  allergies: { type: 'text', max: 1000 },
  alerts: { type: 'text', max: 1000 },
  diet: { type: 'text', max: 1000 },
  pcp_name: { type: 'string', max: 120 },
  pcp_phone: { type: 'string', max: 40 },
  admission_date: { type: 'date' },
  discharge_date: { type: 'date' },
  status: { type: 'enum', values: STATUSES, default: 'active' },
  consent_notes: { type: 'text', max: 2000 },
  contact_preferences: { type: 'text', max: 1000 },
  min_fluid_ml: { type: 'int', min: 0, max: 6000 },
};
// Fields a caregiver may see for an assigned client.
const CAREGIVER_FIELDS = ['id', 'code', 'legal_name', 'preferred_name', 'room', 'facility_name', 'address', 'allergies', 'alerts', 'diet', 'status', 'hospice_status', 'min_fluid_ml'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

const CONTACT_SCHEMA = {
  kind: { type: 'enum', values: ['emergency', 'representative', 'care_team', 'family', 'other'], required: true },
  name: { type: 'string', required: true, max: 120 }, relationship: { type: 'string', max: 80 },
  phone: { type: 'string', max: 40 }, email: { type: 'email' }, is_decision_maker: { type: 'bool' }, notes: { type: 'text', max: 1000 },
};
const PLAN_SCHEMA = {
  effective_date: { type: 'date', required: true }, review_due: { type: 'date' }, summary: { type: 'text', max: 3000 },
  goals: { type: 'text' }, instructions: { type: 'text' }, adl_tasks: { type: 'text', max: 3000 }, mobility: { type: 'text', max: 2000 },
  diet: { type: 'text', max: 2000 }, behavior_support: { type: 'text', max: 3000 }, requires_ack: { type: 'bool', default: 1 },
};

module.exports = ({ db, settings }) => {
  const r = express.Router();
  const manage = requirePerm('clients.manage');
  const access = (req, id) => assertClientAccess(db, settings, req, id);

  r.get('/clients', (req, res) => {
    const where = [];
    const p = [];
    if (req.user.role === 'caregiver') {
      const ids = [...caregiverClientIds(db, req.user.caregiver_id, settings.today())];
      if (!ids.length) return res.json([]);
      where.push(`c.id IN (${ids.map(() => '?').join(',')})`);
      p.push(...ids);
    } else if (!can(req.user, 'clients.view')) throw new HttpError(403, 'You do not have permission to do that.');
    if (req.query.q) { where.push('(c.legal_name LIKE ? OR c.preferred_name LIKE ? OR c.code LIKE ?)'); const q = `%${req.query.q}%`; p.push(q, q, q); }
    if (req.query.status) { where.push('c.status = ?'); p.push(String(req.query.status)); }
    if (req.query.hospice_status) { where.push('c.hospice_status = ?'); p.push(String(req.query.hospice_status)); }
    if (req.query.facility_id) { where.push('c.facility_id = ?'); p.push(idParam(req.query.facility_id)); }
    if (req.query.category_id) { where.push('EXISTS (SELECT 1 FROM client_category_links l WHERE l.client_id = c.id AND l.category_id = ?)'); p.push(idParam(req.query.category_id)); }
    const rows = db.all(`SELECT c.*, f.name AS facility_name,
        (SELECT COUNT(*) FROM alerts a WHERE a.client_id = c.id AND a.status <> 'resolved') AS open_alerts,
        (SELECT group_concat(cc.name, ', ') FROM client_category_links l JOIN client_categories cc ON cc.id = l.category_id WHERE l.client_id = c.id) AS categories
      FROM clients c LEFT JOIN facilities f ON f.id = c.facility_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.legal_name`, p);
    res.json(req.user.role === 'caregiver' ? rows.map((c) => pick(c, CAREGIVER_FIELDS)) : rows);
  });

  r.post('/clients', manage, (req, res) => {
    const v = validate(CLIENT_SCHEMA, req.body);
    const id = db.tx(() => {
      if (!v.code) {
        const n = db.get('SELECT COUNT(*) n FROM clients').n + 1;
        v.code = `CL-${String(n).padStart(4, '0')}`;
        while (db.get('SELECT 1 FROM clients WHERE code = ?', [v.code])) v.code = `CL-${String(Number(v.code.slice(3)) + 1).padStart(4, '0')}`;
      }
      const newId = db.insert('clients', v);
      if (Array.isArray(req.body.category_ids)) setCategories(newId, req.body.category_ids);
      return newId;
    });
    audit(db, req, 'create', 'client', id, { clientId: id });
    res.status(201).json({ id, code: v.code });
  });

  r.get('/clients/:id', (req, res) => {
    const id = idParam(req.params.id);
    access(req, id);
    const c = db.get('SELECT c.*, f.name AS facility_name FROM clients c LEFT JOIN facilities f ON f.id = c.facility_id WHERE c.id = ?', [id]);
    const plan = db.get(`SELECT * FROM care_plans WHERE client_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1`, [id]);
    audit(db, req, 'view', 'client', id, { clientId: id });
    if (req.user.role === 'caregiver') {
      const acked = plan ? !!db.get('SELECT 1 FROM care_plan_acks WHERE care_plan_id = ? AND caregiver_id = ?', [plan.id, req.user.caregiver_id]) : true;
      return res.json({
        ...pick(c, CAREGIVER_FIELDS),
        contacts: db.all(`SELECT name, relationship, phone, kind FROM client_contacts WHERE client_id = ? AND kind IN ('emergency','representative')`, [id]),
        care_plan: plan ? { ...plan, acknowledged: acked } : null,
      });
    }
    res.json({
      ...c,
      contacts: db.all('SELECT * FROM client_contacts WHERE client_id = ? ORDER BY kind, name', [id]),
      category_ids: db.all('SELECT category_id FROM client_category_links WHERE client_id = ?', [id]).map((x) => x.category_id),
      services: db.all(`SELECT cs.*, st.name AS service_name, st.code AS service_code FROM client_services cs JOIN service_types st ON st.id = cs.service_type_id
        WHERE cs.client_id = ? ORDER BY st.name, cs.effective_from DESC`, [id]),
      care_plan: plan || null,
      assignments: db.all(`SELECT a.*, cg.full_name AS caregiver_name FROM assignments a JOIN caregivers cg ON cg.id = a.caregiver_id
        WHERE a.client_id = ? ORDER BY a.status = 'active' DESC, a.start_date DESC`, [id]),
      reconciled_by_name: c.meds_reconciled_by ? db.get('SELECT display_name FROM users WHERE id = ?', [c.meds_reconciled_by])?.display_name : null,
    });
  });

  r.patch('/clients/:id', manage, (req, res) => {
    const id = idParam(req.params.id);
    const before = db.get('SELECT * FROM clients WHERE id = ?', [id]);
    if (!before) throw new HttpError(404, 'Client not found.');
    const v = validate(CLIENT_SCHEMA, req.body, { partial: true });
    delete v.code; // client IDs are permanent
    db.tx(() => {
      db.update('clients', id, { ...v, updated_at: new Date().toISOString() });
      if (Array.isArray(req.body.category_ids)) setCategories(id, req.body.category_ids);
    });
    audit(db, req, 'update', 'client', id, { clientId: id, before, after: v });
    res.json({ ok: true });
  });

  function setCategories(clientId, ids) {
    db.run('DELETE FROM client_category_links WHERE client_id = ?', [clientId]);
    for (const cid of ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)) {
      db.run('INSERT OR IGNORE INTO client_category_links (client_id, category_id) VALUES (?, ?)', [clientId, cid]);
    }
  }

  // ----- contacts -----
  r.post('/clients/:id/contacts', manage, (req, res) => {
    const clientId = idParam(req.params.id);
    access(req, clientId);
    const cid = db.insert('client_contacts', { client_id: clientId, ...validate(CONTACT_SCHEMA, req.body) });
    audit(db, req, 'create', 'client_contact', cid, { clientId });
    res.status(201).json({ id: cid });
  });
  r.patch('/client-contacts/:id', manage, (req, res) => {
    const id = idParam(req.params.id);
    const row = db.get('SELECT client_id FROM client_contacts WHERE id = ?', [id]);
    if (!row) throw new HttpError(404, 'Contact not found.');
    db.update('client_contacts', id, validate(CONTACT_SCHEMA, req.body, { partial: true }));
    audit(db, req, 'update', 'client_contact', id, { clientId: row.client_id });
    res.json({ ok: true });
  });
  r.delete('/client-contacts/:id', manage, (req, res) => {
    const id = idParam(req.params.id);
    const row = db.get('SELECT client_id FROM client_contacts WHERE id = ?', [id]);
    if (!row) throw new HttpError(404, 'Contact not found.');
    db.run('DELETE FROM client_contacts WHERE id = ?', [id]);
    audit(db, req, 'delete', 'client_contact', id, { clientId: row.client_id });
    res.json({ ok: true });
  });

  // ----- services & billing rates (versioned) -----
  r.post('/clients/:id/services', manage, (req, res) => {
    const clientId = idParam(req.params.id);
    access(req, clientId);
    const v = validate({
      service_type_id: { type: 'id', required: true }, effective_from: { type: 'date', required: true },
      frequency: { type: 'string', max: 120 }, instructions: { type: 'text', max: 3000 }, responsible: { type: 'string', max: 120 },
      bill_method: { type: 'enum', values: ['hourly', 'per_visit', 'daily', 'monthly', 'not_billed'], default: 'hourly' },
      bill_rate: { type: 'money', min: 0, default: 0 },
    }, req.body);
    const id = db.tx(() => addVersionedRate(db, {
      table: 'client_services', whereSql: 'client_id = ? AND service_type_id = ?', whereParams: [clientId, v.service_type_id], from: v.effective_from,
      row: { client_id: clientId, service_type_id: v.service_type_id, frequency: v.frequency, instructions: v.instructions, responsible: v.responsible, bill_method: v.bill_method, bill_rate_cents: v.bill_rate, created_by: req.user.id },
    }));
    audit(db, req, 'create', 'client_service', id, { clientId, after: { bill_rate_cents: v.bill_rate, bill_method: v.bill_method, effective_from: v.effective_from } });
    res.status(201).json({ id });
  });
  r.patch('/client-services/:id', manage, (req, res) => {
    const id = idParam(req.params.id);
    const before = db.get('SELECT * FROM client_services WHERE id = ?', [id]);
    if (!before) throw new HttpError(404, 'Service not found.');
    // Rates are never edited in place; only descriptive fields and the end date.
    const v = validate({ effective_to: { type: 'date' }, frequency: { type: 'string', max: 120 }, instructions: { type: 'text', max: 3000 }, responsible: { type: 'string', max: 120 } }, req.body, { partial: true });
    if (v.effective_to && v.effective_to < before.effective_from) throw new HttpError(400, 'End date is before the start date.');
    db.update('client_services', id, v);
    audit(db, req, 'update', 'client_service', id, { clientId: before.client_id, before, after: v });
    res.json({ ok: true });
  });

  // ----- care plans (versioned) -----
  r.get('/clients/:id/care-plans', (req, res) => {
    const id = idParam(req.params.id);
    access(req, id);
    if (!isStaff(req.user)) return res.json(db.all(`SELECT * FROM care_plans WHERE client_id = ? AND status = 'active'`, [id]));
    res.json(db.all(`SELECT p.*, u.display_name AS author,
        (SELECT COUNT(*) FROM care_plan_acks a WHERE a.care_plan_id = p.id) AS ack_count
      FROM care_plans p LEFT JOIN users u ON u.id = p.created_by WHERE p.client_id = ? ORDER BY p.version DESC`, [id]));
  });
  r.post('/clients/:id/care-plans', requirePerm('careplan.manage'), (req, res) => {
    const clientId = idParam(req.params.id);
    access(req, clientId);
    const v = validate(PLAN_SCHEMA, req.body);
    const id = db.tx(() => {
      const version = (db.get('SELECT MAX(version) v FROM care_plans WHERE client_id = ?', [clientId]).v || 0) + 1;
      db.run(`UPDATE care_plans SET status = 'superseded' WHERE client_id = ? AND status = 'active'`, [clientId]);
      return db.insert('care_plans', { ...v, client_id: clientId, version, status: 'active', created_by: req.user.id });
    });
    audit(db, req, 'create', 'care_plan', id, { clientId });
    res.status(201).json({ id });
  });
  r.post('/care-plans/:id/ack', requirePerm('portal'), (req, res) => {
    const id = idParam(req.params.id);
    const plan = db.get('SELECT * FROM care_plans WHERE id = ?', [id]);
    if (!plan) throw new HttpError(404, 'Care plan not found.');
    access(req, plan.client_id);
    db.run('INSERT OR IGNORE INTO care_plan_acks (care_plan_id, caregiver_id, acknowledged_at) VALUES (?,?,?)', [id, req.user.caregiver_id, new Date().toISOString()]);
    audit(db, req, 'acknowledge', 'care_plan', id, { clientId: plan.client_id });
    res.json({ ok: true });
  });
  r.get('/care-plans/:id/acks', requirePerm('clients.view'), (req, res) => {
    res.json(db.all(`SELECT a.*, c.full_name FROM care_plan_acks a JOIN caregivers c ON c.id = a.caregiver_id WHERE a.care_plan_id = ?`, [idParam(req.params.id)]));
  });

  // ----- measurement thresholds (individualized) -----
  r.get('/clients/:id/thresholds', (req, res) => {
    const id = idParam(req.params.id);
    access(req, id);
    res.json(db.all(`SELECT t.code, t.name, t.unit, t.has_second_value, t.default_low, t.default_high, t.default_low2, t.default_high2,
        ct.low, ct.high, ct.low2, ct.high2, ct.escalation, ct.approved_by, ct.expected_every_days, ct.set_at
      FROM measurement_types t LEFT JOIN client_thresholds ct ON ct.type_code = t.code AND ct.client_id = ? WHERE t.active = 1 ORDER BY t.sort`, [id]));
  });
  r.put('/clients/:id/thresholds/:code', requirePerm('thresholds.manage'), (req, res) => {
    const clientId = idParam(req.params.id);
    access(req, clientId);
    if (!db.get('SELECT 1 FROM measurement_types WHERE code = ?', [req.params.code])) throw new HttpError(404, 'Unknown measurement.');
    const v = validate({
      low: { type: 'number' }, high: { type: 'number' }, low2: { type: 'number' }, high2: { type: 'number' },
      expected_every_days: { type: 'int', min: 1, max: 365 }, escalation: { type: 'text', max: 2000 }, approved_by: { type: 'string', required: true, max: 120 },
    }, req.body);
    db.run(`INSERT INTO client_thresholds (client_id, type_code, low, high, low2, high2, expected_every_days, escalation, approved_by, set_by, set_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id, type_code) DO UPDATE SET low=excluded.low, high=excluded.high, low2=excluded.low2,
      high2=excluded.high2, expected_every_days=excluded.expected_every_days, escalation=excluded.escalation, approved_by=excluded.approved_by,
      set_by=excluded.set_by, set_at=excluded.set_at`,
    [clientId, req.params.code, v.low, v.high, v.low2, v.high2, v.expected_every_days, v.escalation, v.approved_by, req.user.id, new Date().toISOString()]);
    audit(db, req, 'update', 'client_threshold', null, { clientId, note: req.params.code });
    res.json({ ok: true });
  });

  // ----- progress overview -----
  r.get('/clients/:id/progress', requirePerm('progress.review', 'reports.clinical'), (req, res) => {
    const id = idParam(req.params.id);
    access(req, id);
    const today = settings.today();
    const to = req.query.to || today;
    const from = req.query.from || addDays(to, -29);
    const trend = computeTrend(db, settings, id, to);
    res.json({
      trend,
      comparison: {
        last7: periodSummary(db, id, addDays(to, -6), to),
        prior7: periodSummary(db, id, addDays(to, -13), addDays(to, -7)),
        last30: periodSummary(db, id, addDays(to, -29), to),
        selected: periodSummary(db, id, from, to),
      },
      timeline: timeline(db, id, from, to),
      reviews: db.all(`SELECT r.*, u.display_name AS author FROM progress_reviews r JOIN users u ON u.id = r.author_id WHERE r.client_id = ? ORDER BY r.created_at DESC`, [id]),
      alerts: db.all(`SELECT * FROM alerts WHERE client_id = ? AND status <> 'resolved' ORDER BY created_at DESC`, [id]),
    });
  });
  r.post('/clients/:id/reviews', requirePerm('progress.review'), (req, res) => {
    const clientId = idParam(req.params.id);
    access(req, clientId);
    const v = validate({
      period_from: { type: 'date' }, period_to: { type: 'date' },
      assessment: { type: 'enum', values: ['improving', 'stable', 'possible_decline', 'requires_review'], required: true },
      summary: { type: 'text', required: true, max: 5000 }, action_taken: { type: 'text', max: 3000 },
    }, req.body);
    const id = db.insert('progress_reviews', { ...v, client_id: clientId, author_id: req.user.id });
    audit(db, req, 'create', 'progress_review', id, { clientId });
    res.status(201).json({ id });
  });
  r.patch('/progress-reviews/:id', requirePerm('progress.review'), (req, res) => {
    const id = idParam(req.params.id);
    const row = db.get('SELECT client_id FROM progress_reviews WHERE id = ?', [id]);
    if (!row) throw new HttpError(404, 'Review not found.');
    db.update('progress_reviews', id, validate({ action_taken: { type: 'text', max: 3000 }, concern_resolved_at: { type: 'date' } }, req.body, { partial: true }));
    audit(db, req, 'update', 'progress_review', id, { clientId: row.client_id });
    res.json({ ok: true });
  });

  return r;
};
