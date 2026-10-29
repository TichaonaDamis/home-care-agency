import { api } from '../api.js';
import { esc, onClick, table, tabs, badge, fields, readForm, opts, fmtDate, fmtISO, money, hours, num, label, stat, formModal, confirmDialog, toast, showError, modal, monthStart, monthEnd, addDays, kv, wireRowLinks, downloadCsv } from '../ui.js';
import { financial } from './reports.js';

const OT_RULES = { weekly40: 'OT over 40 h/week', daily8_weekly40: 'OT over 8 h/day & 40 h/week', none: 'No overtime (exempt)' };
const TABS = [['summary', 'Financial summary'], ['payroll', 'Payroll'], ['invoices', 'Client invoices'], ['expenses', 'Expenses']];

export async function render(el, parts, query, ctx) {
  if (parts[0] === 'invoice' && parts[1]) return invoiceDetail(el, Number(parts[1]), ctx);
  if (parts[0] === 'payroll' && parts[1]) return payrollRun(el, Number(parts[1]), ctx);
  const tab = query.tab || 'summary';
  el.innerHTML = `<div class="page-head"><div><h1>Payroll & Billing</h1><p>Caregiver wages and client billing are calculated separately from approved shifts and the rates frozen on each shift.</p></div>
    <div class="page-actions"><button class="btn ghost" id="print">Print</button></div></div>
    ${tabs(TABS, tab)}<div id="tab"></div>`;
  el.querySelector('.tabs').addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (t) location.hash = `#/finance?tab=${t.dataset.tab}`; });
  el.querySelector('#print').addEventListener('click', () => window.print());
  const box = el.querySelector('#tab');
  const reload = () => render(el, parts, query, ctx);
  const from = query.from || monthStart(ctx.today());
  const to = query.to || monthEnd(ctx.today());
  const rangeForm = (extra = []) => `<form class="filters" id="filters">${fields([{ name: 'from', label: 'From', type: 'date', value: from }, { name: 'to', label: 'To', type: 'date', value: to }, ...extra])}</form>`;
  const onRange = () => box.querySelector('#filters')?.addEventListener('change', (e) => { location.hash = `#/finance${api.qs({ tab, ...readForm(e.currentTarget) })}`; });

  if (tab === 'summary') {
    const lk = await ctx.lookups();
    const d = await api.get('/finance/summary', { from, to, facility_id: query.facility_id });
    const { html, csv } = financial(d);
    box.innerHTML = `<section class="card"><div class="card-head"><h2>${esc(fmtDate(from))} – ${esc(fmtDate(to))}</h2><button class="btn ghost small" id="csv">Export CSV</button></div>
      ${rangeForm([{ name: 'facility_id', label: 'Facility', type: 'select', options: opts(lk.facilities), value: query.facility_id, placeholder: 'All' }])}</section>${html}
      <section class="card"><h3>By month</h3>${table([
      { label: 'Month', key: 'month' }, { label: 'Billable', num: true, render: (m) => money(m.billable_cents) },
      { label: 'Payroll est.', num: true, render: (m) => money(m.payroll_cents) }, { label: 'Expenses', num: true, render: (m) => money(m.expenses_cents) },
      { label: 'Margin est.', num: true, render: (m) => money(m.billable_cents - m.payroll_cents - m.expenses_cents) },
    ], d.by_month, { empty: 'No activity.' })}</section>`;
    box.querySelector('#csv').addEventListener('click', () => downloadCsv(`financial_${from}_${to}.csv`, csv[0], csv.slice(1)));
  }

  if (tab === 'payroll') {
    const approvedOnly = query.approved_only !== '0';
    const [p, runs, adj, cgs] = await Promise.all([api.get('/payroll/preview', { from, to, approved_only: approvedOnly ? 1 : 0 }), api.get('/payroll/runs'), api.get('/payroll/adjustments'), api.get('/caregivers')]);
    box.innerHTML = `<section class="card"><div class="card-head"><h2>Payroll estimate</h2><div class="actions">
        <button class="btn ghost small" id="adj">+ Adjustment</button>${ctx.can('finance.manage') ? '<button class="btn primary small" id="run">Create payroll run</button>' : ''}</div></div>
      ${rangeForm([{ name: 'approved_only', label: 'Shifts', type: 'select', required: true, options: [['1', 'Approved only'], ['0', 'All completed (incl. pending)']], value: approvedOnly ? '1' : '0' }])}
      <div class="notice warn"><strong>Estimate</strong>Amounts are estimates until approved and reconciled with your payroll provider. Overtime follows each caregiver's configured rule (weekly, daily + weekly, or exempt) over full Monday–Sunday workweeks. Confirm rules against federal and state requirements.</div><br>
      ${table([
      { label: 'Caregiver', render: (i) => `<strong>${esc(i.caregiver_name)}</strong><div class="sub">${esc(i.caregiver_code)} · ${esc(OT_RULES[i.overtime_rule] || '')}</div>` },
      { label: 'Regular h', num: true, render: (i) => hours(i.regular_hours), total: (r) => r.reduce((s, i) => s + i.regular_hours, 0), fmt: hours },
      { label: 'OT h', num: true, render: (i) => hours(i.overtime_hours), total: (r) => r.reduce((s, i) => s + i.overtime_hours, 0), fmt: hours },
      { label: 'Regular pay', num: true, render: (i) => money(i.regular_cents), total: (r) => r.reduce((s, i) => s + i.regular_cents, 0), fmt: money },
      { label: 'OT premium pay', num: true, render: (i) => money(i.overtime_cents), total: (r) => r.reduce((s, i) => s + i.overtime_cents, 0), fmt: money },
      { label: 'Mileage', num: true, render: (i) => `${money(i.mileage_cents)}<div class="sub">${num(i.miles, 1)} mi</div>`, total: (r) => r.reduce((s, i) => s + i.mileage_cents, 0), fmt: money },
      { label: 'Adjustments', num: true, render: (i) => money(i.adjustments_cents), total: (r) => r.reduce((s, i) => s + i.adjustments_cents, 0), fmt: money },
      { label: 'Gross est.', num: true, render: (i) => `<strong>${money(i.gross_cents)}</strong>`, total: (r) => r.reduce((s, i) => s + i.gross_cents, 0), fmt: money },
      { label: 'Flags', render: (i) => `${i.pending_approval ? badge('pending', `${i.pending_approval} unapproved`) : ''} ${i.missing_rate ? badge('high', `${i.missing_rate} no rate`) : ''}` },
    ], p.items, { empty: 'No completed shifts in this period.' })}</section>
      <div class="grid two">
        <section class="card"><h2>Payroll runs</h2>${table([
      { label: 'Period', render: (r) => `${fmtDate(r.period_from)} – ${fmtDate(r.period_to)}` }, { label: 'Caregivers', num: true, key: 'caregivers' },
      { label: 'Total', num: true, render: (r) => money(r.total_cents) }, { label: 'Status', render: (r) => badge(r.status) },
    ], runs, { rowLink: (r) => `#/finance/payroll/${r.id}`, empty: 'No payroll runs yet.' })}</section>
        <section class="card"><h2>Recent adjustments</h2>${table([
      { label: 'Date', render: (a) => fmtDate(a.date) }, { label: 'Caregiver', key: 'full_name' }, { label: 'Amount', num: true, render: (a) => money(a.amount_cents) }, { label: 'Reason', key: 'reason' },
    ], adj, { empty: 'No adjustments.' })}</section></div>`;
    wireRowLinks(box);
    box.querySelector('#run')?.addEventListener('click', async () => {
      const r = await formModal({ title: 'Create payroll run', intro: '<p class="hint">Includes supervisor-approved shifts and adjustments in the period. Approve the run when reconciled; processed runs lock their shifts.</p>', defs: [{ name: 'from', label: 'From', type: 'date', required: true, value: from }, { name: 'to', label: 'To', type: 'date', required: true, value: to }, { name: 'notes', label: 'Notes', type: 'textarea', full: true }], submit: (v) => api.post('/payroll/runs', v) });
      if (r) { if (r.pending_unapproved_shifts) toast(`${r.pending_unapproved_shifts} completed shift(s) were not approved and are excluded.`); location.hash = `#/finance/payroll/${r.id}`; }
    });
    box.querySelector('#adj').addEventListener('click', async () => {
      if (await formModal({ title: 'Payroll adjustment', intro: '<p class="hint">Bonuses, reimbursements (positive) or deductions (negative). Recorded in the audit log.</p>', defs: [{ name: 'caregiver_id', label: 'Caregiver', type: 'select', required: true, options: opts(cgs, 'full_name') }, { name: 'date', label: 'Date', type: 'date', required: true, value: ctx.today() }, { name: 'amount', label: 'Amount ($)', type: 'number', step: '0.01', required: true }, { name: 'reason', label: 'Reason', type: 'textarea', required: true, full: true }], submit: (v) => api.post('/payroll/adjustments', v) })) reload();
    });
  }

  if (tab === 'invoices') {
    const [rows, clients] = await Promise.all([api.get('/invoices', { status: query.status, client_id: query.client_id }), api.get('/clients')]);
    box.innerHTML = `<section class="card"><div class="card-head"><h2>Invoices</h2>${ctx.can('finance.manage') ? '<button class="btn primary small" id="new">+ Create invoice</button>' : ''}</div>
      <form class="filters" id="filters">${fields([{ name: 'status', label: 'Status', type: 'select', options: [['outstanding', 'Outstanding'], ['draft', 'Draft'], ['issued', 'Issued'], ['partially_paid', 'Partially paid'], ['paid', 'Paid'], ['void', 'Void']], value: query.status }, { name: 'client_id', label: 'Client', type: 'select', options: opts(clients, 'legal_name'), value: query.client_id }])}</form>
      ${table([
      { label: 'Invoice', render: (i) => `<strong>${esc(i.number)}</strong>` }, { label: 'Client', render: (i) => `${esc(i.client_name)}<div class="sub">${esc(i.client_code)}</div>` },
      { label: 'Period', render: (i) => `${fmtDate(i.period_from)} – ${fmtDate(i.period_to)}` }, { label: 'Due', render: (i) => fmtDate(i.due_date) },
      { label: 'Total', num: true, render: (i) => money(i.total_cents), total: (r) => r.filter((i) => i.status !== 'void').reduce((s, i) => s + i.total_cents, 0), fmt: money },
      { label: 'Paid', num: true, render: (i) => money(i.paid_cents), total: (r) => r.reduce((s, i) => s + i.paid_cents, 0), fmt: money },
      { label: 'Balance', num: true, render: (i) => money(i.balance_cents), total: (r) => r.reduce((s, i) => s + i.balance_cents, 0), fmt: money },
      { label: 'Status', render: (i) => `${badge(i.status)}${['issued', 'partially_paid'].includes(i.status) && i.due_date < ctx.today() ? ' ' + badge('high', 'Past due') : ''}` },
    ], rows, { rowLink: (i) => `#/finance/invoice/${i.id}`, empty: 'No invoices.' })}</section>`;
    wireRowLinks(box);
    box.querySelector('#filters').addEventListener('change', (e) => { location.hash = `#/finance${api.qs({ tab, ...readForm(e.currentTarget) })}`; });
    box.querySelector('#new')?.addEventListener('click', () => newInvoice(clients, ctx));
  }

  if (tab === 'expenses') {
    const lk = await ctx.lookups();
    const rows = await api.get('/expenses', { from, to });
    box.innerHTML = `<section class="card"><div class="card-head"><h2>Operating expenses</h2>${ctx.can('finance.manage') ? '<button class="btn primary small" id="add">+ Expense</button>' : ''}</div>${rangeForm()}
      ${table([
      { label: 'Date', render: (e) => fmtDate(e.date) }, { label: 'Category', key: 'category' }, { label: 'Description', key: 'description' }, { label: 'Facility', render: (e) => esc(e.facility_name || '—') },
      { label: 'Amount', num: true, render: (e) => money(e.amount_cents), total: (r) => r.reduce((s, e) => s + e.amount_cents, 0), fmt: money },
      ...(ctx.can('finance.manage') ? [{ label: '', render: (e) => `<button class="btn link danger-text" data-del="${e.id}">Delete</button>` }] : []),
    ], rows, { empty: 'No expenses recorded in this period.' })}</section>`;
    box.querySelector('#add')?.addEventListener('click', async () => {
      if (await formModal({ title: 'Record expense', defs: [{ name: 'date', label: 'Date', type: 'date', required: true, value: ctx.today() }, { name: 'category', label: 'Category', type: 'select', required: true, options: (lk.expense_categories || []).map((c) => [c, c]) }, { name: 'amount', label: 'Amount ($)', type: 'money', required: true }, { name: 'facility_id', label: 'Facility', type: 'select', options: opts(lk.facilities) }, { name: 'description', label: 'Description', full: true }], submit: (v) => api.post('/expenses', v) })) reload();
    });
    box.addEventListener('click', async (e) => {
      const id = e.target.dataset.del;
      if (id && await confirmDialog('Delete this expense?', { danger: true, okLabel: 'Delete' })) { try { await api.del(`/expenses/${id}`); reload(); } catch (err) { showError(err); } }
    });
  }
  onRange();
}

