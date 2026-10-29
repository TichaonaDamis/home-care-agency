'use strict';
// Payroll and client billing are calculated independently from the same verified shift records:
// payroll uses each shift's frozen pay-rate snapshot, billing uses its frozen bill-rate snapshot.
const { addDays, weekStart, workedHours, round2, centsFor, HttpError } = require('./util');

/**
 * Allocate regular / overtime hours per shift for one caregiver.
 * rule: weekly40 (FLSA-style), daily8_weekly40 (daily + weekly), none (no overtime).
 * `shifts` must be all completed shifts in the affected workweeks, sorted chronologically.
 */
function allocateOvertime(shifts, rule, { weekly = 40, daily = 8 } = {}) {
  const out = new Map();
  const weekTotals = {};
  const dayTotals = {};
  for (const s of shifts) {
    const h = workedHours(s);
    if (rule === 'none') { out.set(s.id, { regular: h, overtime: 0 }); continue; }
    let ot = 0;
    let reg = h;
    if (rule === 'daily8_weekly40') {
      const before = dayTotals[s.date] || 0;
      const dailyOt = Math.max(0, before + h - daily) - Math.max(0, before - daily);
      dayTotals[s.date] = before + h;
      ot += dailyOt;
      reg -= dailyOt;
    }
    const wk = weekStart(s.date);
    const wBefore = weekTotals[wk] || 0; // regular hours already counted this week
    const weeklyOt = Math.max(0, wBefore + reg - weekly) - Math.max(0, wBefore - weekly);
    weekTotals[wk] = wBefore + reg;
    ot += weeklyOt;
    reg -= weeklyOt;
    out.set(s.id, { regular: reg, overtime: ot });
  }
  return out;
}

/**
 * Estimated payroll for a period. Only completed shifts count; with approvedOnly only supervisor-approved ones.
 * Overtime uses complete Mon–Sun workweeks, so hours earlier in a week that started before the period
 * still count toward the weekly threshold.
 */
