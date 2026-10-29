'use strict';
const express = require('express');
const { HttpError, addDays, workedHours, round2 } = require('../lib/util');
const { validate, idParam } = require('../lib/validate');
const { requirePerm } = require('../lib/auth');
const { audit } = require('../lib/core');
const { computePayroll, draftInvoiceLines, invoiceTotals, refreshInvoice } = require('../lib/finance');

const RANGE = { from: { type: 'date', required: true }, to: { type: 'date', required: true } };

module.exports = ({ db, settings }) => {
  const r = express.Router();
  const view = requirePerm('finance.view');
  const manage = requirePerm('finance.manage');
  const range = (q) => {
    const v = validate(RANGE, q);
    if (v.to < v.from) throw new HttpError(400, 'End date is before start date.');
    return v;
  };

  // ================= payroll =================
  r.get('/payroll/preview', view, (req, res) => {
    const { from, to } = range(req.query);
    res.json(computePayroll(db, settings, { from, to, caregiverId: req.query.caregiver_id ? idParam(req.query.caregiver_id) : null, approvedOnly: req.query.approved_only === '1' }));
  });

  r.get('/payroll/runs', view, (req, res) => {
    res.json(db.all(`SELECT r.*, u.display_name AS created_by_name, a.display_name AS approved_by_name,
      (SELECT COUNT(*) FROM payroll_items i WHERE i.run_id = r.id) AS caregivers
      FROM payroll_runs r LEFT JOIN users u ON u.id = r.created_by LEFT JOIN users a ON a.id = r.approved_by ORDER BY r.period_from DESC, r.id DESC`));
  });

  /** A payroll run includes only supervisor-approved shifts. */
  r.post('/payroll/runs', manage, (req, res) => {
    const v = validate({ ...RANGE, notes: { type: 'text', max: 2000 } }, req.body);
    if (v.to < v.from) throw new HttpError(400, 'End date is before start date.');
    const overlap = db.get(`SELECT id FROM payroll_runs WHERE status IN ('draft','approved','processed') AND period_from <= ? AND period_to >= ?`, [v.to, v.from]);
    if (overlap) throw new HttpError(409, `Payroll run #${overlap.id} already covers part of this period. Void it first.`);
    const p = computePayroll(db, settings, { from: v.from, to: v.to, approvedOnly: true });
    if (!p.items.length) throw new HttpError(400, 'No approved shifts or adjustments in this period.');
    const id = db.tx(() => {
      const runId = db.insert('payroll_runs', { period_from: v.from, period_to: v.to, status: 'draft', total_cents: p.totals.gross_cents, created_by: req.user.id, notes: v.notes });
      for (const it of p.items) {
        db.insert('payroll_items', {
          run_id: runId, caregiver_id: it.caregiver_id, regular_hours: it.regular_hours, overtime_hours: it.overtime_hours,
          regular_cents: it.regular_cents, overtime_cents: it.overtime_cents, miles: it.miles, mileage_cents: it.mileage_cents,
          adjustments_cents: it.adjustments_cents, gross_cents: it.gross_cents, shift_ids: JSON.stringify(it.shift_ids),
        });
      }
      return runId;
    });
    audit(db, req, 'create', 'payroll_run', id, { after: { total_cents: p.totals.gross_cents, start_date: v.from, end_date: v.to } });
    res.status(201).json({ id, pending_unapproved_shifts: computePayroll(db, settings, { from: v.from, to: v.to }).totals.pending_approval || 0 });
  });

  r.get('/payroll/runs/:id', view, (req, res) => {
    const id = idParam(req.params.id);
    const run = db.get('SELECT * FROM payroll_runs WHERE id = ?', [id]);
    if (!run) throw new HttpError(404, 'Payroll run not found.');
    run.items = db.all('SELECT i.*, c.full_name, c.code FROM payroll_items i JOIN caregivers c ON c.id = i.caregiver_id WHERE i.run_id = ? ORDER BY c.full_name', [id]);
    res.json(run);
  });

  r.post('/payroll/runs/:id/:action', requirePerm('payroll.approve'), (req, res) => {
    const id = idParam(req.params.id);
    const run = db.get('SELECT * FROM payroll_runs WHERE id = ?', [id]);
    if (!run) throw new HttpError(404, 'Payroll run not found.');
    const t = new Date().toISOString();
    const transitions = { approve: ['draft', { status: 'approved', approved_by: req.user.id, approved_at: t }], process: ['approved', { status: 'processed', processed_at: t }] };
    if (req.params.action === 'void') {
      if (run.status === 'processed') throw new HttpError(400, 'A processed payroll run cannot be voided here; record an adjustment instead.');
      db.update('payroll_runs', id, { status: 'void' });
    } else {
      const tr = transitions[req.params.action];
      if (!tr) throw new HttpError(404, 'Not found.');
      if (run.status !== tr[0]) throw new HttpError(400, `Run must be ${tr[0]} to ${req.params.action}.`);
      db.update('payroll_runs', id, tr[1]);
    }
    audit(db, req, req.params.action, 'payroll_run', id, { before: run, after: { status: req.params.action === 'void' ? 'void' : transitions[req.params.action][1].status } });
    res.json({ ok: true });
  });

  r.get('/payroll/adjustments', view, (req, res) => {
    res.json(db.all(`SELECT a.*, c.full_name FROM payroll_adjustments a JOIN caregivers c ON c.id = a.caregiver_id ORDER BY a.date DESC LIMIT 500`));
  });
  r.post('/payroll/adjustments', manage, (req, res) => {
    const v = validate({ caregiver_id: { type: 'id', required: true }, date: { type: 'date', required: true }, amount: { type: 'money', required: true }, reason: { type: 'text', required: true, max: 500 } }, req.body);
    const locked = db.get(`SELECT id FROM payroll_runs WHERE status IN ('approved','processed') AND ? BETWEEN period_from AND period_to`, [v.date]);
    if (locked) throw new HttpError(400, `Payroll run #${locked.id} for this date is already approved. Date the adjustment in an open period.`);
    const id = db.insert('payroll_adjustments', { caregiver_id: v.caregiver_id, date: v.date, amount_cents: v.amount, reason: v.reason, created_by: req.user.id });
    audit(db, req, 'create', 'payroll_adjustment', id, { after: { amount_cents: v.amount, caregiver_id: v.caregiver_id, date: v.date } });
    res.status(201).json({ id });
  });

  // ================= invoices =================
  r.get('/invoices', view, (req, res) => {
    const where = [];
    const p = [];
    if (req.query.client_id) { where.push('i.client_id = ?'); p.push(idParam(req.query.client_id)); }
    if (req.query.status === 'outstanding') where.push(`i.status IN ('issued','partially_paid')`);
    else if (req.query.status) { where.push('i.status = ?'); p.push(String(req.query.status)); }
    if (req.query.from) { where.push('i.period_to >= ?'); p.push(String(req.query.from)); }
    if (req.query.to) { where.push('i.period_from <= ?'); p.push(String(req.query.to)); }
    res.json(db.all(`SELECT i.*, c.legal_name AS client_name, c.code AS client_code,
        COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.invoice_id = i.id),0) AS paid_cents
      FROM invoices i JOIN clients c ON c.id = i.client_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.period_from DESC, i.id DESC`, p)
      .map((i) => ({ ...i, balance_cents: i.status === 'void' ? 0 : i.total_cents - i.paid_cents })));
  });

  r.get('/invoices/preview', view, (req, res) => {
    const { from, to } = range(req.query);
    const clientId = idParam(req.query.client_id);
    const d = draftInvoiceLines(db, clientId, from, to);
    const unapproved = db.get(`SELECT COUNT(*) n FROM shifts WHERE client_id = ? AND status = 'completed' AND approval_status = 'pending' AND date BETWEEN ? AND ?`, [clientId, from, to]).n;
    if (unapproved) d.warnings.push(`${unapproved} completed shift(s) in this period are awaiting approval and are not included.`);
    res.json({ ...d, total_cents: d.lines.reduce((s, l) => s + l.amount_cents, 0) });
  });

  r.post('/invoices', manage, (req, res) => {
    const v = validate({ client_id: { type: 'id', required: true }, ...RANGE, notes: { type: 'text', max: 2000 } }, req.body);
    const d = draftInvoiceLines(db, v.client_id, v.from, v.to);
    if (!d.lines.length) throw new HttpError(400, 'No approved, unbilled services in this period.');
    const id = db.tx(() => {
      const ym = v.from.slice(0, 7).replace('-', '');
      const seq = db.get(`SELECT COUNT(*) n FROM invoices WHERE number LIKE ?`, [`INV-${ym}-%`]).n + 1;
      const invId = db.insert('invoices', { number: `INV-${ym}-${String(seq).padStart(4, '0')}`, client_id: v.client_id, period_from: v.from, period_to: v.to, status: 'draft', notes: v.notes, created_by: req.user.id });
      for (const l of d.lines) db.insert('invoice_items', { invoice_id: invId, ...l });
      refreshInvoice(db, invId);
      return invId;
    });
    audit(db, req, 'create', 'invoice', id, { clientId: v.client_id, after: { total_cents: db.get('SELECT total_cents FROM invoices WHERE id = ?', [id]).total_cents } });
    res.status(201).json({ id, warnings: d.warnings });
  });

  r.get('/invoices/:id', view, (req, res) => {
    const { inv, total, paid, balance } = invoiceTotals(db, idParam(req.params.id));
    res.json({
      ...inv, total_cents: total, paid_cents: paid, balance_cents: inv.status === 'void' ? 0 : balance,
      client: db.get('SELECT id, code, legal_name, address FROM clients WHERE id = ?', [inv.client_id]),
      items: db.all('SELECT ii.*, st.name AS service_name FROM invoice_items ii LEFT JOIN service_types st ON st.id = ii.service_type_id WHERE ii.invoice_id = ? ORDER BY ii.date, ii.id', [inv.id]),
      payments: db.all('SELECT p.*, u.display_name AS recorded_by_name FROM payments p LEFT JOIN users u ON u.id = p.recorded_by WHERE p.invoice_id = ? ORDER BY p.date', [inv.id]),
    });
  });

  r.post('/invoices/:id/items', manage, (req, res) => {
    const id = idParam(req.params.id);
    const inv = db.get('SELECT * FROM invoices WHERE id = ?', [id]);
    if (!inv) throw new HttpError(404, 'Invoice not found.');
    if (inv.status !== 'draft') throw new HttpError(400, 'Only draft invoices can be changed. Void and re-issue, or add a credit on a new invoice.');
    const v = validate({ kind: { type: 'enum', values: ['mileage', 'fee', 'credit'], required: true }, description: { type: 'string', required: true, max: 200 }, quantity: { type: 'number', min: 0, default: 1 }, rate: { type: 'money', min: 0, required: true }, date: { type: 'date' } }, req.body);
    const amount = Math.round(v.quantity * v.rate) * (v.kind === 'credit' ? -1 : 1);
    const iid = db.insert('invoice_items', { invoice_id: id, kind: v.kind, description: v.description, quantity: v.quantity, unit: v.kind === 'mileage' ? 'mile' : 'each', rate_cents: v.rate, amount_cents: amount, date: v.date });
    refreshInvoice(db, id);
    audit(db, req, 'create', 'invoice_item', iid, { clientId: inv.client_id, after: { amount_cents: amount } });
    res.status(201).json({ id: iid });
  });
  r.delete('/invoice-items/:id', manage, (req, res) => {
    const id = idParam(req.params.id);
    const it = db.get('SELECT ii.*, i.status, i.client_id FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE ii.id = ?', [id]);
    if (!it) throw new HttpError(404, 'Not found.');
    if (it.status !== 'draft') throw new HttpError(400, 'Only draft invoices can be changed.');
    db.run('DELETE FROM invoice_items WHERE id = ?', [id]);
    refreshInvoice(db, it.invoice_id);
    audit(db, req, 'delete', 'invoice_item', id, { clientId: it.client_id, before: { amount_cents: it.amount_cents }, after: { amount_cents: null } });
    res.json({ ok: true });
  });

  r.post('/invoices/:id/issue', manage, (req, res) => {
    const id = idParam(req.params.id);
    const inv = db.get('SELECT * FROM invoices WHERE id = ?', [id]);
    if (!inv) throw new HttpError(404, 'Invoice not found.');
    if (inv.status !== 'draft') throw new HttpError(400, 'Only draft invoices can be issued.');
    const issue = settings.today();
    db.update('invoices', id, { status: 'issued', issue_date: issue, due_date: addDays(issue, settings.get('invoice_due_days')) });
    refreshInvoice(db, id);
    audit(db, req, 'issue', 'invoice', id, { clientId: inv.client_id, after: { status: 'issued' } });
    res.json({ ok: true });
  });
  r.post('/invoices/:id/void', manage, (req, res) => {
    const id = idParam(req.params.id);
    const inv = db.get('SELECT * FROM invoices WHERE id = ?', [id]);
    if (!inv) throw new HttpError(404, 'Invoice not found.');
    const v = validate({ reason: { type: 'text', required: true, max: 1000 } }, req.body);
    if (db.get('SELECT 1 FROM payments WHERE invoice_id = ?', [id])) throw new HttpError(400, 'This invoice has payments. Issue a credit instead of voiding.');
    db.update('invoices', id, { status: 'void', notes: [inv.notes, `VOID: ${v.reason}`].filter(Boolean).join('\n') });
    audit(db, req, 'void', 'invoice', id, { clientId: inv.client_id, before: inv, after: { status: 'void' }, note: v.reason });
    res.json({ ok: true });
  });
  r.post('/invoices/:id/payments', manage, (req, res) => {
    const id = idParam(req.params.id);
    const { inv, balance } = invoiceTotals(db, id);
    if (!['issued', 'partially_paid'].includes(inv.status)) throw new HttpError(400, 'Payments can only be recorded on issued invoices.');
    const v = validate({ date: { type: 'date', required: true }, amount: { type: 'money', min: 0.01, required: true }, method: { type: 'string', max: 40 }, reference: { type: 'string', max: 100 } }, req.body);
    if (v.amount > balance) throw new HttpError(400, `Payment exceeds the balance due (${(balance / 100).toFixed(2)}).`, { amount: 'Too large' });
    const pid = db.insert('payments', { invoice_id: id, date: v.date, amount_cents: v.amount, method: v.method, reference: v.reference, recorded_by: req.user.id });
    refreshInvoice(db, id);
    audit(db, req, 'create', 'payment', pid, { clientId: inv.client_id, after: { amount_cents: v.amount } });
    res.status(201).json({ id: pid });
  });

  // ================= expenses =================
  r.get('/expenses', view, (req, res) => {
    const where = [];
    const p = [];
    if (req.query.from) { where.push('e.date >= ?'); p.push(String(req.query.from)); }
    if (req.query.to) { where.push('e.date <= ?'); p.push(String(req.query.to)); }
    res.json(db.all(`SELECT e.*, f.name AS facility_name FROM expenses e LEFT JOIN facilities f ON f.id = e.facility_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.date DESC LIMIT 1000`, p));
  });
  r.post('/expenses', manage, (req, res) => {
    const v = validate({ date: { type: 'date', required: true }, category: { type: 'string', required: true, max: 60 }, description: { type: 'string', max: 300 }, amount: { type: 'money', min: 0, required: true }, facility_id: { type: 'id' } }, req.body);
    const id = db.insert('expenses', { date: v.date, category: v.category, description: v.description, amount_cents: v.amount, facility_id: v.facility_id, created_by: req.user.id });
    audit(db, req, 'create', 'expense', id, { after: { amount_cents: v.amount } });
    res.status(201).json({ id });
  });
  r.delete('/expenses/:id', manage, (req, res) => {
    const id = idParam(req.params.id);
    const e = db.get('SELECT * FROM expenses WHERE id = ?', [id]);
    if (!e) throw new HttpError(404, 'Not found.');
    db.run('DELETE FROM expenses WHERE id = ?', [id]);
    audit(db, req, 'delete', 'expense', id, { before: { amount_cents: e.amount_cents }, after: { amount_cents: null } });
    res.json({ ok: true });
  });

  // ================= financial summary =================
  r.get('/finance/summary', requirePerm('reports.financial'), (req, res) => {
    const { from, to } = range(req.query);
    res.json(financialSummary(db, settings, from, to, { facilityId: req.query.facility_id ? idParam(req.query.facility_id) : null }));
  });

  return r;
};

