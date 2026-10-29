import { api } from '../api.js';
import { esc, stat, money, hours, num, hbars, barChart, applyBarWidths, badge, monthStart, fields, readForm, empty, label } from '../ui.js';

export async function render(el, parts, query, ctx) {
  const today = ctx.today();
  const from = query.from || monthStart(today);
  const to = query.to || today;
  const d = await api.get('/dashboard', { from, to });
  const c = d.cards;
  const fin = c.estimated_payroll_cents != null;
  const clin = c.clients_requiring_review != null;
  const m = d.charts.monthly;

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p>${esc(ctx.me.agency_name)} · ${esc(from)} to ${esc(to)}</p></div>
      <form class="filters noprint" id="range">${fields([{ name: 'from', label: 'From', type: 'date', value: from }, { name: 'to', label: 'To', type: 'date', value: to }])}</form>
    </div>
    <section class="stats" aria-label="Summary">
      ${stat('Active clients', c.active_clients, { href: '#/clients?status=active' })}
      ${stat('Active caregivers', c.active_caregivers, { href: '#/caregivers' })}
      ${stat('Scheduled visits', c.scheduled_visits, { tone: 'info', href: '#/schedule' })}
      ${stat('Completed visits', c.completed_visits, { sub: c.missed_visits ? `${c.missed_visits} missed` : '' })}
      ${stat('Total care hours', hours(c.total_care_hours))}
      ${stat('Overtime hours', hours(c.overtime_hours), { tone: c.overtime_hours ? 'warn' : '' })}
      ${fin ? stat('Estimated payroll', money(c.estimated_payroll_cents), { sub: 'Estimate until approved', href: '#/finance?tab=payroll' }) : ''}
      ${fin ? stat('Billable revenue', money(c.billable_revenue_cents), { sub: 'Approved shifts', href: '#/finance' }) : ''}
      ${fin ? stat('Outstanding invoices', money(c.outstanding_invoices_cents), { tone: c.outstanding_invoices_cents ? 'warn' : '', href: '#/finance?tab=invoices' }) : ''}
      ${clin ? stat('Clients requiring review', c.clients_requiring_review, { tone: c.clients_requiring_review ? 'danger' : '' }) : ''}
      ${stat('Unresolved incidents', c.unresolved_incidents, { tone: c.unresolved_incidents ? 'danger' : '', href: '#/incidents?tab=incidents' })}
      ${stat('Hospitalized clients', c.hospitalized_clients, { tone: c.hospitalized_clients ? 'warn' : '', href: '#/clients?status=hospitalized' })}
      ${clin ? stat('Hospice enrolled', c.hospice_clients, { href: '#/clients?hospice_status=enrolled' }) : ''}
      ${stat('Timesheets to approve', c.pending_approvals, { tone: c.pending_approvals ? 'warn' : '', href: '#/schedule?tab=approvals' })}
      ${stat('On shift now', c.on_shift_now, { tone: 'info' })}
    </section>

    ${clin ? `<section class="card" id="dash-review"><div class="card-head"><h2>Clients requiring staff review</h2></div>
      ${d.clients_requiring_review.length ? `<ul class="list">${d.clients_requiring_review.map((r) => `<li><a href="#/clients/${r.id}?tab=progress"><strong>${esc(r.name)}</strong></a> ${badge(r.indicator)}<div class="hint">${r.reasons.map(esc).join(' · ')}</div></li>`).join('')}</ul>` : empty('No clients currently flagged by the configured trend rules.', '✓')}
      <p class="disclaimer">${esc(d.notes.trends)}</p></section>` : ''}

    <div class="grid two">
      <section class="card"><h2>Hours by caregiver</h2>${hbars(d.charts.hours_by_caregiver, { fmt: (v) => `${num(v, 1)} h` })}</section>
      <section class="card"><h2>Hours by client</h2>${hbars(d.charts.hours_by_client, { fmt: (v) => `${num(v, 1)} h` })}</section>
      ${fin ? `<section class="card"><h2>Revenue and payroll by month</h2>${barChart(m.map((x) => x.label), [{ name: 'Billable revenue', values: m.map((x) => x.revenue_cents / 100) }, { name: 'Payroll estimate', values: m.map((x) => x.payroll_cents / 100) }], { fmt: (v) => `$${num(v, 0)}` })}</section>` : ''}
      <section class="card"><h2>Completed vs missed visits</h2>${barChart(d.charts.visits_by_week.map((w) => w.label), [{ name: 'Completed', values: d.charts.visits_by_week.map((w) => w.completed) }, { name: 'Missed', values: d.charts.visits_by_week.map((w) => w.missed) }])}<p class="hint">By week starting Monday.</p></section>
      <section class="card"><h2>Service types delivered</h2>${hbars(d.charts.hours_by_service, { fmt: (v) => `${num(v, 1)} h` })}</section>
      <section class="card"><h2>Admissions and discharges</h2>${barChart(m.map((x) => x.label), [{ name: 'Admissions', values: m.map((x) => x.admissions) }, { name: 'Discharges', values: m.map((x) => x.discharges) }], { emptyMsg: 'No admissions or discharges in the last 6 months.' })}</section>
      ${clin ? `<section class="card"><h2>Client trend indicators</h2>${hbars(Object.entries(d.charts.client_trends || {}).map(([k, v]) => ({ label: label(k), value: v })), { fmt: (v) => String(v), emptyMsg: 'No active clients.' })}
        <p class="disclaimer">Automated indicators from documented records, not clinical assessments. Open a client's Progress tab to see the reasons and evidence.</p></section>` : ''}
    </div>`;
  applyBarWidths(el);
  el.querySelector('#range').addEventListener('change', (e) => {
    const v = readForm(e.currentTarget);
    if (v.from && v.to) location.hash = `#/dashboard?from=${v.from}&to=${v.to}`;
  });
}