function computePayroll(db, settings, { from, to, caregiverId = null, approvedOnly = false }) {
  const wFrom = weekStart(from);
  const wTo = addDays(weekStart(to), 6);
  const params = [wFrom, wTo];
  let sql = `SELECT s.*, c.full_name, c.code AS caregiver_code, c.overtime_rule, c.ot_multiplier
    FROM shifts s JOIN caregivers c ON c.id = s.caregiver_id
    WHERE s.status = 'completed' AND s.approval_status <> 'rejected' AND s.date BETWEEN ? AND ?`;
  if (caregiverId) { sql += ' AND s.caregiver_id = ?'; params.push(caregiverId); }
  if (approvedOnly) sql += ` AND s.approval_status = 'approved'`;
  sql += ' ORDER BY s.caregiver_id, s.date, s.actual_start';
  const rows = db.all(sql, params);

  const byCg = new Map();
  for (const s of rows) {
    if (!byCg.has(s.caregiver_id)) byCg.set(s.caregiver_id, []);
    byCg.get(s.caregiver_id).push(s);
  }
  const thresholds = { weekly: settings.get('weekly_ot_threshold'), daily: settings.get('daily_ot_threshold') };
  const items = [];
  for (const [cgId, list] of byCg) {
    const alloc = allocateOvertime(list, list[0].overtime_rule, thresholds);
    const it = {
      caregiver_id: cgId, caregiver_name: list[0].full_name, caregiver_code: list[0].caregiver_code,
      overtime_rule: list[0].overtime_rule, regular_hours: 0, overtime_hours: 0, regular_cents: 0, overtime_cents: 0,
      miles: 0, mileage_cents: 0, adjustments_cents: 0, gross_cents: 0, shift_ids: [], pending_approval: 0, missing_rate: 0,
    };
    for (const s of list) {
      if (s.date < from || s.date > to) continue;
      const a = alloc.get(s.id);
      const rate = s.pay_rate_cents;
      if (rate == null) it.missing_rate++;
      if (s.approval_status !== 'approved') it.pending_approval++;
      it.regular_hours += a.regular;
      it.overtime_hours += a.overtime;
      it.regular_cents += centsFor(a.regular, rate || 0);
      it.overtime_cents += centsFor(a.overtime, Math.round((rate || 0) * (s.ot_multiplier || 1.5)));
      it.miles += s.mileage || 0;
      it.mileage_cents += Math.round((s.mileage || 0) * (s.mileage_rate_cents || 0));
      it.shift_ids.push(s.id);
    }
    if (!it.shift_ids.length) continue;
    items.push(it);
  }
  // Adjustments in the period (also for caregivers with no shifts).
  const adj = db.all(`SELECT a.caregiver_id, SUM(a.amount_cents) amt, c.full_name, c.code FROM payroll_adjustments a
    JOIN caregivers c ON c.id = a.caregiver_id WHERE a.date BETWEEN ? AND ? ${caregiverId ? 'AND a.caregiver_id = ?' : ''}
    GROUP BY a.caregiver_id`, caregiverId ? [from, to, caregiverId] : [from, to]);
  for (const a of adj) {
    let it = items.find((i) => i.caregiver_id === a.caregiver_id);
    if (!it) {
      it = { caregiver_id: a.caregiver_id, caregiver_name: a.full_name, caregiver_code: a.code, regular_hours: 0, overtime_hours: 0,
        regular_cents: 0, overtime_cents: 0, miles: 0, mileage_cents: 0, adjustments_cents: 0, gross_cents: 0, shift_ids: [], pending_approval: 0, missing_rate: 0 };
      items.push(it);
    }
    it.adjustments_cents = a.amt;
  }
  for (const it of items) {
    it.regular_hours = round2(it.regular_hours);
    it.overtime_hours = round2(it.overtime_hours);
    it.miles = round2(it.miles);
    it.gross_cents = it.regular_cents + it.overtime_cents + it.mileage_cents + it.adjustments_cents;
  }
  items.sort((a, b) => a.caregiver_name.localeCompare(b.caregiver_name));
  const totals = items.reduce((t, i) => {
    for (const k of ['regular_hours', 'overtime_hours', 'regular_cents', 'overtime_cents', 'miles', 'mileage_cents', 'adjustments_cents', 'gross_cents', 'pending_approval']) t[k] = round2((t[k] || 0) + i[k]);
    return t;
  }, {});
  return { from, to, approvedOnly, items, totals, estimate: true };
}

/** Units for one shift under its billing method. */
function billableUnits(s) {
  switch (s.bill_method) {
    case 'hourly': return { quantity: round2(workedHours(s)), unit: 'hour' };
    case 'per_visit': return { quantity: 1, unit: 'visit' };
    case 'daily': return { quantity: 1, unit: 'day' };
    default: return null; // monthly or not_billed shifts are not billed per shift
  }
}

/**
 * Draft invoice lines for a client: approved, completed shifts not already on a non-void invoice,
 * plus monthly services. Shifts dated inside a documented hospitalization/absence are flagged.
 */