/** Revenue (from invoices and from approved billable shifts), payroll estimates, expenses and margins. */
function financialSummary(db, settings, from, to, { facilityId = null } = {}) {
  const fac = facilityId ? ' AND s.facility_id = ?' : '';
  const fp = facilityId ? [facilityId] : [];
  const shifts = db.all(`SELECT s.*, c.legal_name AS client_name, st.name AS service_name, cg.full_name AS caregiver_name FROM shifts s
    JOIN clients c ON c.id = s.client_id LEFT JOIN service_types st ON st.id = s.service_type_id LEFT JOIN caregivers cg ON cg.id = s.caregiver_id
    WHERE s.status = 'completed' AND s.approval_status = 'approved' AND s.date BETWEEN ? AND ?${fac}`, [from, to, ...fp]);
  const byClient = {};
  const byService = {};
  const byMonth = {};
  let billableHours = 0;
  let billable = 0;
  const seenDaily = new Set();
  for (const s of shifts) {
    const h = workedHours(s);
    let amt = 0;
    if (s.bill_rate_cents != null) {
      if (s.bill_method === 'hourly') { amt = Math.round(h * s.bill_rate_cents); billableHours += h; }
      else if (s.bill_method === 'per_visit') amt = s.bill_rate_cents;
      else if (s.bill_method === 'daily') { const k = `${s.client_id}|${s.date}|${s.service_type_id}`; if (!seenDaily.has(k)) { seenDaily.add(k); amt = s.bill_rate_cents; } }
    }
    billable += amt;
    const c = byClient[s.client_id] ||= { client: s.client_name, hours: 0, billable_cents: 0, invoiced_cents: 0, paid_cents: 0 };
    c.hours += h; c.billable_cents += amt;
    const sv = byService[s.service_name || 'Unspecified'] ||= { hours: 0, billable_cents: 0, visits: 0 };
    sv.hours += h; sv.billable_cents += amt; sv.visits++;
    const m = byMonth[s.date.slice(0, 7)] ||= { billable_cents: 0, payroll_cents: 0, expenses_cents: 0 };
    m.billable_cents += amt;
  }
  const invoices = db.all(`SELECT i.client_id, c.legal_name, i.total_cents, i.status, COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.invoice_id = i.id),0) paid
    FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.status <> 'void' AND i.status <> 'draft' AND i.period_from >= ? AND i.period_to <= ?`, [from, to]);
  let invoiced = 0; let collected = 0; let outstanding = 0;
  for (const i of invoices) {
    invoiced += i.total_cents; collected += i.paid; outstanding += i.total_cents - i.paid;
    const c = byClient[i.client_id] ||= { client: i.legal_name, hours: 0, billable_cents: 0, invoiced_cents: 0, paid_cents: 0 };
    c.invoiced_cents += i.total_cents; c.paid_cents += i.paid;
  }
  const allOutstanding = db.get(`SELECT COALESCE(SUM(i.total_cents - COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.invoice_id = i.id),0)),0) n FROM invoices i WHERE i.status IN ('issued','partially_paid')`).n;
  const payroll = computePayroll(db, settings, { from, to, approvedOnly: true });
  // Payroll per month is computed separately so weekly overtime is allocated within each month's window.
  for (const mk of Object.keys(byMonth)) {
    const [mf, mt] = [`${mk}-01`, `${mk}-31`];
    byMonth[mk].payroll_cents = computePayroll(db, settings, { from: mf < from ? from : mf, to: mt > to ? to : mt, approvedOnly: true }).totals.gross_cents || 0;
  }
  const expenses = db.all(`SELECT category, SUM(amount_cents) amt FROM expenses WHERE date BETWEEN ? AND ? ${facilityId ? 'AND facility_id = ?' : ''} GROUP BY category`, [from, to, ...fp]);
  for (const e of db.all(`SELECT substr(date,1,7) m, SUM(amount_cents) amt FROM expenses WHERE date BETWEEN ? AND ? GROUP BY m`, [from, to])) {
    (byMonth[e.m] ||= { billable_cents: 0, payroll_cents: 0, expenses_cents: 0 }).expenses_cents = e.amt;
  }
  const expTotal = expenses.reduce((s, e) => s + e.amt, 0);
  const t = payroll.totals;
  const hasCost = payroll.items.length > 0;
  return {
    period: { from, to },
    labels: { billable: 'Calculated from approved shifts × frozen bill rates', payroll: 'ESTIMATE — reconcile with your payroll provider', invoiced: 'Recorded invoices (issued/paid)' },
    totals: {
      caregiver_hours: round2((t.regular_hours || 0) + (t.overtime_hours || 0)), regular_hours: t.regular_hours || 0, overtime_hours: t.overtime_hours || 0,
      payroll_estimate_cents: t.gross_cents || 0, overtime_cost_cents: t.overtime_cents || 0, mileage_cost_cents: t.mileage_cents || 0, adjustments_cents: t.adjustments_cents || 0,
      billable_hours: round2(billableHours), billable_cents: billable, invoiced_cents: invoiced, collected_cents: collected, outstanding_cents: outstanding,
      outstanding_all_time_cents: allOutstanding, expenses_cents: expTotal,
      gross_margin_cents: hasCost ? billable - (t.gross_cents || 0) - expTotal : null,
    },
    by_client: Object.values(byClient).map((c) => ({ ...c, hours: round2(c.hours) })).sort((a, b) => b.billable_cents - a.billable_cents),
    by_service: Object.entries(byService).map(([name, s]) => ({ service: name, ...s, hours: round2(s.hours) })).sort((a, b) => b.billable_cents - a.billable_cents),
    by_caregiver: payroll.items,
    by_month: Object.entries(byMonth).sort().map(([month, m]) => ({ month, ...m })),
    expenses,
  };
}
module.exports.financialSummary = financialSummary;