async function newInvoice(clients, ctx) {
  const lastMonthEnd = addDays(monthStart(ctx.today()), -1);
  await modal({
    title: 'Create invoice', wide: true,
    body: `<form class="form" id="pick"><div class="form-grid">${fields([
      { name: 'client_id', label: 'Client', type: 'select', required: true, options: opts(clients, 'legal_name') },
      { name: 'from', label: 'Period from', type: 'date', required: true, value: monthStart(lastMonthEnd) },
      { name: 'to', label: 'to', type: 'date', required: true, value: lastMonthEnd },
    ])}</div><div class="actions"><button class="btn ghost" type="submit">Preview lines</button></div></form><div id="preview"></div>`,
    onMount: (m, close) => {
      const form = m.querySelector('#pick');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = readForm(form);
        try {
          const p = await api.get('/invoices/preview', v);
          m.querySelector('#preview').innerHTML = `${p.warnings.length ? `<div class="notice warn"><strong>Check before invoicing</strong>${p.warnings.map(esc).join('<br>')}</div>` : ''}
            ${table([{ label: 'Date', render: (l) => fmtDate(l.date) }, { label: 'Description', key: 'description' }, { label: 'Qty', num: true, render: (l) => `${num(l.quantity, 2)} ${esc(l.unit)}` }, { label: 'Rate', num: true, render: (l) => money(l.rate_cents) }, { label: 'Amount', num: true, render: (l) => money(l.amount_cents), total: (r) => r.reduce((s, l) => s + l.amount_cents, 0), fmt: money }], p.lines, { empty: 'No approved, unbilled services in this period.' })}
            ${p.lines.length ? '<div class="actions"><button class="btn primary" id="create">Create draft invoice</button></div>' : ''}`;
          m.querySelector('#create')?.addEventListener('click', async () => {
            try { const r = await api.post('/invoices', v); close(); location.hash = `#/finance/invoice/${r.id}`; } catch (err) { showError(err); }
          });
        } catch (err) { showError(err); }
      });
    },
  });
}

