'use strict';
const express = require('express');
const { HttpError, addDays, dayOfWeek, nowLocal, workedHours, schedHours, round2, minutesBetween, daysBetween } = require('../lib/util');
const { validate, idParam } = require('../lib/validate');
const { requirePerm, can } = require('../lib/auth');
const { audit, rateSnapshot, caregiverClientIds } = require('../lib/core');
const { scheduleWarnings, outstandingDocs, clockInOffset } = require('../lib/shiftdocs');

const ASSIGN_SCHEMA = {
  caregiver_id: { type: 'id', required: true },
  client_id: { type: 'id', required: true },
  facility_id: { type: 'id' },
  service_type_id: { type: 'id' },
  start_date: { type: 'date', required: true },
  end_date: { type: 'date' },
  days_of_week: { type: 'list', of: { type: 'int', min: 0, max: 6 }, required: true },
  shift_start: { type: 'time', required: true },
  shift_end: { type: 'time', required: true },
  responsibilities: { type: 'text', max: 2000 },
  pay_rate: { type: 'money', min: 0 },
  bill_rate: { type: 'money', min: 0 },
  override_reason: { type: 'text', max: 1000 },
};
const SHIFT_SCHEMA = {
  caregiver_id: { type: 'id' },
  client_id: { type: 'id', required: true },
  facility_id: { type: 'id' },
  service_type_id: { type: 'id' },
  date: { type: 'date', required: true },
  sched_start: { type: 'time', required: true },
  sched_end: { type: 'time', required: true },
  notes: { type: 'text', max: 2000 },
  override_reason: { type: 'text', max: 1000 },
};

