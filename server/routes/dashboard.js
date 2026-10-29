'use strict';
const express = require('express');
const { HttpError, addDays, weekStart, workedHours, schedHours, round2, nowLocal, minutesBetween } = require('../lib/util');
const { requirePerm, can } = require('../lib/auth');
const { computePayroll } = require('../lib/finance');
const { computeTrend } = require('../lib/trends');
const { caregiverClientIds, payRateFor } = require('../lib/core');
const { outstandingDocs } = require('../lib/shiftdocs');
const alerts = require('../lib/alerts');

module.exports = ({ db, settings }) => {
  const r = express.Router();
  const staffOnly = (req) => { if (req.user.role === 'caregiver') throw new HttpError(403, 'You do not have permission to do that.'); };

  r.get('/dashboard', (req, res) => {
    staffOnly(req);
    alerts.sweep(db, settings);
    const today = settings.today();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : `${today.slice(0, 7)}-01`;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
    const fin = can(req.user, 'finance.view');
    const clinical = can(req.user, 'care.view');

    const shifts = db.all(`SELECT s.*, cg.full_name AS caregiver_name, c.legal_name AS client_name, st.name AS service_name FROM shifts s
      LEFT JOIN caregivers cg ON cg.id = s.caregiver_id JOIN clients c ON c.id = s.client_id LEFT JOIN service_types st ON st.id = s.service_type_id
      WHERE s.date BETWEEN ? AND ? AND s.status <> 'cancelled'`, [from, to]);
    const completed = shifts.filter((s) => s.status === 'completed');
    const payroll = computePayroll(db, settings, { from, to });
    let billable = 0;
    for (const s of completed.filter((x) => x.approval_status === 'approved')) {
      if (s.bill_rate_cents == null) continue;
      billable += s.bill_method === 'hourly' ? Math.round(workedHours(s) * s.bill_rate_cents) : ['per_visit', 'daily'].includes(s.bill_method) ? s.bill_rate_cents : 0;
    }

    let review = [];
    if (clinical) {
      review = db.all(`SELECT id, legal_name FROM clients WHERE status IN ('active','temporarily_away')`).map((c) => ({ ...c, trend: computeTrend(db, settings, c.id, today) }))
        .filter((c) => ['possible_decline', 'requires_review'].includes(c.trend.indicator))
        .map((c) => ({ id: c.id, name: c.legal_name, indicator: c.trend.indicator, reasons: c.trend.reasons.map((x) => x.text) }));
    }
    const cards = {
      active_clients: db.get(`SELECT COUNT(*) n FROM clients WHERE status = 'active'`).n,
      active_caregivers: db.get(`SELECT COUNT(*) n FROM caregivers WHERE employment_status = 'active'`).n,
      scheduled_visits: shifts.length,
      completed_visits: completed.length,
      missed_visits: shifts.filter((s) => s.status === 'missed').length,
      total_care_hours: round2(completed.reduce((t, s) => t + workedHours(s), 0)),
      overtime_hours: payroll.totals.overtime_hours || 0,
      estimated_payroll_cents: fin ? payroll.totals.gross_cents || 0 : null,
      billable_revenue_cents: fin ? billable : null,
      outstanding_invoices_cents: fin ? db.get(`SELECT COALESCE(SUM(i.total_cents - COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.invoice_id = i.id),0)),0) n FROM invoices i WHERE i.status IN ('issued','partially_paid')`).n : null,
      clients_requiring_review: clinical ? review.length : null,
      unresolved_incidents: db.get(`SELECT COUNT(*) n FROM incidents WHERE status <> 'closed'`).n,
      hospitalized_clients: db.get(`SELECT COUNT(*) n FROM clients WHERE status = 'hospitalized'`).n,
      hospice_clients: clinical ? db.get(`SELECT COUNT(*) n FROM clients WHERE hospice_status = 'enrolled' AND status NOT IN ('discharged','deceased')`).n : null,
      pending_approvals: completed.filter((s) => s.approval_status === 'pending').length,
      on_shift_now: db.get(`SELECT COUNT(*) n FROM shifts WHERE status = 'in_progress'`).n,
    };

    const sumBy = (rows, key) => {
      const m = {};
      for (const s of rows) m[s[key] || 'Unspecified'] = (m[s[key] || 'Unspecified'] || 0) + workedHours(s);
      return Object.entries(m).map(([label, v]) => ({ label, value: round2(v) })).sort((a, b) => b.value - a.value);
    };
    // Completed vs missed by week
    const weeks = {};
    for (const s of shifts) {
      const w = weekStart(s.date);
      const x = weeks[w] ||= { label: w, completed: 0, missed: 0 };
      if (s.status === 'completed') x.completed++;
      if (s.status === 'missed') x.missed++;
    }
    // Last 6 months: revenue/payroll and admissions/discharges
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - i);
      months.push(d.toISOString().slice(0, 7));
    }
    const monthly = months.map((m) => {
      const mf = `${m}-01`;
      const mt = `${m}-31`;
      const row = {
        label: m,
        admissions: db.get('SELECT COUNT(*) n FROM clients WHERE admission_date BETWEEN ? AND ?', [mf, mt]).n,
        discharges: db.get('SELECT COUNT(*) n FROM clients WHERE discharge_date BETWEEN ? AND ?', [mf, mt]).n,
      };
      if (fin) {
        let rev = 0;
        for (const s of db.all(`SELECT * FROM shifts WHERE status = 'completed' AND approval_status = 'approved' AND date BETWEEN ? AND ?`, [mf, mt])) {
          if (s.bill_rate_cents == null) continue;
          rev += s.bill_method === 'hourly' ? Math.round(workedHours(s) * s.bill_rate_cents) : ['per_visit', 'daily'].includes(s.bill_method) ? s.bill_rate_cents : 0;
        }
        row.revenue_cents = rev;
        row.payroll_cents = computePayroll(db, settings, { from: mf, to: mt < today ? mt : today }).totals.gross_cents || 0;
      }
      return row;
    });
    let trendCounts = null;
    if (clinical) {
      trendCounts = {};
      for (const c of db.all(`SELECT id FROM clients WHERE status IN ('active','temporarily_away')`)) {
        const t = computeTrend(db, settings, c.id, today).indicator;
        trendCounts[t] = (trendCounts[t] || 0) + 1;
      }
    }
    res.json({
      period: { from, to },
      cards,
      charts: {
        hours_by_caregiver: sumBy(completed, 'caregiver_name'),
        hours_by_client: sumBy(completed, 'client_name'),
        hours_by_service: sumBy(completed, 'service_name'),
        visits_by_week: Object.values(weeks).sort((a, b) => a.label.localeCompare(b.label)),
        monthly,
        client_trends: trendCounts,
      },
      clients_requiring_review: review,
      notes: { payroll: 'Payroll is an estimate until approved and reconciled.', trends: 'Trend indicators are automated aids for staff review, not clinical conclusions.' },
    });
  });

  // ----- notifications (in-app only; no PHI sent by email/SMS) -----
  r.get('/notifications', (req, res) => {
    const today = settings.today();
    const now = nowLocal(settings.get('timezone'));
    const cfg = settings.get('notifications');
    const out = [];
    const push = (kind, severity, text, link) => out.push({ kind, severity, text, link });
    if (req.user.role === 'caregiver') {
      const cg = req.user.caregiver_id;
      for (const s of db.all(`SELECT s.*, c.legal_name FROM shifts s JOIN clients c ON c.id = s.client_id WHERE s.caregiver_id = ? AND s.status = 'scheduled' AND s.date BETWEEN ? AND ? ORDER BY s.date, s.sched_start`, [cg, today, addDays(today, 1)])) {
        const mins = minutesBetween(now, `${s.date}T${s.sched_start}`);
        if (mins >= -settings.get('clock_in_late_minutes') && mins <= cfg.upcomingShiftHours * 60) push('upcoming_shift', 'info', `Shift with ${s.legal_name} ${s.date === today ? 'today' : 'tomorrow'} at ${s.sched_start}`, `#/my/shift/${s.id}`);
      }
      for (const s of db.all(`SELECT s.id, s.date, c.legal_name FROM shifts s JOIN clients c ON c.id = s.client_id WHERE s.caregiver_id = ? AND s.status = 'completed' AND s.doc_complete = 0 ORDER BY s.date DESC LIMIT 20`, [cg])) {
        push('missing_documentation', 'medium', `Documentation incomplete for ${s.legal_name} on ${s.date}`, `#/my/shift/${s.id}`);
      }
      for (const p of db.all(`SELECT p.id, c.legal_name, c.id AS client_id FROM care_plans p JOIN clients c ON c.id = p.client_id WHERE p.status = 'active' AND p.requires_ack = 1
          AND NOT EXISTS (SELECT 1 FROM care_plan_acks a WHERE a.care_plan_id = p.id AND a.caregiver_id = ?)`, [cg])) {
        if (caregiverClientIds(db, cg, today).has(p.client_id)) push('care_plan_ack', 'medium', `New care plan for ${p.legal_name} needs your acknowledgement`, `#/my/client/${p.client_id}`);
      }
      for (const c of db.all(`SELECT name, expires_on FROM credentials WHERE caregiver_id = ? AND expires_on IS NOT NULL AND expires_on <= ?`, [cg, addDays(today, settings.get('credential_warning_days'))])) {
        push('credential', c.expires_on < today ? 'high' : 'medium', `Your ${c.name} ${c.expires_on < today ? 'expired' : 'expires'} ${c.expires_on}`, '#/my/profile');
      }
      return res.json(out);
    }
    if (can(req.user, 'schedule.view')) {
      const grace = cfg.missedVisitGraceMinutes;
      for (const s of db.all(`SELECT s.*, c.legal_name, cg.full_name FROM shifts s JOIN clients c ON c.id = s.client_id LEFT JOIN caregivers cg ON cg.id = s.caregiver_id
          WHERE s.status = 'scheduled' AND s.date BETWEEN ? AND ?`, [addDays(today, -7), today])) {
        if (minutesBetween(`${s.date}T${s.sched_start}`, now) > grace) push('missed_visit', 'high', `Not started: ${s.full_name || 'unassigned'} → ${s.legal_name}, ${s.date} ${s.sched_start}`, `#/schedule?date=${s.date}`);
      }
      const open = db.get(`SELECT COUNT(*) n FROM shifts WHERE status = 'open' AND date BETWEEN ? AND ?`, [today, addDays(today, 14)]).n;
      if (open) push('unfilled', 'medium', `${open} unfilled shift(s) in the next 14 days`, '#/schedule');
      const undoc = db.get(`SELECT COUNT(*) n FROM shifts WHERE status = 'completed' AND doc_complete = 0`).n;
      if (undoc) push('missing_documentation', 'medium', `${undoc} completed shift(s) with incomplete documentation`, '#/care-logs');
      const pend = db.get(`SELECT COUNT(*) n FROM shifts WHERE status = 'completed' AND approval_status = 'pending'`).n;
      if (pend && can(req.user, 'time.approve')) push('approval', 'info', `${pend} timesheet(s) awaiting approval`, '#/schedule?tab=approvals');
    }
    if (can(req.user, 'caregivers.view')) {
      for (const c of db.all(`SELECT cg.full_name, cr.name, cr.expires_on FROM credentials cr JOIN caregivers cg ON cg.id = cr.caregiver_id
          WHERE cg.employment_status = 'active' AND cr.expires_on IS NOT NULL AND cr.expires_on <= ? ORDER BY cr.expires_on`, [addDays(today, settings.get('credential_warning_days'))])) {
        push('credential', c.expires_on < today ? 'high' : 'medium', `${c.full_name}: ${c.name} ${c.expires_on < today ? 'expired' : 'expires'} ${c.expires_on}`, '#/caregivers');
      }
    }
    if (can(req.user, 'meds.view')) {
      const unv = db.get('SELECT COUNT(*) n FROM medication_changes WHERE verified = 0').n;
      if (unv) push('med_verification', 'high', `${unv} medication change(s) not yet verified`, '#/medications');
      const disc = db.get(`SELECT COUNT(*) n FROM alerts WHERE category = 'medication' AND status <> 'resolved'`).n;
      if (disc) push('med_discrepancy', 'high', `${disc} unresolved medication alert(s)`, '#/incidents');
    }
    if (can(req.user, 'alerts.manage')) {
      const un = db.get(`SELECT COUNT(*) n FROM alerts WHERE status = 'open'`).n;
      if (un) push('alerts', 'high', `${un} unacknowledged alert(s)`, '#/incidents');
      const cond = db.get(`SELECT COUNT(*) n FROM alerts WHERE status <> 'resolved' AND category IN ('trend','measurement','condition_change','fall','nutrition','hydration')`).n;
      if (cond) push('condition', 'medium', `${cond} open alert(s) about changes in client condition`, '#/incidents');
    }
    if (can(req.user, 'careplan.manage')) {
      for (const p of db.all(`SELECT c.id, c.legal_name, p.review_due FROM care_plans p JOIN clients c ON c.id = p.client_id WHERE p.status = 'active' AND p.review_due IS NOT NULL AND p.review_due <= ? AND c.status = 'active'`, [addDays(today, cfg.carePlanReviewDays)])) {
        push('care_plan_review', p.review_due < today ? 'high' : 'medium', `Care plan review ${p.review_due < today ? 'overdue' : 'due'} for ${p.legal_name} (${p.review_due})`, `#/clients/${p.id}`);
      }
    }
    if (can(req.user, 'transitions.manage')) {
      for (const t of db.all(`SELECT t.*, c.legal_name FROM transitions t JOIN clients c ON c.id = t.client_id WHERE t.follow_up_due IS NOT NULL AND t.follow_up_done IS NULL AND t.follow_up_due <= ?`, [addDays(today, cfg.dischargeFollowUpDays)])) {
        push('discharge_follow_up', t.follow_up_due < today ? 'high' : 'medium', `Follow-up due ${t.follow_up_due} for ${t.legal_name} (${t.event_type.replace(/_/g, ' ')})`, `#/clients/${t.client_id}?tab=transitions`);
      }
    }
    if (can(req.user, 'finance.view')) {
      const od = db.all(`SELECT number, due_date FROM invoices WHERE status IN ('issued','partially_paid') AND due_date < ?`, [today]);
      if (od.length) push('invoice', 'medium', `${od.length} invoice(s) past due`, '#/finance?tab=invoices');
    }
    const order = { high: 0, medium: 1, info: 2 };
    out.sort((a, b) => order[a.severity] - order[b.severity]);
    res.json(out);
  });

  // ----- global search -----
  r.get('/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const like = `%${q}%`;
    const out = [];
    if (req.user.role === 'caregiver') {
      const ids = [...caregiverClientIds(db, req.user.caregiver_id, settings.today())];
      for (const c of ids.length ? db.all(`SELECT id, code, legal_name FROM clients WHERE id IN (${ids.map(() => '?').join(',')}) AND (legal_name LIKE ? OR code LIKE ?)`, [...ids, like, like]) : []) {
        out.push({ type: 'client', label: c.legal_name, sub: c.code, link: `#/my/client/${c.id}` });
      }
      return res.json(out);
    }
    if (can(req.user, 'clients.view')) {
      for (const c of db.all('SELECT id, code, legal_name, status FROM clients WHERE legal_name LIKE ? OR preferred_name LIKE ? OR code LIKE ? LIMIT 10', [like, like, like])) {
        out.push({ type: 'client', label: c.legal_name, sub: `${c.code} · ${c.status}`, link: `#/clients/${c.id}` });
      }
    }
    if (can(req.user, 'caregivers.view')) {
      for (const c of db.all('SELECT id, code, full_name, employment_status FROM caregivers WHERE full_name LIKE ? OR code LIKE ? LIMIT 10', [like, like])) {
        out.push({ type: 'caregiver', label: c.full_name, sub: `${c.code} · ${c.employment_status}`, link: `#/caregivers/${c.id}` });
      }
    }
    if (can(req.user, 'finance.view')) {
      for (const i of db.all('SELECT i.id, i.number, i.status, c.legal_name FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.number LIKE ? LIMIT 5', [like])) {
        out.push({ type: 'invoice', label: i.number, sub: `${i.legal_name} · ${i.status}`, link: `#/finance/invoice/${i.id}` });
      }
    }
    res.json(out);
  });

  // ================= caregiver self-service =================
  r.get('/me/dashboard', requirePerm('portal'), (req, res) => {
    const cg = req.user.caregiver_id;
    const today = settings.today();
    const now = nowLocal(settings.get('timezone'));
    const profile = db.get('SELECT id, code, full_name, phone, email, employment_status, med_authority FROM caregivers WHERE id = ?', [cg]);
    const shifts = db.all(`SELECT s.id, s.date, s.sched_start, s.sched_end, s.status, s.actual_start, s.actual_end, s.client_id, c.legal_name AS client_name, c.preferred_name, c.room, st.name AS service_name
      FROM shifts s JOIN clients c ON c.id = s.client_id LEFT JOIN service_types st ON st.id = s.service_type_id
      WHERE s.caregiver_id = ? AND ((s.date BETWEEN ? AND ? AND s.status IN ('scheduled','in_progress')) OR s.status = 'in_progress') ORDER BY s.date, s.sched_start`, [cg, addDays(today, -1), addDays(today, 7)]);
    const active = shifts.find((s) => s.status === 'in_progress') || null;
    const ws = weekStart(today);
    const week = db.all(`SELECT * FROM shifts WHERE caregiver_id = ? AND status = 'completed' AND date BETWEEN ? AND ?`, [cg, ws, addDays(ws, 6)]);
    const ids = [...caregiverClientIds(db, cg, today)];
    res.json({
      profile,
      active_shift: active ? { ...active, outstanding: outstandingDocs(db, db.get('SELECT * FROM shifts WHERE id = ?', [active.id]), now) } : null,
      today: shifts.filter((s) => s.date === today && s.status === 'scheduled'),
      upcoming: shifts.filter((s) => s.date > today && s.status === 'scheduled'),
      clients: ids.length ? db.all(`SELECT id, legal_name, preferred_name, room, status FROM clients WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY legal_name`, ids) : [],
      week: {
        from: ws, worked_hours: round2(week.reduce((t, s) => t + workedHours(s), 0)), scheduled_hours: round2(week.reduce((t, s) => t + schedHours(s), 0)),
        approved_hours: round2(week.filter((s) => s.approval_status === 'approved').reduce((t, s) => t + workedHours(s), 0)),
      },
      incomplete_docs: db.all(`SELECT s.id, s.date, c.legal_name AS client_name FROM shifts s JOIN clients c ON c.id = s.client_id WHERE s.caregiver_id = ? AND s.status = 'completed' AND s.doc_complete = 0 ORDER BY s.date DESC`, [cg]),
      now,
    });
  });

  r.get('/me/timesheet', requirePerm('portal'), (req, res) => {
    const cg = req.user.caregiver_id;
    const today = settings.today();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : weekStart(today);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : addDays(from, 6);
    const rows = db.all(`SELECT s.id, s.date, s.sched_start, s.sched_end, s.actual_start, s.actual_end, s.break_min, s.mileage, s.status, s.approval_status, s.doc_complete, s.exception_note,
        c.legal_name AS client_name FROM shifts s JOIN clients c ON c.id = s.client_id WHERE s.caregiver_id = ? AND s.date BETWEEN ? AND ? AND s.status IN ('completed','in_progress','missed') ORDER BY s.date, s.actual_start`, [cg, from, to]);
    const payroll = computePayroll(db, settings, { from, to, caregiverId: cg });
    const it = payroll.items[0];
    res.json({
      from, to,
      shifts: rows.map((s) => ({ ...s, hours: round2(workedHours(s)) })),
      totals: {
        hours: round2(rows.reduce((t, s) => t + workedHours(s), 0)),
        approved_hours: round2(rows.filter((s) => s.approval_status === 'approved').reduce((t, s) => t + workedHours(s), 0)),
        regular_hours: it?.regular_hours ?? 0, overtime_hours: it?.overtime_hours ?? 0, miles: it?.miles ?? 0,
        current_rate_cents: payRateFor(db, cg, today),
      },
      note: 'Hours are pending until approved by your supervisor.',
    });
  });

  return r;
};