async function invoiceDetail(el, id, ctx) {
  const inv = await api.get(`/invoices/${id}`);
  const manage = ctx.can('finance.manage');
  const reload = () => invoiceDetail(el, id, ctx);
  el.innerHTML = `
    <div class="page-head"><div><a class="hint" href="#/finance?tab=invoices">← Invoices</a><h1>Invoice ${esc(inv.number)} ${badge(inv.status)}</h1><p>${esc(inv.client.legal_name)} · ${fmtDate(inv.period_from)} – ${fmtDate(inv.period_to)}</p></div>
      <div class="page-actions">
        ${manage && inv.status === 'draft' ? '<button class="btn ghost" id="fee">+ Fee / mileage</button><button class="btn ghost" id="credit">+ Credit</button><button class="btn primary" id="issue">Issue invoice</button>' : ''}
        ${manage && ['issued', 'partially_paid'].includes(inv.status) ? '<button class="btn primary" id="pay">Record payment</button>' : ''}
        ${manage && ['draft', 'issued'].includes(inv.status) && !inv.payments.length ? '<button class="btn ghost" id="void">Void</button>' : ''}
        <button class="btn ghost" id="print">Print / PDF</button></div></div>
    <section class="card">
      <div class="grid two"><div><h2>${esc(ctx.me.agency_name)}</h2><p class="hint">Bill to: <strong>${esc(inv.client.legal_name)}</strong> (${esc(inv.client.code)})<br>${esc(inv.client.address || '')}</p></div>
      <div>${kv([['Invoice', esc(inv.number)], ['Issued', fmtDate(inv.issue_date)], ['Due', fmtDate(inv.due_date)], ['Status', badge(inv.status)]])}</div></div>
      ${table([
    { label: 'Date', render: (l) => fmtDate(l.date) }, { label: 'Description', render: (l) => `${esc(l.description)}${l.kind !== 'service' ? ` ${badge('info', l.kind)}` : ''}` },
    { label: 'Qty', num: true, render: (l) => `${num(l.quantity, 2)} ${esc(l.unit)}` }, { label: 'Rate', num: true, render: (l) => money(l.rate_cents) },
    { label: 'Amount', num: true, render: (l) => money(l.amount_cents), total: (r) => r.reduce((s, l) => s + l.amount_cents, 0), fmt: money },
    ...(manage && inv.status === 'draft' ? [{ label: '', render: (l) => `<button class="btn link danger-text" data-del="${l.id}">Remove</button>` }] : []),
  ], inv.items)}
      <div class="stats">${stat('Total', money(inv.total_cents))}${stat('Paid', money(inv.paid_cents))}${stat('Balance due', money(inv.balance_cents), { tone: inv.balance_cents > 0 ? 'warn' : '' })}</div>
      ${inv.notes ? `<p class="hint">${esc(inv.notes)}</p>` : ''}</section>
    <section class="card"><h2>Payments</h2>${table([{ label: 'Date', render: (p) => fmtDate(p.date) }, { label: 'Amount', num: true, render: (p) => money(p.amount_cents) }, { label: 'Method', key: 'method' }, { label: 'Reference', key: 'reference' }, { label: 'Recorded by', key: 'recorded_by_name' }], inv.payments, { empty: 'No payments recorded.' })}</section>`;
  el.querySelector('#print').addEventListener('click', () => window.print());
  const item = (kind) => formModal({ title: kind === 'credit' ? 'Add credit' : 'Add fee or mileage', defs: [...(kind === 'credit' ? [] : [{ name: 'kind', label: 'Type', type: 'select', required: true, options: [['fee', 'Fee'], ['mileage', 'Mileage']] }]), { name: 'description', label: 'Description', required: true }, { name: 'quantity', label: 'Quantity', type: 'number', step: '0.01', value: 1 }, { name: 'rate', label: 'Rate ($)', type: 'money', required: true }, { name: 'date', label: 'Date', type: 'date' }], submit: (v) => api.post(`/invoices/${id}/items`, { kind, ...v }) });
  el.querySelector('#fee')?.addEventListener('click', async () => { if (await item('fee')) reload(); });
  el.querySelector('#credit')?.addEventListener('click', async () => { if (await item('credit')) reload(); });
  el.querySelector('#issue')?.addEventListener('click', async () => { if (await confirmDialog('Issue this invoice? It can no longer be edited.', { okLabel: 'Issue' })) { await api.post(`/invoices/${id}/issue`); reload(); } });
  el.querySelector('#pay')?.addEventListener('click', async () => {
    if (await formModal({ title: 'Record payment', defs: [{ name: 'date', label: 'Date', type: 'date', required: true, value: ctx.today() }, { name: 'amount', label: 'Amount ($)', type: 'money', required: true, value: (inv.balance_cents / 100).toFixed(2) }, { name: 'method', label: 'Method', placeholder: 'Check, ACH, Medicaid…' }, { name: 'reference', label: 'Reference #' }], submit: (v) => api.post(`/invoices/${id}/payments`, v) })) reload();
  });
  el.querySelector('#void')?.addEventListener('click', async () => {
    const reason = await confirmDialog('Void this invoice? Its shifts become billable again.', { reason: true, danger: true, okLabel: 'Void invoice' });
    if (reason) { try { await api.post(`/invoices/${id}/void`, { reason }); reload(); } catch (err) { showError(err); } }
  });
  onClick(el, async (e) => { const d = e.target.dataset.del; if (d) { try { await api.del(`/invoice-items/${d}`); reload(); } catch (err) { showError(err); } } });
}