function draftInvoiceLines(db, clientId, from, to) {
  const shifts = db.all(`SELECT s.*, st.name AS service_name FROM shifts s LEFT JOIN service_types st ON st.id = s.service_type_id
    WHERE s.client_id = ? AND s.status = 'completed' AND s.approval_status = 'approved' AND s.date BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                      WHERE ii.shift_id = s.id AND i.status <> 'void')
    ORDER BY s.date, s.actual_start`, [clientId, from, to]);
  const lines = [];
  const warnings = [];
  const seenDaily = new Set();
  const away = awayIntervals(db, clientId);
  for (const s of shifts) {
    if (away.some(([a, b]) => s.date >= a && (!b || s.date < b))) {
      warnings.push(`Shift on ${s.date} falls within a documented hospitalization or absence — verify the service was delivered.`);
    }
    if (s.bill_rate_cents == null || !s.bill_method) { warnings.push(`Shift on ${s.date} has no billing rate for its service; it was skipped.`); continue; }
    const u = billableUnits(s);
    if (!u) continue;
    if (s.bill_method === 'daily') {
      const k = `${s.date}:${s.service_type_id}`;
      if (seenDaily.has(k)) { lines.push({ kind: 'service', shift_id: s.id, service_type_id: s.service_type_id, date: s.date, description: `${s.service_name} (included in day rate)`, quantity: 0, unit: 'day', rate_cents: s.bill_rate_cents, amount_cents: 0 }); continue; }
      seenDaily.add(k);
    }
    lines.push({
      kind: 'service', shift_id: s.id, service_type_id: s.service_type_id, date: s.date,
      description: `${s.service_name || 'Care services'} ${s.actual_start.slice(11)}–${s.actual_end.slice(11)}`,
      quantity: u.quantity, unit: u.unit, rate_cents: s.bill_rate_cents, amount_cents: centsFor(u.quantity, s.bill_rate_cents),
    });
  }
  const monthly = db.all(`SELECT cs.*, st.name FROM client_services cs JOIN service_types st ON st.id = cs.service_type_id
    WHERE cs.client_id = ? AND cs.bill_method = 'monthly' AND cs.effective_from <= ? AND (cs.effective_to IS NULL OR cs.effective_to >= ?)`, [clientId, to, from]);
  for (const m of monthly) {
    const already = db.get(`SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.client_id = ? AND i.status <> 'void'
      AND ii.service_type_id = ? AND ii.unit = 'month' AND ii.date = ?`, [clientId, m.service_type_id, from]);
    if (already) continue;
    lines.push({ kind: 'service', shift_id: null, service_type_id: m.service_type_id, date: from, description: `${m.name} (monthly)`, quantity: 1, unit: 'month', rate_cents: m.bill_rate_cents, amount_cents: m.bill_rate_cents });
  }
  return { lines, warnings: [...new Set(warnings)] };
}

/** Date intervals [start, end) when the client was hospitalized or away, from transition events. */
function awayIntervals(db, clientId) {
  const ev = db.all(`SELECT event_type, event_date FROM transitions WHERE client_id = ? ORDER BY event_date, id`, [clientId]);
  const out = [];
  let open = null;
  for (const e of ev) {
    if (['hospital_admission', 'temporary_absence'].includes(e.event_type) && !open) open = e.event_date;
    if (['hospital_discharge', 'return_home'].includes(e.event_type) && open) { out.push([open, e.event_date]); open = null; }
  }
  if (open) out.push([open, null]);
  return out;
}

function invoiceTotals(db, invoiceId) {
  const inv = db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  if (!inv) throw new HttpError(404, 'Invoice not found.');
  const t = db.get('SELECT COALESCE(SUM(amount_cents),0) total FROM invoice_items WHERE invoice_id = ?', [invoiceId]).total;
  const paid = db.get('SELECT COALESCE(SUM(amount_cents),0) paid FROM payments WHERE invoice_id = ?', [invoiceId]).paid;
  return { inv, total: t, paid, balance: t - paid };
}

/** Recompute stored total and payment-driven status (draft/void are left alone). */
function refreshInvoice(db, invoiceId) {
  const { inv, total, paid } = invoiceTotals(db, invoiceId);
  let status = inv.status;
  if (!['draft', 'void'].includes(status)) status = paid <= 0 ? 'issued' : paid >= total ? 'paid' : 'partially_paid';
  db.run('UPDATE invoices SET total_cents = ?, status = ? WHERE id = ?', [total, status, invoiceId]);
}

module.exports = { allocateOvertime, computePayroll, draftInvoiceLines, awayIntervals, invoiceTotals, refreshInvoice };