module.exports = ({ db, settings }) => {
  const r = express.Router();
  const manage = requirePerm('schedule.manage');
  const now = () => nowLocal(settings.get('timezone'));

  const getShift = (id) => {
    const s = db.get('SELECT * FROM shifts WHERE id = ?', [id]);
    if (!s) throw new HttpError(404, 'Shift not found.');
    return s;
  };
  const ownShift = (req, s) => {
    if (req.user.role !== 'caregiver') return;
    if (s.caregiver_id !== req.user.caregiver_id) throw new HttpError(403, 'That shift is not yours.');
  };
  /** Shift has been paid or billed — time and rates must not change. */
  const lockedReason = (shiftId) => {
    const inv = db.get(`SELECT i.number FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE ii.shift_id = ? AND i.status <> 'void'`, [shiftId]);
    if (inv) return `it is on invoice ${inv.number}`;
    const run = db.all(`SELECT r.id, pi.shift_ids FROM payroll_runs r JOIN payroll_items pi ON pi.run_id = r.id WHERE r.status IN ('approved','processed')`)
      .find((x) => JSON.parse(x.shift_ids).includes(shiftId));
    return run ? `it is in approved payroll run #${run.id}` : null;
  };
  const requireOverride = (req, warnings, reason) => {
    if (!warnings.length) return;
    if (!reason || reason.length < 5) throw new HttpError(409, 'Scheduling warnings must be reviewed. Enter an override reason to proceed.', { warnings });
    if (!can(req.user, 'schedule.manage')) throw new HttpError(403, 'Only a scheduler can override warnings.');
  };

  // ================= assignments =================
  r.get('/assignments', requirePerm('schedule.view'), (req, res) => {
    const where = [];
    const p = [];
    for (const k of ['caregiver_id', 'client_id', 'facility_id']) if (req.query[k]) { where.push(`a.${k} = ?`); p.push(idParam(req.query[k])); }
    if (req.query.status) { where.push('a.status = ?'); p.push(String(req.query.status)); }
    if (req.query.active_on) { where.push('a.start_date <= ? AND (a.end_date IS NULL OR a.end_date >= ?)'); p.push(req.query.active_on, req.query.active_on); }
    const rows = db.all(`SELECT a.*, cg.full_name AS caregiver_name, cl.legal_name AS client_name, st.name AS service_name, u.display_name AS approved_by_name
      FROM assignments a JOIN caregivers cg ON cg.id = a.caregiver_id JOIN clients cl ON cl.id = a.client_id
      LEFT JOIN service_types st ON st.id = a.service_type_id LEFT JOIN users u ON u.id = a.approved_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.status = 'active' DESC, cl.legal_name`, p);
    const finance = can(req.user, 'finance.view');
    res.json(finance ? rows : rows.map(({ pay_rate_cents, bill_rate_cents, ...a }) => a));
  });

  function assignmentWarnings(v, excludeId) {
    const w = [];
    const others = db.all(`SELECT a.*, c.legal_name FROM assignments a JOIN clients c ON c.id = a.client_id WHERE a.caregiver_id = ? AND a.status IN ('pending','active') AND a.id IS NOT ?
      AND a.start_date <= ? AND (a.end_date IS NULL OR a.end_date >= ?)`, [v.caregiver_id, excludeId, v.end_date || '9999-12-31', v.start_date]);
    const { shiftInterval, overlaps } = require('../lib/util');
    for (const o of others) {
      const sharedDays = o.days_of_week.split(',').map(Number).filter((d) => v.days_of_week.includes(d));
      if (!sharedDays.length) continue;
      if (overlaps(shiftInterval('2000-01-03', v.shift_start, v.shift_end), shiftInterval('2000-01-03', o.shift_start, o.shift_end))) {
        w.push({ code: 'conflict', message: `Overlaps assignment #${o.id} with ${o.legal_name} (${o.shift_start}–${o.shift_end})` });
      }
    }
    const weekly = v.days_of_week.length * schedHours({ sched_start: v.shift_start, sched_end: v.shift_end })
      + others.reduce((h, o) => h + o.days_of_week.split(',').length * schedHours({ sched_start: o.shift_start, sched_end: o.shift_end }), 0);
    const cg = db.get('SELECT full_name, overtime_rule, employment_status FROM caregivers WHERE id = ?', [v.caregiver_id]);
    if (!cg) throw new HttpError(400, 'Caregiver not found.', { caregiver_id: 'Not found' });
    if (cg.overtime_rule !== 'none' && weekly > settings.get('weekly_ot_threshold')) {
      w.push({ code: 'overtime', message: `${cg.full_name}'s recurring assignments total ~${round2(weekly)} h/week (over ${settings.get('weekly_ot_threshold')} h)` });
    }
    if (cg.employment_status !== 'active') w.push({ code: 'inactive_caregiver', message: `${cg.full_name} is ${cg.employment_status}` });
    const cl = db.get('SELECT legal_name, status FROM clients WHERE id = ?', [v.client_id]);
    if (!cl) throw new HttpError(400, 'Client not found.', { client_id: 'Not found' });
    if (cl.status !== 'active') w.push({ code: 'client_status', message: `${cl.legal_name} is ${cl.status.replace('_', ' ')}` });
    return w;
  }

  r.post('/assignments', manage, (req, res) => {
    const v = validate(ASSIGN_SCHEMA, req.body);
    if (v.end_date && v.end_date < v.start_date) throw new HttpError(400, 'End date is before the start date.', { end_date: 'Before start' });
    if (!v.days_of_week.length) throw new HttpError(400, 'Choose at least one day.', { days_of_week: 'Required' });
    requireOverride(req, assignmentWarnings(v), v.override_reason);
    const id = db.insert('assignments', {
      caregiver_id: v.caregiver_id, client_id: v.client_id, facility_id: v.facility_id, service_type_id: v.service_type_id,
      start_date: v.start_date, end_date: v.end_date, days_of_week: [...new Set(v.days_of_week)].sort().join(','), shift_start: v.shift_start, shift_end: v.shift_end,
      responsibilities: v.responsibilities, pay_rate_cents: v.pay_rate, bill_rate_cents: v.bill_rate, override_reason: v.override_reason,
      status: 'pending', created_by: req.user.id,
    });
    audit(db, req, 'create', 'assignment', id, { clientId: v.client_id, after: { caregiver_id: v.caregiver_id, pay_rate_cents: v.pay_rate, bill_rate_cents: v.bill_rate, override_reason: v.override_reason } });
    res.status(201).json({ id });
  });

  r.patch('/assignments/:id', manage, (req, res) => {
    const id = idParam(req.params.id);
    const before = db.get('SELECT * FROM assignments WHERE id = ?', [id]);
    if (!before) throw new HttpError(404, 'Assignment not found.');
    const v = validate({ ...ASSIGN_SCHEMA, status: { type: 'enum', values: ['pending', 'active', 'ended', 'cancelled'] } }, req.body, { partial: true });
    const row = {};
    for (const k of ['facility_id', 'service_type_id', 'end_date', 'shift_start', 'shift_end', 'responsibilities', 'status', 'override_reason']) if (k in v) row[k] = v[k];
    if (v.days_of_week) row.days_of_week = [...new Set(v.days_of_week)].sort().join(',');
    // Rate overrides only change future shifts; completed shifts keep their snapshots.
    if ('pay_rate' in v) row.pay_rate_cents = v.pay_rate;
    if ('bill_rate' in v) row.bill_rate_cents = v.bill_rate;
    const merged = { ...before, ...row, days_of_week: (row.days_of_week || before.days_of_week).split(',').map(Number) };
    if (merged.end_date && merged.end_date < merged.start_date) throw new HttpError(400, 'End date is before the start date.');
    if (['shift_start', 'shift_end', 'days_of_week', 'end_date'].some((k) => k in row) && merged.status !== 'ended') {
      requireOverride(req, assignmentWarnings(merged, id), v.override_reason);
    }
    db.update('assignments', id, row);
    if (row.status === 'ended' || row.status === 'cancelled') {
      // Future unstarted shifts from this assignment are cancelled.
      db.run(`UPDATE shifts SET status = 'cancelled', updated_at = ? WHERE assignment_id = ? AND status IN ('scheduled','open') AND date > ?`,
        [new Date().toISOString(), id, row.end_date || settings.today()]);
    }
    audit(db, req, 'update', 'assignment', id, { clientId: before.client_id, before, after: row });
    res.json({ ok: true });
  });

  r.post('/assignments/:id/approve', requirePerm('time.approve'), (req, res) => {
    const id = idParam(req.params.id);
    const a = db.get('SELECT * FROM assignments WHERE id = ?', [id]);
    if (!a) throw new HttpError(404, 'Assignment not found.');
    db.update('assignments', id, { status: 'active', approved_by: req.user.id, approved_at: new Date().toISOString() });
    audit(db, req, 'approve', 'assignment', id, { clientId: a.client_id });
    res.json({ ok: true });
  });

  /** Create scheduled shifts for each matching day in [from, to]. Conflicting days are skipped unless overridden. */
  r.post('/assignments/:id/generate', manage, (req, res) => {
    const id = idParam(req.params.id);
    const a = db.get('SELECT * FROM assignments WHERE id = ?', [id]);
    if (!a) throw new HttpError(404, 'Assignment not found.');
    if (a.status !== 'active') throw new HttpError(400, 'Approve the assignment before generating shifts.');
    const v = validate({ from: { type: 'date', required: true }, to: { type: 'date', required: true }, override_reason: { type: 'text', max: 1000 } }, req.body);
    if (daysBetween(v.from, v.to) > 92 || v.to < v.from) throw new HttpError(400, 'Choose a range of up to 3 months.');
    const days = a.days_of_week.split(',').map(Number);
    const created = [];
    const skipped = [];
    db.tx(() => {
      for (let d = v.from; d <= v.to; d = addDays(d, 1)) {
        if (d < a.start_date || (a.end_date && d > a.end_date) || !days.includes(dayOfWeek(d))) continue;
        if (db.get(`SELECT 1 FROM shifts WHERE assignment_id = ? AND date = ? AND status <> 'cancelled'`, [id, d])) continue;
        const warnings = scheduleWarnings(db, settings, { caregiverId: a.caregiver_id, clientId: a.client_id, date: d, start: a.shift_start, end: a.shift_end })
          .filter((w) => w.code !== 'client_status' || d === settings.today());
        if (warnings.length && !v.override_reason) { skipped.push({ date: d, warnings }); continue; }
        const shift = { assignment_id: id, caregiver_id: a.caregiver_id, client_id: a.client_id, facility_id: a.facility_id, service_type_id: a.service_type_id, date: d, sched_start: a.shift_start, sched_end: a.shift_end };
        created.push(db.insert('shifts', { ...shift, ...rateSnapshot(db, shift), status: 'scheduled', source: 'schedule', override_reason: warnings.length ? v.override_reason : null }));
      }
    });
    audit(db, req, 'generate_shifts', 'assignment', id, { clientId: a.client_id, note: `${created.length} created, ${skipped.length} skipped${v.override_reason ? `; override: ${v.override_reason}` : ''}` });
    res.json({ created: created.length, skipped });
  });

  // ================= shifts =================
  r.get('/shifts', (req, res) => {
    const where = [];
    const p = [];
    const isCg = req.user.role === 'caregiver';
    if (isCg) { where.push('s.caregiver_id = ?'); p.push(req.user.caregiver_id); }
    else if (!can(req.user, 'schedule.view')) throw new HttpError(403, 'You do not have permission to do that.');
    if (req.query.from) { where.push('s.date >= ?'); p.push(String(req.query.from)); }
    if (req.query.to) { where.push('s.date <= ?'); p.push(String(req.query.to)); }
    for (const k of ['caregiver_id', 'client_id', 'facility_id', 'service_type_id']) if (req.query[k] && !(isCg && k === 'caregiver_id')) { where.push(`s.${k} = ?`); p.push(idParam(req.query[k])); }
    if (req.query.status) { where.push(`s.status IN (${String(req.query.status).split(',').map(() => '?').join(',')})`); p.push(...String(req.query.status).split(',')); }
    if (req.query.approval_status) { where.push('s.approval_status = ?'); p.push(String(req.query.approval_status)); }
    if (req.query.doc_incomplete) where.push(`s.status = 'completed' AND s.doc_complete = 0`);
    if (req.query.open) where.push('s.caregiver_id IS NULL');
    const rows = db.all(`SELECT s.*, cg.full_name AS caregiver_name, cl.legal_name AS client_name, cl.preferred_name, cl.room, cl.status AS client_status,
        st.name AS service_name, f.name AS facility_name
      FROM shifts s LEFT JOIN caregivers cg ON cg.id = s.caregiver_id JOIN clients cl ON cl.id = s.client_id
      LEFT JOIN service_types st ON st.id = s.service_type_id LEFT JOIN facilities f ON f.id = s.facility_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.date, s.sched_start LIMIT 5000`, p);
    const finance = can(req.user, 'finance.view');
    res.json(rows.map((s) => {
      const out = { ...s, worked_hours: round2(workedHours(s)), sched_hours: round2(schedHours(s)) };
      if (!finance) { delete out.bill_rate_cents; delete out.bill_method; if (!isCg) delete out.pay_rate_cents; }
      return out;
    }));
  });

  r.post('/shifts', manage, (req, res) => {
    const v = validate(SHIFT_SCHEMA, req.body);
    const warnings = scheduleWarnings(db, settings, { caregiverId: v.caregiver_id, clientId: v.client_id, date: v.date, start: v.sched_start, end: v.sched_end });
    requireOverride(req, warnings, v.override_reason);
    const shift = { ...v, override_reason: warnings.length ? v.override_reason : null };
    const id = db.insert('shifts', { ...shift, ...rateSnapshot(db, shift), status: v.caregiver_id ? 'scheduled' : 'open', source: 'manual' });
    audit(db, req, 'create', 'shift', id, { clientId: v.client_id, after: { caregiver_id: v.caregiver_id, date: v.date, sched_start: v.sched_start, sched_end: v.sched_end, override_reason: shift.override_reason } });
    res.status(201).json({ id });
  });

  r.get('/shifts/:id', (req, res) => {
    const s = getShift(idParam(req.params.id));
    ownShift(req, s);
    if (req.user.role !== 'caregiver' && !can(req.user, 'schedule.view')) throw new HttpError(403, 'You do not have permission to do that.');
    const docs = {
      adl: db.all('SELECT * FROM adl_logs WHERE shift_id = ? ORDER BY recorded_at', [s.id]),
      meals: db.all('SELECT * FROM meal_logs WHERE shift_id = ? ORDER BY recorded_at', [s.id]),
      activities: db.all('SELECT * FROM activity_logs WHERE shift_id = ? ORDER BY recorded_at', [s.id]),
      observations: db.all('SELECT * FROM observations WHERE shift_id = ? ORDER BY recorded_at', [s.id]),
      med_events: db.all('SELECT e.*, m.name AS medication_name FROM med_events e JOIN medications m ON m.id = e.medication_id WHERE e.shift_id = ? ORDER BY e.scheduled_for', [s.id]),
      measurements: db.all('SELECT * FROM measurements WHERE shift_id = ? ORDER BY measured_at', [s.id]),
      incidents: db.all('SELECT id, type, severity, status, occurred_at FROM incidents WHERE shift_id = ?', [s.id]),
    };
    const client = db.get('SELECT legal_name, preferred_name, room, status FROM clients WHERE id = ?', [s.client_id]);
    const out = { ...s, client, now: now(), worked_hours: round2(workedHours(s)), docs, outstanding: ['in_progress', 'completed'].includes(s.status) ? outstandingDocs(db, s, now()) : [] };
    if (!can(req.user, 'finance.view')) { delete out.bill_rate_cents; delete out.bill_method; }
    res.json(out);
  });

  /** Staff edit of schedule or time record. Edits to time require a reason and reset approval. */
  r.patch('/shifts/:id', (req, res) => {
    const id = idParam(req.params.id);
    const before = getShift(id);
    const isCg = req.user.role === 'caregiver';
    if (isCg) {
      ownShift(req, before);
      if (before.approval_status === 'approved') throw new HttpError(400, 'This shift is approved. Ask your supervisor to make changes.');
      if (!['in_progress', 'completed'].includes(before.status)) throw new HttpError(400, 'You can only update shifts you have worked.');
    } else if (!can(req.user, 'schedule.manage')) throw new HttpError(403, 'You do not have permission to do that.');

    const schema = isCg
      ? { actual_start: { type: 'datetime' }, actual_end: { type: 'datetime' }, break_min: { type: 'int', min: 0, max: 600 }, mileage: { type: 'number', min: 0, max: 1000 }, notes: { type: 'text', max: 3000 }, reason: { type: 'text', max: 1000 } }
      : { ...SHIFT_SCHEMA, client_id: { type: 'id' }, date: { type: 'date' }, sched_start: { type: 'time' }, sched_end: { type: 'time' },
        actual_start: { type: 'datetime' }, actual_end: { type: 'datetime' }, break_min: { type: 'int', min: 0, max: 600 }, mileage: { type: 'number', min: 0, max: 1000 },
        status: { type: 'enum', values: ['open', 'scheduled', 'in_progress', 'completed', 'missed', 'cancelled'] }, reason: { type: 'text', max: 1000 } };
    const v = validate(schema, req.body, { partial: true });
    const reason = v.reason; delete v.reason;
    const timeFields = ['actual_start', 'actual_end', 'break_min', 'mileage', 'date', 'caregiver_id', 'service_type_id'];
    const touchesTime = timeFields.some((k) => k in v && v[k] !== before[k]);
    if (touchesTime) {
      const locked = lockedReason(id);
      if (locked) throw new HttpError(400, `This shift cannot be changed because ${locked}. Void or adjust that record first.`);
      if (['completed', 'in_progress'].includes(before.status) && (!reason || reason.length < 5)) throw new HttpError(400, 'Enter a reason for changing a time record.', { reason: 'Required' });
    }
    const m = { ...before, ...v };
    if (m.actual_start && m.actual_end) {
      const mins = minutesBetween(m.actual_start, m.actual_end);
      if (mins <= 0) throw new HttpError(400, 'End time must be after start time.', { actual_end: 'Before start' });
      if (mins > 24 * 60) throw new HttpError(400, 'A shift cannot exceed 24 hours.', { actual_end: 'Too long' });
      if (m.break_min >= mins) throw new HttpError(400, 'Break is longer than the shift.', { break_min: 'Too long' });
    }
    if (!isCg && ['date', 'sched_start', 'sched_end', 'caregiver_id'].some((k) => k in v && v[k] !== before[k])) {
      const warnings = scheduleWarnings(db, settings, { caregiverId: m.caregiver_id, clientId: m.client_id, date: m.date, start: m.sched_start, end: m.sched_end, excludeId: id });
      requireOverride(req, warnings, v.override_reason);
    }
    const row = { ...v, updated_at: new Date().toISOString() };
    if ('caregiver_id' in v && before.status === 'open' && v.caregiver_id) row.status = row.status || 'scheduled';
    if (touchesTime && before.approval_status === 'approved') { row.approval_status = 'pending'; row.approved_by = null; row.approved_at = null; }
    if (['date', 'caregiver_id', 'service_type_id', 'client_id'].some((k) => k in v)) Object.assign(row, rateSnapshot(db, m));
    db.update('shifts', id, row);
    audit(db, req, 'update', 'shift', id, { clientId: before.client_id, before, after: v, note: reason || null });
    res.json({ ok: true });
  });

  // ----- clock in / out -----
  r.post('/shifts/:id/start', requirePerm('portal'), (req, res) => {
    const s = getShift(idParam(req.params.id));
    ownShift(req, s);
    const v = validate({ exception_reason: { type: 'text', max: 1000 } }, req.body);
    if (s.status !== 'scheduled') throw new HttpError(400, `This shift is ${s.status.replace('_', ' ')}.`);
    if (db.get(`SELECT 1 FROM shifts WHERE caregiver_id = ? AND status = 'in_progress'`, [s.caregiver_id])) throw new HttpError(400, 'You already have a shift in progress. End it first.');
    const client = db.get('SELECT legal_name, status FROM clients WHERE id = ?', [s.client_id]);
    if (client.status !== 'active') throw new HttpError(400, `${client.legal_name} is currently ${client.status.replace('_', ' ')}. Contact the office before starting care.`);
    const plan = db.get(`SELECT id, requires_ack FROM care_plans WHERE client_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1`, [s.client_id]);
    if (plan?.requires_ack && !db.get('SELECT 1 FROM care_plan_acks WHERE care_plan_id = ? AND caregiver_id = ?', [plan.id, s.caregiver_id])) {
      throw new HttpError(409, 'Review and acknowledge the current care plan before starting this shift.', { code: 'ACK_REQUIRED', care_plan_id: plan.id });
    }
    const t = now();
    const offset = clockInOffset(s, t);
    const early = settings.get('clock_in_early_minutes');
    const late = settings.get('clock_in_late_minutes');
    let exception = null;
    if (offset < -early || offset > late) {
      if (!v.exception_reason || v.exception_reason.length < 5) {
        throw new HttpError(409, `This shift is scheduled for ${s.date} ${s.sched_start}. Clock-in is allowed from ${early} min before to ${late} min after the start. Enter a reason to clock in anyway.`, { code: 'OUTSIDE_WINDOW' });
      }
      exception = `Clock-in outside window (${offset} min): ${v.exception_reason}`;
    }
    db.update('shifts', s.id, { status: 'in_progress', actual_start: t, exception_note: exception, updated_at: new Date().toISOString() });
    audit(db, req, 'clock_in', 'shift', s.id, { clientId: s.client_id, after: { actual_start: t }, note: exception });
    res.json({ ok: true, actual_start: t });
  });

  /** Unscheduled visit for an assigned client (keeps v1 "clock in with client" behaviour). Needs approval. */
  r.post('/shifts/clock-in', requirePerm('portal'), (req, res) => {
    const v = validate({ client_id: { type: 'id', required: true }, reason: { type: 'text', required: true, max: 1000 } }, req.body);
    const today = settings.today();
    if (!caregiverClientIds(db, req.user.caregiver_id, today).has(v.client_id)) throw new HttpError(403, 'You are not assigned to this client.');
    const scheduled = db.get(`SELECT id FROM shifts WHERE caregiver_id = ? AND client_id = ? AND date = ? AND status = 'scheduled'`, [req.user.caregiver_id, v.client_id, today]);
    if (scheduled) throw new HttpError(400, 'You have a scheduled shift with this client today — start that shift instead.', { shift_id: scheduled.id });
    const t = now();
    const a = db.get(`SELECT * FROM assignments WHERE caregiver_id = ? AND client_id = ? AND status = 'active' AND start_date <= ? AND (end_date IS NULL OR end_date >= ?) LIMIT 1`, [req.user.caregiver_id, v.client_id, today, today]);
    const shift = { assignment_id: a?.id ?? null, caregiver_id: req.user.caregiver_id, client_id: v.client_id, facility_id: a?.facility_id ?? null, service_type_id: a?.service_type_id ?? null, date: today, sched_start: t.slice(11), sched_end: a?.shift_end || t.slice(11) };
    if (shift.sched_end === shift.sched_start) shift.sched_end = `${String((Number(t.slice(11, 13)) + 1) % 24).padStart(2, '0')}${t.slice(13, 16)}`;
    // Run the same gates as a scheduled start by delegating after insert.
    const id = db.insert('shifts', { ...shift, ...rateSnapshot(db, shift), status: 'scheduled', source: 'clock', exception_note: `Unscheduled visit: ${v.reason}` });
    audit(db, req, 'create', 'shift', id, { clientId: v.client_id, note: 'unscheduled visit' });
    res.status(201).json({ id });
  });

  r.get('/shifts/:id/checklist', (req, res) => {
    const s = getShift(idParam(req.params.id));
    ownShift(req, s);
    res.json({ outstanding: outstandingDocs(db, s, now()) });
  });

  r.post('/shifts/:id/end', requirePerm('portal', 'schedule.manage'), (req, res) => {
    const s = getShift(idParam(req.params.id));
    ownShift(req, s);
    if (s.status !== 'in_progress') throw new HttpError(400, 'This shift is not in progress.');
    const v = validate({
      break_min: { type: 'int', min: 0, max: 600, default: 0 }, mileage: { type: 'number', min: 0, max: 1000, default: 0 },
      notes: { type: 'text', max: 3000 }, exception_note: { type: 'text', max: 2000 },
    }, req.body);
    const t = now();
    const mins = minutesBetween(s.actual_start, t);
    if (v.break_min >= Math.max(mins, 1)) throw new HttpError(400, 'Break is longer than the time worked.', { break_min: 'Too long' });
    const outstanding = outstandingDocs(db, { ...s, actual_end: t }, t);
    if (outstanding.length && (!v.exception_note || v.exception_note.length < 10)) {
      throw new HttpError(409, 'Some documentation is outstanding. Complete it, or explain why it could not be done (exception report).', { code: 'DOCS_OUTSTANDING', outstanding });
    }
    const snap = rateSnapshot(db, s);
    const exception = [s.exception_note, outstanding.length ? `Ended with ${outstanding.length} outstanding item(s): ${v.exception_note}` : null].filter(Boolean).join(' | ') || null;
    db.update('shifts', s.id, {
      status: 'completed', actual_end: t, break_min: v.break_min, mileage: v.mileage, notes: v.notes ?? s.notes,
      doc_complete: outstanding.length ? 0 : 1, exception_note: exception, ...snap, updated_at: new Date().toISOString(),
    });
    audit(db, req, 'clock_out', 'shift', s.id, { clientId: s.client_id, after: { actual_end: t, break_min: v.break_min, mileage: v.mileage } });
    res.json({ ok: true, actual_end: t, worked_hours: round2(Math.max(0, mins - v.break_min) / 60), doc_complete: !outstanding.length });
  });

  /** Re-check documentation after the fact and mark complete. */
  r.post('/shifts/:id/complete-docs', (req, res) => {
    const s = getShift(idParam(req.params.id));
    ownShift(req, s);
    if (s.status !== 'completed') throw new HttpError(400, 'Only completed shifts can be marked documented.');
    const outstanding = outstandingDocs(db, s, now());
    if (outstanding.length) throw new HttpError(409, 'Documentation is still outstanding.', { code: 'DOCS_OUTSTANDING', outstanding });
    db.update('shifts', s.id, { doc_complete: 1, updated_at: new Date().toISOString() });
    audit(db, req, 'complete_docs', 'shift', s.id, { clientId: s.client_id });
    res.json({ ok: true });
  });

  // ----- supervisor actions -----
  r.post('/shifts/:id/approve', requirePerm('time.approve'), (req, res) => {
    const s = getShift(idParam(req.params.id));
    if (s.status !== 'completed') throw new HttpError(400, 'Only completed shifts can be approved.');
    const snap = s.pay_rate_cents == null || s.bill_rate_cents == null ? rateSnapshot(db, s) : {};
    const fill = Object.fromEntries(Object.entries(snap).filter(([k, val]) => s[k] == null && val != null));
    db.update('shifts', s.id, { ...fill, approval_status: 'approved', approved_by: req.user.id, approved_at: new Date().toISOString() });
    audit(db, req, 'approve', 'shift', s.id, { clientId: s.client_id, before: s, after: { approval_status: 'approved', ...fill } });
    res.json({ ok: true });
  });
  r.post('/shifts/approve-batch', requirePerm('time.approve'), (req, res) => {
    const ids = validate({ ids: { type: 'list', of: { type: 'id' }, required: true } }, req.body).ids;
    let n = 0;
    db.tx(() => {
      for (const id of ids) {
        const s = db.get('SELECT * FROM shifts WHERE id = ?', [id]);
        if (!s || s.status !== 'completed' || s.approval_status === 'approved') continue;
        const snap = rateSnapshot(db, s);
        const fill = Object.fromEntries(Object.entries(snap).filter(([k, val]) => s[k] == null && val != null));
        db.update('shifts', id, { ...fill, approval_status: 'approved', approved_by: req.user.id, approved_at: new Date().toISOString() });
        audit(db, req, 'approve', 'shift', id, { clientId: s.client_id, after: { approval_status: 'approved' } });
        n++;
      }
    });
    res.json({ approved: n });
  });
  r.post('/shifts/:id/reject', requirePerm('time.approve'), (req, res) => {
    const s = getShift(idParam(req.params.id));
    const v = validate({ reason: { type: 'text', required: true, max: 1000 } }, req.body);
    const locked = lockedReason(s.id);
    if (locked) throw new HttpError(400, `Cannot reject because ${locked}.`);
    db.update('shifts', s.id, { approval_status: 'rejected', approved_by: req.user.id, approved_at: new Date().toISOString() });
    audit(db, req, 'reject', 'shift', s.id, { clientId: s.client_id, note: v.reason });
    res.json({ ok: true });
  });
  r.post('/shifts/:id/status', manage, (req, res) => {
    const s = getShift(idParam(req.params.id));
    const v = validate({ status: { type: 'enum', values: ['missed', 'cancelled', 'scheduled'], required: true }, reason: { type: 'text', required: true, max: 1000 } }, req.body);
    if (['completed', 'in_progress'].includes(s.status)) throw new HttpError(400, 'Worked shifts cannot be cancelled or marked missed.');
    db.update('shifts', s.id, { status: v.status, override_reason: v.reason, updated_at: new Date().toISOString() });
    audit(db, req, 'update', 'shift', s.id, { clientId: s.client_id, before: s, after: { status: v.status }, note: v.reason });
    res.json({ ok: true });
  });

  // ----- coverage gaps -----
  r.get('/coverage', requirePerm('schedule.view'), (req, res) => {
    const from = req.query.from || settings.today();
    const to = req.query.to || addDays(from, 13);
    const open = db.all(`SELECT s.*, c.legal_name AS client_name FROM shifts s JOIN clients c ON c.id = s.client_id WHERE s.caregiver_id IS NULL AND s.status = 'open' AND s.date BETWEEN ? AND ? ORDER BY s.date`, [from, to]);
    const ungenerated = [];
    for (const a of db.all(`SELECT a.*, c.legal_name AS client_name, cg.full_name AS caregiver_name FROM assignments a JOIN clients c ON c.id = a.client_id JOIN caregivers cg ON cg.id = a.caregiver_id
        WHERE a.status = 'active' AND a.start_date <= ? AND (a.end_date IS NULL OR a.end_date >= ?)`, [to, from])) {
      const days = a.days_of_week.split(',').map(Number);
      let missing = 0;
      for (let d = from > a.start_date ? from : a.start_date; d <= to && (!a.end_date || d <= a.end_date); d = addDays(d, 1)) {
        if (days.includes(dayOfWeek(d)) && !db.get(`SELECT 1 FROM shifts WHERE assignment_id = ? AND date = ?`, [a.id, d])) missing++;
      }
      if (missing) ungenerated.push({ assignment_id: a.id, client_name: a.client_name, caregiver_name: a.caregiver_name, missing_days: missing });
    }
    const uncovered = db.all(`SELECT c.id, c.legal_name, c.code FROM clients c WHERE c.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.client_id = c.id AND s.date BETWEEN ? AND ? AND s.status NOT IN ('cancelled','missed') AND s.caregiver_id IS NOT NULL)
      ORDER BY c.legal_name`, [from, to]);
    const pendingAssignments = db.all(`SELECT a.id, c.legal_name AS client_name, cg.full_name AS caregiver_name FROM assignments a JOIN clients c ON c.id = a.client_id JOIN caregivers cg ON cg.id = a.caregiver_id WHERE a.status = 'pending'`);
    res.json({ from, to, open_shifts: open, ungenerated, clients_without_coverage: uncovered, pending_assignments: pendingAssignments });
  });

  return r;
};