async function payrollRun(el, id, ctx) {
  const r = await api.get(`/payroll/runs/${id}`);
  const can = ctx.can('payroll.approve');
  el.innerHTML = `<div class="page-head"><div><a class="hint" href="#/finance?tab=payroll">← Payroll</a><h1>Payroll run #${r.id} ${badge(r.status)}</h1><p>${fmtDate(r.period_from)} – ${fmtDate(r.period_to)} · created ${fmtISO(r.created_at)}${r.approved_at ? ` · approved ${fmtISO(r.approved_at)}` : ''}</p></div>
    <div class="page-actions">${can && r.status === 'draft' ? '<button class="btn primary" data-a="approve">Approve</button>' : ''}${can && r.status === 'approved' ? '<button class="btn primary" data-a="process">Mark processed</button>' : ''}${can && ['draft', 'approved'].includes(r.status) ? '<button class="btn ghost" data-a="void">Void</button>' : ''}
      <button class="btn ghost" id="csv">Export CSV</button><button class="btn ghost" id="print">Print</button></div></div>
    ${r.status === 'draft' ? '<div class="notice warn"><strong>Draft estimate</strong>Reconcile with your payroll provider before approving.</div>' : ''}
    <section class="card">${table([
    { label: 'Caregiver', render: (i) => `${esc(i.full_name)}<div class="sub">${esc(i.code)}</div>` },
    { label: 'Regular h', num: true, render: (i) => hours(i.regular_hours), total: (x) => x.reduce((s, i) => s + i.regular_hours, 0), fmt: hours },
    { label: 'OT h', num: true, render: (i) => hours(i.overtime_hours), total: (x) => x.reduce((s, i) => s + i.overtime_hours, 0), fmt: hours },
    { label: 'Regular', num: true, render: (i) => money(i.regular_cents), total: (x) => x.reduce((s, i) => s + i.regular_cents, 0), fmt: money },
    { label: 'Overtime', num: true, render: (i) => money(i.overtime_cents), total: (x) => x.reduce((s, i) => s + i.overtime_cents, 0), fmt: money },
    { label: 'Mileage', num: true, render: (i) => money(i.mileage_cents), total: (x) => x.reduce((s, i) => s + i.mileage_cents, 0), fmt: money },
    { label: 'Adjustments', num: true, render: (i) => money(i.adjustments_cents), total: (x) => x.reduce((s, i) => s + i.adjustments_cents, 0), fmt: money },
    { label: 'Gross', num: true, render: (i) => money(i.gross_cents), total: (x) => x.reduce((s, i) => s + i.gross_cents, 0), fmt: money },
    { label: 'Shifts', num: true, render: (i) => JSON.parse(i.shift_ids).length },
  ], r.items)}</section>`;
  el.querySelector('#print').addEventListener('click', () => window.print());
  el.querySelector('#csv').addEventListener('click', () => downloadCsv(`payroll_${r.period_from}_${r.period_to}.csv`, ['Caregiver ID', 'Caregiver', 'Regular hours', 'OT hours', 'Regular pay', 'OT pay', 'Mileage', 'Adjustments', 'Gross'], r.items.map((i) => [i.code, i.full_name, i.regular_hours, i.overtime_hours, (i.regular_cents / 100).toFixed(2), (i.overtime_cents / 100).toFixed(2), (i.mileage_cents / 100).toFixed(2), (i.adjustments_cents / 100).toFixed(2), (i.gross_cents / 100).toFixed(2)])));
  onClick(el, async (e) => {
    const a = e.target.dataset.a;
    if (!a) return;
    if (await confirmDialog(`${label(a)} this payroll run?`, { danger: a === 'void' })) {
      try { await api.post(`/payroll/runs/${id}/${a}`); payrollRun(el, id, ctx); } catch (err) { showError(err); }
    }
  });
}
