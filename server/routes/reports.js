'use strict';
const express = require('express');
const { HttpError, addDays, monthRange, workedHours, schedHours, round2 } = require('../lib/util');
const { validate, idParam } = require('../lib/validate');
const { requirePerm, can } = require('../lib/auth');
const { audit } = require('../lib/core');
const { computePayroll } = require('../lib/finance');
const { computeTrend } = require('../lib/trends');
const { periodSummary } = require('../lib/timeline');
const { thresholdsFor } = require('../lib/alerts');
const { financialSummary } = require('./finance');

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
};
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

module.exports = ({ db, settings }) => {
  const r = express.Router();

  // ================= timesheet report (v1 Reports page, extended) =================
  function timesheetRows(q) {
    const v = validate({ from: { type: 'date', required: true }, to: { type: 'date', required: true }, caregiver_id: { type: 'id' }, client_id: { type: 'id' }, facility_id: { type: 'id' }, service_type_id: { type: 'id' }, approval_status: { type: 'enum', values: ['pending', 'approved', 'rejected'] } }, q);
    const where = [`s.status = 'completed'`, 's.date BETWEEN ? AND ?'];
    const p = [v.from, v.to];
    for (const k of ['caregiver_id', 'client_id', 'facility_id', 'service_type_id', 'approval_status']) if (v[k]) { where.push(`s.${k} = ?`); p.push(v[k]); }
    const rows = db.all(`SELECT s.*, cg.full_name AS caregiver_name, cl.legal_name AS client_name, st.name AS service_name,
        (SELECT group_concat(task, '; ') FROM adl_logs a WHERE a.shift_id = s.id AND a.status = 'completed') AS tasks
      FROM shifts s JOIN caregivers cg ON cg.id = s.caregiver_id JOIN clients cl ON cl.id = s.client_id LEFT JOIN service_types st ON st.id = s.service_type_id
      WHERE ${where.join(' AND ')} ORDER BY s.date DESC, s.actual_start DESC`, p);
    return { v, rows };
  }

  r.get('/reports/timesheet', requirePerm('reports.operations', 'reports.financial'), (req, res) => {
    const { v, rows } = timesheetRows(req.query);
    const payroll = computePayroll(db, settings, { from: v.from, to: v.to, caregiverId: v.caregiver_id });
    const showMoney = can(req.user, 'finance.view');
    const byCaregiver = {};
    const byClient = {};
    for (const s of rows) {
      const h = workedHours(s);
      const c = byCaregiver[s.caregiver_id] ||= { caregiver_id: s.caregiver_id, name: s.caregiver_name, visits: 0, hours: 0, miles: 0 };
      c.visits++; c.hours += h; c.miles += s.mileage;
      const k = byClient[s.client_id] ||= { client_id: s.client_id, name: s.client_name, visits: 0, hours: 0, caregivers: new Set() };
      k.visits++; k.hours += h; k.caregivers.add(s.caregiver_id);
    }
    for (const c of Object.values(byCaregiver)) {
      const it = payroll.items.find((i) => i.caregiver_id === c.caregiver_id);
      c.hours = round2(c.hours); c.miles = round2(c.miles);
      c.overtime_hours = it?.overtime_hours ?? 0;
      if (showMoney) c.est_pay_cents = it ? it.gross_cents - it.adjustments_cents : 0;
    }
    const total = rows.reduce((t, s) => t + workedHours(s), 0);
    res.json({
      filters: v,
      stats: {
        total_hours: round2(total), visits: rows.length, overtime_hours: round2(Object.values(byCaregiver).reduce((t, c) => t + c.overtime_hours, 0)),
        mileage: round2(rows.reduce((t, s) => t + s.mileage, 0)),
        est_payroll_cents: showMoney ? Object.values(byCaregiver).reduce((t, c) => t + (c.est_pay_cents || 0), 0) : null,
        on_shift_now: db.get(`SELECT COUNT(*) n FROM shifts WHERE status = 'in_progress'`).n,
        pending_approval: rows.filter((s) => s.approval_status === 'pending').length,
      },
      by_caregiver: Object.values(byCaregiver).sort((a, b) => a.name.localeCompare(b.name)),
      by_client: Object.values(byClient).map((c) => ({ ...c, hours: round2(c.hours), caregivers: c.caregivers.size })).sort((a, b) => a.name.localeCompare(b.name)),
      visits: rows.map((s) => ({
        id: s.id, date: s.date, caregiver_name: s.caregiver_name, client_name: s.client_name, service_name: s.service_name,
        actual_start: s.actual_start, actual_end: s.actual_end, break_min: s.break_min, hours: round2(workedHours(s)), mileage: s.mileage,
        tasks: s.tasks, notes: s.notes, approval_status: s.approval_status, doc_complete: s.doc_complete,
      })),
      note: 'Overtime and pay are estimates using each caregiver\'s overtime rule and the rates frozen on each shift. Pending shifts are included.',
    });
  });

  r.get('/reports/timesheet.csv', requirePerm('reports.operations', 'reports.financial'), (req, res) => {
    const { v, rows } = timesheetRows(req.query);
    const head = ['Date', 'Caregiver', 'Client', 'Service', 'Start', 'End', 'Break (min)', 'Hours', 'Miles', 'Approval', 'Documentation', 'Tasks', 'Notes'];
    const body = rows.map((s) => [s.date, s.caregiver_name, s.client_name, s.service_name, s.actual_start?.replace('T', ' '), s.actual_end?.replace('T', ' '), s.break_min,
      round2(workedHours(s)).toFixed(2), s.mileage, s.approval_status, s.doc_complete ? 'complete' : 'incomplete', s.tasks, s.notes]);
    audit(db, req, 'export', 'timesheet_csv', null, { note: `${v.from}..${v.to}, ${rows.length} rows` });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="timesheet_${v.from}_${v.to}.csv"`);
    res.send(`﻿${toCsv([head, ...body])}`);
  });

  // ================= monthly reports =================
  const TYPES = {
    client_health: 'reports.clinical', caregiver_activity: 'reports.operations', financial: 'reports.financial', operations: 'reports.operations',
  };

  r.get('/reports/monthly', (req, res) => {
    const v = validate({
      type: { type: 'enum', values: Object.keys(TYPES), required: true }, month: { type: 'string', required: true, max: 7 },
      client_id: { type: 'id' }, caregiver_id: { type: 'id' }, facility_id: { type: 'id' }, service_type_id: { type: 'id' }, category_id: { type: 'id' },
    }, req.query);
    if (!can(req.user, TYPES[v.type])) throw new HttpError(403, 'You do not have permission to run this report.');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v.month)) throw new HttpError(400, 'Month must be YYYY-MM.', { month: 'Invalid' });
    const [from, to] = monthRange(v.month);
    const builders = { client_health: clientHealth, caregiver_activity: caregiverActivity, financial: (o) => financialSummary(db, settings, o.from, o.to, { facilityId: o.facility_id }), operations };
    const data = builders[v.type]({ ...v, from, to });
    const runId = db.insert('report_runs', { report_type: v.type, params: JSON.stringify(v), generated_by: req.user.id });
    audit(db, req, 'generate', 'monthly_report', runId, { clientId: v.client_id ?? null, note: v.type });
    res.json({ type: v.type, month: v.month, period: { from, to }, generated_at: new Date().toISOString(), run_id: runId, data });
  });

  r.get('/reports/runs', requirePerm('reports.operations', 'reports.clinical', 'reports.financial'), (req, res) => {
    res.json(db.all(`SELECT r.*, u.display_name AS generated_by_name FROM report_runs r LEFT JOIN users u ON u.id = r.generated_by ORDER BY r.id DESC LIMIT 100`));
  });

  // ----- A. client health & progress -----
  function clientHealth({ from, to, client_id: clientId, facility_id: facilityId, category_id: categoryId }) {
    const where = [`(c.status <> 'discharged' OR c.discharge_date >= ?)`, `(c.admission_date IS NULL OR c.admission_date <= ?)`];
    const p = [from, to];
    if (clientId) { where.push('c.id = ?'); p.push(clientId); }
    if (facilityId) { where.push('c.facility_id = ?'); p.push(facilityId); }
    if (categoryId) { where.push('EXISTS (SELECT 1 FROM client_category_links l WHERE l.client_id = c.id AND l.category_id = ?)'); p.push(categoryId); }
    const clients = db.all(`SELECT c.id, c.code, c.legal_name, c.preferred_name, c.dob, c.room, c.status, c.hospice_status, c.admission_date, f.name AS facility_name
      FROM clients c LEFT JOIN facilities f ON f.id = c.facility_id WHERE ${where.join(' AND ')} ORDER BY c.legal_name`, p);
    return clients.map((c) => {
      const summary = periodSummary(db, c.id, from, to);
      const baselines = {};
      for (const code of Object.keys(summary.measurements)) {
        const before = db.get(`SELECT value, value2, measured_at FROM measurements WHERE client_id = ? AND type_code = ? AND entered_in_error = 0 AND substr(measured_at,1,10) < ? ORDER BY measured_at DESC LIMIT 1`, [c.id, code, from]);
        baselines[code] = before || summary.measurements[code].first;
      }
      const shiftDays = db.all(`SELECT DISTINCT date FROM shifts WHERE client_id = ? AND status = 'completed' AND date BETWEEN ? AND ?`, [c.id, from, to]).map((x) => x.date);
      const obsDays = new Set(db.all(`SELECT DISTINCT substr(recorded_at,1,10) d FROM observations WHERE client_id = ? AND substr(recorded_at,1,10) BETWEEN ? AND ?`, [c.id, from, to]).map((x) => x.d));
      const mealDays = new Set(db.all(`SELECT DISTINCT substr(recorded_at,1,10) d FROM meal_logs WHERE client_id = ? AND substr(recorded_at,1,10) BETWEEN ? AND ?`, [c.id, from, to]).map((x) => x.d));
      const missing = [];
      const noObs = shiftDays.filter((d) => !obsDays.has(d)).length;
      if (noObs) missing.push(`${noObs} day(s) with completed visits but no condition observation`);
      const noMeals = shiftDays.filter((d) => !mealDays.has(d)).length;
      if (noMeals) missing.push(`${noMeals} day(s) with completed visits but no meal/fluid record`);
      for (const t of db.all('SELECT code, name FROM measurement_types WHERE active = 1')) {
        const th = thresholdsFor(db, c.id, t.code);
        if (th.expected_every_days && !summary.measurements[t.code]) missing.push(`No ${t.name} recorded (expected every ${th.expected_every_days} days)`);
      }
      if (!shiftDays.length) missing.push('No completed visits recorded in this period');
      return {
        client: c,
        summary,
        baselines,
        trend: computeTrend(db, settings, c.id, to),
        med_changes: db.all(`SELECT mc.change_type, mc.effective_date, mc.previous_value, mc.new_value, mc.verified, m.name FROM medication_changes mc JOIN medications m ON m.id = mc.medication_id WHERE mc.client_id = ? AND mc.effective_date BETWEEN ? AND ? ORDER BY mc.effective_date`, [c.id, from, to]),
        incidents: db.all(`SELECT id, type, severity, status, occurred_at, follow_up FROM incidents WHERE client_id = ? AND substr(occurred_at,1,10) BETWEEN ? AND ? ORDER BY occurred_at`, [c.id, from, to]),
        transitions: db.all('SELECT event_type, event_date, location, provider, status FROM transitions WHERE client_id = ? AND event_date BETWEEN ? AND ? ORDER BY event_date', [c.id, from, to]),
        open_concerns: db.all(`SELECT category, severity, message, status, created_at FROM alerts WHERE client_id = ? AND status <> 'resolved' ORDER BY created_at`, [c.id]),
        reviews: db.all(`SELECT r.assessment, r.summary, r.action_taken, r.concern_resolved_at, r.created_at, u.display_name AS author FROM progress_reviews r JOIN users u ON u.id = r.author_id WHERE r.client_id = ? AND substr(r.created_at,1,10) BETWEEN ? AND ?`, [c.id, from, to]),
        missing_data: missing,
      };
    });
  }

  // ----- B. caregiver activity -----
  function caregiverActivity({ from, to, caregiver_id: cgId, facility_id: facilityId, service_type_id: serviceId }) {
    const where = [`EXISTS (SELECT 1 FROM shifts s WHERE s.caregiver_id = c.id AND s.date BETWEEN ? AND ?)`];
    const p = [from, to];
    if (cgId) { where.push('c.id = ?'); p.push(cgId); }
    if (facilityId) { where.push('c.facility_id = ?'); p.push(facilityId); }
    const payroll = computePayroll(db, settings, { from, to, caregiverId: cgId || null });
    return db.all(`SELECT c.id, c.code, c.full_name, c.employment_status, c.employment_class FROM caregivers c WHERE ${where.join(' AND ')} ORDER BY c.full_name`, p).map((c) => {
      const sp = [c.id, from, to];
      const svc = serviceId ? ' AND s.service_type_id = ?' : '';
      if (serviceId) sp.push(serviceId);
      const shifts = db.all(`SELECT s.*, cl.legal_name AS client_name, st.name AS service_name FROM shifts s JOIN clients cl ON cl.id = s.client_id LEFT JOIN service_types st ON st.id = s.service_type_id
        WHERE s.caregiver_id = ? AND s.date BETWEEN ? AND ?${svc}`, sp);
      const completed = shifts.filter((s) => s.status === 'completed');
      const byClient = {};
      const byService = {};
      for (const s of completed) {
        byClient[s.client_name] = round2((byClient[s.client_name] || 0) + workedHours(s));
        byService[s.service_name || 'Unspecified'] = round2((byService[s.service_name || 'Unspecified'] || 0) + workedHours(s));
      }
      const pi = payroll.items.find((i) => i.caregiver_id === c.id);
      const userId = db.get('SELECT id FROM users WHERE caregiver_id = ?', [c.id])?.id;
      return {
        caregiver: c,
        clients_served: [...new Set(completed.map((s) => s.client_name))],
        visits_scheduled: shifts.filter((s) => s.status !== 'cancelled').length,
        visits_completed: completed.length,
        visits_missed: shifts.filter((s) => s.status === 'missed').length,
        scheduled_hours: round2(shifts.filter((s) => s.status !== 'cancelled').reduce((t, s) => t + schedHours(s), 0)),
        actual_hours: round2(completed.reduce((t, s) => t + workedHours(s), 0)),
        hours_by_client: byClient, hours_by_service: byService,
        overtime_hours: pi?.overtime_hours ?? 0, mileage: pi?.miles ?? 0,
        care_tasks: Object.fromEntries(db.all(`SELECT a.status, COUNT(*) n FROM adl_logs a JOIN shifts s ON s.id = a.shift_id WHERE s.caregiver_id = ? AND s.date BETWEEN ? AND ? GROUP BY a.status`, [c.id, from, to]).map((x) => [x.status, x.n])),
        documentation_incomplete: completed.filter((s) => !s.doc_complete).length,
        documentation_exceptions: completed.filter((s) => s.exception_note).length,
        incidents_reported: userId ? db.all(`SELECT type, severity, status FROM incidents WHERE reported_by = ? AND substr(occurred_at,1,10) BETWEEN ? AND ?`, [userId, from, to]) : [],
        approval: { approved: completed.filter((s) => s.approval_status === 'approved').length, pending: completed.filter((s) => s.approval_status === 'pending').length, rejected: completed.filter((s) => s.approval_status === 'rejected').length },
      };
    });
  }

  // ----- D. facility operations -----
  function operations({ from, to, facility_id: facilityId }) {
    const f = facilityId ? ' AND facility_id = ?' : '';
    const fp = facilityId ? [facilityId] : [];
    const shiftStats = Object.fromEntries(db.all(`SELECT status, COUNT(*) n FROM shifts WHERE date BETWEEN ? AND ?${f} GROUP BY status`, [from, to, ...fp]).map((x) => [x.status, x.n]));
    return {
      active_clients: db.get(`SELECT COUNT(*) n FROM clients WHERE status IN ('active','hospitalized','temporarily_away')${f}`, fp).n,
      admissions: db.all(`SELECT code, legal_name, admission_date FROM clients WHERE admission_date BETWEEN ? AND ?${f} ORDER BY admission_date`, [from, to, ...fp]),
      discharges: db.all(`SELECT code, legal_name, discharge_date, status FROM clients WHERE discharge_date BETWEEN ? AND ?${f} ORDER BY discharge_date`, [from, to, ...fp]),
      hospital_and_hospice_events: db.all(`SELECT t.event_type, t.event_date, c.legal_name FROM transitions t JOIN clients c ON c.id = t.client_id
        WHERE t.event_date BETWEEN ? AND ? AND t.event_type <> 'care_plan_change'${facilityId ? ' AND c.facility_id = ?' : ''} ORDER BY t.event_date`, [from, to, ...fp]),
      staffing: {
        shifts_by_status: shiftStats,
        active_caregivers: db.get(`SELECT COUNT(*) n FROM caregivers WHERE employment_status = 'active'${f}`, fp).n,
        caregivers_worked: db.get(`SELECT COUNT(DISTINCT caregiver_id) n FROM shifts WHERE status = 'completed' AND date BETWEEN ? AND ?${f}`, [from, to, ...fp]).n,
      },
      missed_visits: db.all(`SELECT s.date, s.sched_start, c.legal_name AS client, cg.full_name AS caregiver, s.override_reason FROM shifts s JOIN clients c ON c.id = s.client_id LEFT JOIN caregivers cg ON cg.id = s.caregiver_id
        WHERE s.status = 'missed' AND s.date BETWEEN ? AND ?${facilityId ? ' AND s.facility_id = ?' : ''} ORDER BY s.date`, [from, to, ...fp]),
      unfilled_shifts: db.all(`SELECT s.date, s.sched_start, s.sched_end, c.legal_name AS client FROM shifts s JOIN clients c ON c.id = s.client_id
        WHERE s.caregiver_id IS NULL AND s.status = 'open' AND s.date BETWEEN ? AND ?${facilityId ? ' AND s.facility_id = ?' : ''} ORDER BY s.date`, [from, to, ...fp]),
      incomplete_documentation: db.all(`SELECT s.id, s.date, c.legal_name AS client, cg.full_name AS caregiver, s.exception_note FROM shifts s JOIN clients c ON c.id = s.client_id JOIN caregivers cg ON cg.id = s.caregiver_id
        WHERE s.status = 'completed' AND s.doc_complete = 0 AND s.date BETWEEN ? AND ?${facilityId ? ' AND s.facility_id = ?' : ''} ORDER BY s.date`, [from, to, ...fp]),
      outstanding_incidents: db.all(`SELECT i.id, i.type, i.severity, i.status, i.occurred_at, c.legal_name AS client FROM incidents i LEFT JOIN clients c ON c.id = i.client_id WHERE i.status <> 'closed' ORDER BY i.occurred_at`),
      expiring_credentials: db.all(`SELECT cg.full_name, cr.name, cr.expires_on FROM credentials cr JOIN caregivers cg ON cg.id = cr.caregiver_id
        WHERE cg.employment_status = 'active' AND cr.expires_on IS NOT NULL AND cr.expires_on <= ? ORDER BY cr.expires_on`, [addDays(to, settings.get('credential_warning_days'))]),
      care_plan_reviews_due: db.all(`SELECT c.legal_name, p.version, p.review_due FROM care_plans p JOIN clients c ON c.id = p.client_id
        WHERE p.status = 'active' AND p.review_due IS NOT NULL AND p.review_due <= ? AND c.status IN ('active','hospitalized','temporarily_away') ORDER BY p.review_due`, [to]),
      clients_without_care_plan: db.all(`SELECT c.code, c.legal_name FROM clients c WHERE c.status = 'active' AND NOT EXISTS (SELECT 1 FROM care_plans p WHERE p.client_id = c.id AND p.status = 'active')${facilityId ? ' AND c.facility_id = ?' : ''}`, fp),
    };
  }

  return r;
};
