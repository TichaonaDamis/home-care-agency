import { api } from '../api.js';
import {
  esc, table, tabs, badge, fields, readForm, opts, fmtDate, fmtTime, fmtISO, money, hours, num, label, stat, hbars, applyBarWidths,
  lineChart, downloadCsv, downloadBlob, showError, empty, kv, toast,
} from '../ui.js';

const MONTHLY = [['client_health', 'A. Client health & progress', 'reports.clinical'], ['caregiver_activity', 'B. Caregiver activity', 'reports.operations'], ['financial', 'C. Financial', 'reports.financial'], ['operations', 'D. Facility operations', 'reports.operations']];

export async function render(el, parts, query, ctx) {
  const tab = query.tab || (ctx.can('reports.operations', 'reports.financial') ? 'timesheet' : 'monthly');
  el.innerHTML = `<div class="page-head"><div><h1>Reports & Analytics</h1><p>All figures reflect the selected period and filters. Estimates and missing data are labelled.</p></div>
    <div class="page-actions"><button class="btn ghost" id="print">Print / Save as PDF</button></div></div>
    ${tabs([...(ctx.can('reports.operations', 'reports.financial') ? [['timesheet', 'Hours & visits']] : []), ['monthly', 'Monthly reports']], tab)}<div id="tab"></div>`;
  el.querySelector('.tabs').addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (t) location.hash = `#/reports?tab=${t.dataset.tab}`; });
  el.querySelector('#print').addEventListener('click', () => window.print());
  const box = el.querySelector('#tab');
  if (tab === 'timesheet') return timesheet(box, query, ctx);
  return monthly(box, query, ctx);
}

// ================= hours & visits (the v1 Reports page, extended) =================
function quick(kind, today) {
  const d = new Date(`${today}T12:00`);
  const ymd = (x) => x.toISOString().slice(0, 10);
  const mon = (x) => { const y = new Date(x); y.setDate(y.getDate() - ((y.getDay() + 6) % 7)); return y; };
  if (kind === 'thisWeek') { const s = mon(d); const e = new Date(s); e.setDate(s.getDate() + 6); return [ymd(s), ymd(e)]; }
  if (kind === 'lastWeek') { const s = mon(d); s.setDate(s.getDate() - 7); const e = new Date(s); e.setDate(s.getDate() + 6); return [ymd(s), ymd(e)]; }
  if (kind === 'thisMonth') return [ymd(new Date(d.getFullYear(), d.getMonth(), 1, 12)), ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0, 12))];
  if (kind === 'lastMonth') return [ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1, 12)), ymd(new Date(d.getFullYear(), d.getMonth(), 0, 12))];
  return null;
}

async function timesheet(box, query, ctx) {
  const lk = await ctx.lookups();
  const [cgs, cls] = await Promise.all([api.get('/caregivers'), api.get('/clients')]);
  let from = query.from;
  let to = query.to;
  if (!from || !to) [from, to] = quick(query.quick || 'thisMonth', ctx.today());
  const f = { from, to, caregiver_id: query.caregiver_id, client_id: query.client_id, facility_id: query.facility_id, service_type_id: query.service_type_id, approval_status: query.approval_status };
  const r = await api.get('/reports/timesheet', f);
  const s = r.stats;
  box.innerHTML = `
    <section class="card"><div class="card-head"><h2>Hours & visits</h2><div class="actions noprint"><button class="btn ghost small" id="csv">Export CSV</button></div></div>
      <form class="filters noprint" id="filters">${fields([
    { name: 'from', label: 'From', type: 'date', value: from }, { name: 'to', label: 'To', type: 'date', value: to },
    { name: 'caregiver_id', label: 'Caregiver', type: 'select', options: opts(cgs, 'full_name'), value: query.caregiver_id, placeholder: 'All caregivers' },
    { name: 'client_id', label: 'Client', type: 'select', options: opts(cls, 'legal_name'), value: query.client_id, placeholder: 'All clients' },
    { name: 'facility_id', label: 'Facility', type: 'select', options: opts(lk.facilities), value: query.facility_id, placeholder: 'All' },
    { name: 'service_type_id', label: 'Service', type: 'select', options: opts(lk.service_types), value: query.service_type_id, placeholder: 'All' },
    { name: 'approval_status', label: 'Approval', type: 'select', options: [['approved', 'Approved only'], ['pending', 'Pending only']], value: query.approval_status, placeholder: 'All' },
    { name: 'quick', label: 'Quick', type: 'select', options: [['thisWeek', 'This week'], ['lastWeek', 'Last week'], ['thisMonth', 'This month'], ['lastMonth', 'Last month']], value: query.quick },
  ])}</form>
      <p class="print-only">${esc(from)} to ${esc(to)}</p>
      <div class="stats">
        ${stat('Total hours', hours(s.total_hours))}${stat('Visits', s.visits)}${stat('Overtime hours', hours(s.overtime_hours), { tone: s.overtime_hours ? 'warn' : '' })}
        ${stat('Mileage', num(s.mileage, 1))}${s.est_payroll_cents != null ? stat('Est. payroll', money(s.est_payroll_cents), { sub: 'Estimate' }) : ''}
        ${stat('Pending approval', s.pending_approval, { tone: s.pending_approval ? 'warn' : '' })}${stat('On shift now', s.on_shift_now, { tone: 'info' })}
      </div></section>
    <div class="grid two">
      <section class="card"><h2>Hours by caregiver</h2>${table([
    { label: 'Caregiver', key: 'name' }, { label: 'Visits', num: true, key: 'visits', total: 'sum' },
    { label: 'Hours', num: true, render: (c) => hours(c.hours), total: (rows) => rows.reduce((t, c) => t + c.hours, 0), fmt: hours },
    { label: 'OT', num: true, render: (c) => (c.overtime_hours ? `<span class="badge danger">${hours(c.overtime_hours)}</span>` : hours(0)), total: (rows) => rows.reduce((t, c) => t + c.overtime_hours, 0), fmt: hours },
    { label: 'Miles', num: true, render: (c) => num(c.miles, 1), total: (rows) => rows.reduce((t, c) => t + c.miles, 0), fmt: (v) => num(v, 1) },
    ...(s.est_payroll_cents != null ? [{ label: 'Est. pay', num: true, render: (c) => money(c.est_pay_cents), total: (rows) => rows.reduce((t, c) => t + c.est_pay_cents, 0), fmt: money }] : []),
  ], r.by_caregiver, { empty: 'No data for this period.' })}<p class="hint">${esc(r.note)}</p></section>
      <section class="card"><h2>Hours by client</h2>${table([
    { label: 'Client', key: 'name' }, { label: 'Visits', num: true, key: 'visits', total: 'sum' }, { label: 'Caregivers', num: true, key: 'caregivers' },
    { label: 'Hours', num: true, render: (c) => hours(c.hours), total: (rows) => rows.reduce((t, c) => t + c.hours, 0), fmt: hours },
  ], r.by_client, { empty: 'No data for this period.' })}</section>
    </div>
    <section class="card"><h2>All visits</h2>${table([
    { label: 'Date', render: (v) => fmtDate(v.date, { weekday: 'short' }) }, { label: 'Caregiver', key: 'caregiver_name' }, { label: 'Client', key: 'client_name' },
    { label: 'Time', render: (v) => `${fmtTime(v.actual_start)} – ${fmtTime(v.actual_end)}` }, { label: 'Break', num: true, render: (v) => (v.break_min ? `${v.break_min}m` : '—') },
    { label: 'Hours', num: true, render: (v) => hours(v.hours), total: (rows) => rows.reduce((t, v) => t + v.hours, 0), fmt: hours },
    { label: 'Miles', num: true, render: (v) => (v.mileage || '—') },
    { label: 'Care / notes', cls: 'wrap', render: (v) => `${esc(v.tasks || '')}${v.notes ? `<br><em>${esc(v.notes)}</em>` : ''}` },
    { label: 'Status', render: (v) => `${badge(v.approval_status)} ${v.doc_complete ? '' : badge('incomplete', 'docs')}` },
  ], r.visits, { empty: 'No visits in this period.' })}</section>`;
  box.querySelector('#filters').addEventListener('change', (e) => {
    const v = readForm(e.currentTarget);
    if (e.target.name === 'quick' && v.quick) [v.from, v.to] = quick(v.quick, ctx.today());
    else if (['from', 'to'].includes(e.target.name)) v.quick = null;
    location.hash = `#/reports${api.qs({ tab: 'timesheet', ...v })}`;
  });
  box.querySelector('#csv').addEventListener('click', async () => {
    try {
      const res = await api.raw('/reports/timesheet.csv', f);
      downloadBlob(`timesheet_${from}_${to}.csv`, await res.blob());
    } catch (e) { showError(e); }
  });
}

// ================= monthly reports =================
async function monthly(box, query, ctx) {
  const lk = await ctx.lookups();
  const types = MONTHLY.filter(([, , p]) => ctx.can(p));
  const type = query.type || types[0][0];
  const month = query.month || ctx.today().slice(0, 7);
  const [cgs, cls] = await Promise.all([ctx.can('caregivers.view') ? api.get('/caregivers') : [], api.get('/clients')]);
  box.innerHTML = `<section class="card noprint"><form class="filters" id="filters">${fields([
    { name: 'type', label: 'Report', type: 'select', required: true, options: types.map(([k, l]) => [k, l]), value: type },
    { name: 'month', label: 'Month', type: 'month', required: true, value: month },
    ...(type === 'client_health' ? [{ name: 'client_id', label: 'Client', type: 'select', options: opts(cls, 'legal_name'), value: query.client_id, placeholder: 'All clients' }, { name: 'category_id', label: 'Category', type: 'select', options: opts(lk.categories), value: query.category_id, placeholder: 'All' }] : []),
    ...(type === 'caregiver_activity' ? [{ name: 'caregiver_id', label: 'Caregiver', type: 'select', options: opts(cgs, 'full_name'), value: query.caregiver_id, placeholder: 'All caregivers' }, { name: 'service_type_id', label: 'Service', type: 'select', options: opts(lk.service_types), value: query.service_type_id, placeholder: 'All' }] : []),
    { name: 'facility_id', label: 'Facility', type: 'select', options: opts(lk.facilities), value: query.facility_id, placeholder: 'All' },
  ])}</form></section><div id="report">${'<div class="loading">Generating report…</div>'}</div>`;
  box.querySelector('#filters').addEventListener('change', (e) => { location.hash = `#/reports${api.qs({ tab: 'monthly', ...readForm(e.currentTarget) })}`; });
  const out = box.querySelector('#report');
  let r;
  try {
    r = await api.get('/reports/monthly', { type, month, client_id: query.client_id, caregiver_id: query.caregiver_id, facility_id: query.facility_id, service_type_id: query.service_type_id, category_id: query.category_id });
  } catch (e) { out.innerHTML = `<div class="card">${esc(e.message)}</div>`; return; }
  const head = `<section class="card"><div class="card-head"><div><h2>${esc(MONTHLY.find(([k]) => k === type)[1])} — ${esc(new Date(`${month}-01T12:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</h2>
    <p class="hint">${esc(ctx.me.agency_name)} · Period ${esc(r.period.from)} to ${esc(r.period.to)} · Generated ${fmtISO(r.generated_at)} by ${esc(ctx.me.user.display_name)} · Report #${r.run_id}</p></div>
    <button class="btn ghost small noprint" id="csv">Export CSV</button></div>
    <p class="hint"><strong>Legend:</strong> ${badge('ok', 'Recorded')} values come from documentation · ${badge('info', 'Calculated')} values are derived · ${badge('warn', 'Estimate')} must be reconciled · ${badge('danger', 'Missing')} data was not recorded · ${badge('muted', 'Staff assessment')} entered by staff.</p></section>`;
  const renderers = { client_health: clientHealth, caregiver_activity: caregiverActivity, financial, operations };
  const { html, csv } = renderers[type](r.data, ctx);
  out.innerHTML = head + html;
  applyBarWidths(out);
  out.querySelector('#csv').addEventListener('click', () => { downloadCsv(`${type}_${month}.csv`, csv[0], csv.slice(1)); toast('CSV downloaded.'); });
}

// ----- A -----
function clientHealth(data) {
  if (!data.length) return { html: `<section class="card">${empty('No clients match these filters for this month.')}</section>`, csv: [['No data']] };
  const csv = [['Client ID', 'Client', 'Trend indicator', 'Meal entries', 'Avg % eaten', 'Meals refused', 'Avg fluids mL/day', 'ADL completed', 'ADL declined', 'Activities', 'Avg pain', 'Falls', 'Incidents', 'Med changes', 'Transitions', 'Missing data']];
  const html = data.map((c) => {
    const s = c.summary;
    csv.push([c.client.code, c.client.legal_name, c.trend.indicator, s.meals.entries, s.meals.avg_pct_consumed, s.meals.refused, s.fluids.avg_ml_per_recorded_day, s.adl.completed || 0, s.adl.declined || 0, s.activities.entries, s.observations.pain_avg, s.observations.falls, s.incidents, s.med_changes, s.transitions, c.missing_data.join('; ')]);
    const meas = Object.entries(s.measurements);
    return `<section class="card">
      <div class="card-head"><h2>${esc(c.client.legal_name)} <span class="hint">${esc(c.client.code)}</span></h2><span>${badge(c.client.status)} ${c.client.hospice_status !== 'none' ? badge(c.client.hospice_status, `Hospice: ${label(c.client.hospice_status)}`) : ''}</span></div>
      ${kv([['Date of birth', fmtDate(c.client.dob)], ['Facility / room', esc([c.client.facility_name, c.client.room].filter(Boolean).join(' · ') || '—')], ['Admitted', fmtDate(c.client.admission_date)]])}
      ${c.missing_data.length ? `<div class="notice warn"><strong>${badge('danger', 'Missing data')}</strong>${c.missing_data.map(esc).join('<br>')}</div>` : ''}
      <h3>Measurements ${badge('ok', 'Recorded')}</h3>
      ${meas.length ? table([
    { label: 'Measurement', render: ([, m]) => esc(m.name) },
    { label: 'Baseline', render: ([code, m]) => { const b = c.baselines[code]; return b ? `${b.value2 != null ? `${b.value}/${b.value2}` : b.value} <span class="sub">${fmtDate(b.measured_at)}</span>` : '—'; } },
    { label: 'Latest', render: ([, m]) => `${m.last.value2 != null ? `${m.last.value}/${m.last.value2}` : m.last.value} <span class="sub">${fmtDate(m.last.measured_at)}</span>` },
    { label: 'Min / avg / max', render: ([, m]) => `${num(m.min, 1)} / ${num(m.avg, 1)} / ${num(m.max, 1)} ${esc(m.unit)}` },
    { label: 'Readings', num: true, render: ([, m]) => m.count },
  ], meas) : `<p>${badge('danger', 'Missing')} No measurements recorded this month.</p>`}
      <div class="grid two">${meas.filter(([, m]) => m.count > 1).map(([, m]) => `<div><h3>${esc(m.name)}</h3>${lineChart([{ name: m.name, points: m.series.map((p) => ({ x: p.at, y: p.v })) }, ...(m.series[0].v2 != null ? [{ name: 'Diastolic', points: m.series.map((p) => ({ x: p.at, y: p.v2 })) }] : [])], { height: 180 })}</div>`).join('')}</div>
      <div class="grid two">
        <div><h3>Meals, hydration & appetite</h3>${kv([['Meal entries', s.meals.entries], ['Average eaten', s.meals.avg_pct_consumed != null ? `${s.meals.avg_pct_consumed}%` : badge('danger', 'Missing')], ['Refused', s.meals.refused], ['Low appetite reports', s.meals.low_appetite], ['Swallowing difficulty', s.meals.swallowing_issues], ['Fluids', s.fluids.avg_ml_per_recorded_day != null ? `${s.fluids.avg_ml_per_recorded_day} mL / recorded day (${s.fluids.days_recorded} days)` : badge('danger', 'Missing')]])}</div>
        <div><h3>Daily living & activity</h3>${kv([['ADL completed', s.adl.completed || 0], ['Partial', s.adl.partial || 0], ['Declined', s.adl.declined || 0], ['Not completed', s.adl.not_completed || 0], ['Activities', `${s.activities.entries} (${s.activities.minutes} min, ${s.activities.declined} declined)`]])}</div>
        <div><h3>Sleep, mood, pain & behavior</h3>${kv([['Observations', s.observations.entries], ['Avg pain', s.observations.pain_avg ?? '—'], ['Poor sleep', s.observations.poor_sleep], ['Reduced alertness', s.observations.reduced_alertness], ['Agitation / distress', `${s.observations.agitation} / ${s.observations.distress}`], ['Moods', s.observations.moods.map((m) => `${esc(m.mood)} (${m.n})`).join(', ') || '—']])}</div>
        <div><h3>Indicator ${badge('info', 'Calculated')}</h3><p>${badge(c.trend.indicator)}</p><ul>${c.trend.reasons.map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul><p class="disclaimer">${esc(c.trend.disclaimer)}</p></div>
      </div>
      <div class="grid two">
        <div><h3>Medication changes</h3>${c.med_changes.length ? `<ul class="list">${c.med_changes.map((m) => `<li>${fmtDate(m.effective_date)} — ${esc(m.name)}: ${esc(label(m.change_type))} ${esc(m.new_value || '')} ${m.verified ? '' : badge('high', 'Not verified')}</li>`).join('')}</ul><p class="hint">Observations after a change show timing only, not cause.</p>` : '<p class="hint">None.</p>'}</div>
        <div><h3>Falls, incidents & transitions</h3>${c.incidents.length || c.transitions.length ? `<ul class="list">${c.incidents.map((i) => `<li>${fmtDate(i.occurred_at)} — ${esc(label(i.type))} ${badge(i.severity)} ${badge(i.status)}</li>`).join('')}${c.transitions.map((t) => `<li>${fmtDate(t.event_date)} — ${esc(label(t.event_type))}${t.location ? ` (${esc(t.location)})` : ''}</li>`).join('')}</ul>` : '<p class="hint">None.</p>'}</div>
        <div><h3>Outstanding concerns</h3>${c.open_concerns.length ? `<ul class="list">${c.open_concerns.map((a) => `<li>${badge(a.severity)} ${esc(a.message)} <span class="sub">${badge(a.status)}</span></li>`).join('')}</ul>` : '<p class="hint">None open.</p>'}</div>
        <div><h3>Staff reviews ${badge('muted', 'Staff assessment')}</h3>${c.reviews.length ? `<ul class="list">${c.reviews.map((x) => `<li>${badge(x.assessment)} ${esc(x.summary)} <span class="sub">— ${esc(x.author)}, ${fmtISO(x.created_at)}</span>${x.action_taken ? `<div class="sub">Action: ${esc(x.action_taken)}</div>` : ''}</li>`).join('')}</ul>` : '<p class="hint">No reviews this month.</p>'}</div>
      </div></section>`;
  }).join('');
  return { html, csv };
}

// ----- B -----
function caregiverActivity(data) {
  if (!data.length) return { html: `<section class="card">${empty('No caregiver activity this month.')}</section>`, csv: [['No data']] };
  const csv = [['Caregiver ID', 'Caregiver', 'Clients served', 'Visits scheduled', 'Visits completed', 'Missed', 'Scheduled hours', 'Actual hours', 'OT hours', 'Mileage', 'ADL completed', 'Docs incomplete', 'Exceptions', 'Incidents reported', 'Approved', 'Pending', 'Rejected']];
  const html = `<section class="card"><p class="hint">Measures documented care delivery and record completeness — not a judgment of care quality.</p>
    ${table([
    { label: 'Caregiver', render: (c) => `<strong>${esc(c.caregiver.full_name)}</strong><div class="sub">${esc(c.caregiver.code)}</div>` },
    { label: 'Clients served', cls: 'wrap', render: (c) => esc(c.clients_served.join(', ') || '—') },
    { label: 'Visits (done / sched.)', num: true, render: (c) => `${c.visits_completed} / ${c.visits_scheduled}${c.visits_missed ? ` <span class="badge danger">${c.visits_missed} missed</span>` : ''}` },
    { label: 'Hours (actual / sched.)', num: true, render: (c) => `${hours(c.actual_hours)} / ${hours(c.scheduled_hours)}` },
    { label: 'OT', num: true, render: (c) => hours(c.overtime_hours) },
    { label: 'Miles', num: true, render: (c) => num(c.mileage, 1) },
    { label: 'Tasks', render: (c) => Object.entries(c.care_tasks).map(([k, v]) => `${esc(label(k))}: ${v}`).join('<br>') || '—' },
    { label: 'Docs', render: (c) => (c.documentation_incomplete ? badge('incomplete', `${c.documentation_incomplete} incomplete`) : badge('complete')) + (c.documentation_exceptions ? `<div class="sub">${c.documentation_exceptions} exception(s)</div>` : '') },
    { label: 'Incidents', render: (c) => (c.incidents_reported.length ? c.incidents_reported.map((i) => `${esc(label(i.type))} ${badge(i.status)}`).join('<br>') : '0') },
    { label: 'Timesheets', render: (c) => `${badge('approved', `${c.approval.approved} approved`)} ${c.approval.pending ? badge('pending', `${c.approval.pending} pending`) : ''} ${c.approval.rejected ? badge('rejected', `${c.approval.rejected} rejected`) : ''}` },
  ], data)}</section>
    <div class="grid two">${data.map((c) => `<section class="card"><h3>${esc(c.caregiver.full_name)} — hours by client</h3>${hbars(Object.entries(c.hours_by_client).map(([k, v]) => ({ label: k, value: v })), { fmt: (v) => `${num(v, 1)} h` })}
      <h3>Hours by service</h3>${hbars(Object.entries(c.hours_by_service).map(([k, v]) => ({ label: k, value: v })), { fmt: (v) => `${num(v, 1)} h` })}</section>`).join('')}</div>`;
  for (const c of data) csv.push([c.caregiver.code, c.caregiver.full_name, c.clients_served.join('; '), c.visits_scheduled, c.visits_completed, c.visits_missed, c.scheduled_hours, c.actual_hours, c.overtime_hours, c.mileage, c.care_tasks.completed || 0, c.documentation_incomplete, c.documentation_exceptions, c.incidents_reported.length, c.approval.approved, c.approval.pending, c.approval.rejected]);
  return { html, csv };
}

// ----- C -----
export function financial(d) {
  const t = d.totals;
  const html = `<section class="card"><div class="stats">
      ${stat('Caregiver hours', hours(t.caregiver_hours), { sub: `${hours(t.regular_hours)} regular · ${hours(t.overtime_hours)} OT` })}
      ${stat('Payroll estimate', money(t.payroll_estimate_cents), { tone: 'warn', sub: 'Estimate — approved shifts' })}
      ${stat('Overtime cost', money(t.overtime_cost_cents), { tone: 'warn' })}
      ${stat('Mileage reimbursement', money(t.mileage_cost_cents))}
      ${stat('Payroll adjustments', money(t.adjustments_cents))}
      ${stat('Billable hours', hours(t.billable_hours), { tone: 'info' })}
      ${stat('Billable revenue', money(t.billable_cents), { tone: 'info', sub: 'Calculated' })}
      ${stat('Invoiced', money(t.invoiced_cents))}
      ${stat('Collected', money(t.collected_cents))}
      ${stat('Outstanding (period)', money(t.outstanding_cents), { tone: t.outstanding_cents ? 'warn' : '' })}
      ${stat('Expenses recorded', money(t.expenses_cents))}
      ${stat('Est. gross margin', t.gross_margin_cents == null ? 'n/a' : money(t.gross_margin_cents), { tone: t.gross_margin_cents < 0 ? 'danger' : '', sub: t.gross_margin_cents == null ? 'Insufficient cost data' : 'Revenue − payroll − expenses' })}
    </div>
    <p class="hint">${esc(d.labels.billable)}. ${esc(d.labels.payroll)}. ${esc(d.labels.invoiced)}. Billable revenue not yet invoiced = ${money(t.billable_cents - t.invoiced_cents)}.</p></section>
    <div class="grid two">
      <section class="card"><h3>Revenue by client</h3>${table([
    { label: 'Client', key: 'client' }, { label: 'Hours', num: true, render: (c) => hours(c.hours) },
    { label: 'Billable', num: true, render: (c) => money(c.billable_cents), total: (r) => r.reduce((s, c) => s + c.billable_cents, 0), fmt: money },
    { label: 'Invoiced', num: true, render: (c) => money(c.invoiced_cents), total: (r) => r.reduce((s, c) => s + c.invoiced_cents, 0), fmt: money },
    { label: 'Paid', num: true, render: (c) => money(c.paid_cents), total: (r) => r.reduce((s, c) => s + c.paid_cents, 0), fmt: money },
  ], d.by_client, { empty: 'No billable services.' })}</section>
      <section class="card"><h3>Revenue by service</h3>${table([
    { label: 'Service', key: 'service' }, { label: 'Visits', num: true, key: 'visits' }, { label: 'Hours', num: true, render: (s) => hours(s.hours) },
    { label: 'Billable', num: true, render: (s) => money(s.billable_cents), total: (r) => r.reduce((x, s) => x + s.billable_cents, 0), fmt: money },
  ], d.by_service, { empty: 'No services.' })}</section>
      <section class="card"><h3>Payroll estimate by caregiver</h3>${table([
    { label: 'Caregiver', key: 'caregiver_name' }, { label: 'Reg. h', num: true, render: (c) => hours(c.regular_hours) }, { label: 'OT h', num: true, render: (c) => hours(c.overtime_hours) },
    { label: 'Mileage', num: true, render: (c) => money(c.mileage_cents) }, { label: 'Adj.', num: true, render: (c) => money(c.adjustments_cents) },
    { label: 'Gross est.', num: true, render: (c) => money(c.gross_cents), total: (r) => r.reduce((s, c) => s + c.gross_cents, 0), fmt: money },
  ], d.by_caregiver, { empty: 'No approved shifts.' })}</section>
      <section class="card"><h3>Expenses</h3>${table([{ label: 'Category', key: 'category' }, { label: 'Amount', num: true, render: (e) => money(e.amt), total: (r) => r.reduce((s, e) => s + e.amt, 0), fmt: money }], d.expenses, { empty: 'No expenses recorded.' })}</section>
    </div>`;
  const csv = [['Section', 'Name', 'Hours', 'Billable', 'Invoiced', 'Paid', 'Payroll estimate']];
  for (const c of d.by_client) csv.push(['Client', c.client, c.hours, (c.billable_cents / 100).toFixed(2), (c.invoiced_cents / 100).toFixed(2), (c.paid_cents / 100).toFixed(2), '']);
  for (const s of d.by_service) csv.push(['Service', s.service, s.hours, (s.billable_cents / 100).toFixed(2), '', '', '']);
  for (const c of d.by_caregiver) csv.push(['Caregiver', c.caregiver_name, c.regular_hours + c.overtime_hours, '', '', '', (c.gross_cents / 100).toFixed(2)]);
  for (const e of d.expenses) csv.push(['Expense', e.category, '', '', '', '', (e.amt / 100).toFixed(2)]);
  return { html, csv };
}

// ----- D -----
function operations(d) {
  const st = d.staffing.shifts_by_status;
  const list = (rows, f, emptyMsg) => (rows.length ? `<ul class="list">${rows.map(f).join('')}</ul>` : `<p class="hint">${esc(emptyMsg)}</p>`);
  const html = `<section class="card"><div class="stats">
      ${stat('Active clients', d.active_clients)}${stat('Admissions', d.admissions.length)}${stat('Discharges', d.discharges.length)}
      ${stat('Hospital / hospice events', d.hospital_and_hospice_events.length)}${stat('Active caregivers', d.staffing.active_caregivers)}${stat('Caregivers who worked', d.staffing.caregivers_worked)}
      ${stat('Shifts completed', st.completed || 0)}${stat('Missed visits', st.missed || 0, { tone: st.missed ? 'danger' : '' })}${stat('Unfilled shifts', d.unfilled_shifts.length, { tone: d.unfilled_shifts.length ? 'warn' : '' })}
      ${stat('Incomplete documentation', d.incomplete_documentation.length, { tone: d.incomplete_documentation.length ? 'warn' : '' })}${stat('Open incidents', d.outstanding_incidents.length, { tone: d.outstanding_incidents.length ? 'danger' : '' })}
      ${stat('Care-plan reviews due', d.care_plan_reviews_due.length, { tone: d.care_plan_reviews_due.length ? 'warn' : '' })}</div></section>
    <div class="grid two">
      <section class="card"><h3>Admissions & discharges</h3>${list([...d.admissions.map((a) => ({ ...a, k: 'Admitted', d: a.admission_date })), ...d.discharges.map((a) => ({ ...a, k: label(a.status), d: a.discharge_date }))], (a) => `<li>${fmtDate(a.d)} — ${esc(a.legal_name)} (${esc(a.k)})</li>`, 'None this month.')}</section>
      <section class="card"><h3>Hospitalization & hospice events</h3>${list(d.hospital_and_hospice_events, (e) => `<li>${fmtDate(e.event_date)} — ${esc(e.legal_name)}: ${esc(label(e.event_type))}</li>`, 'None this month.')}</section>
      <section class="card"><h3>Missed visits</h3>${list(d.missed_visits, (m) => `<li>${fmtDate(m.date)} ${esc(m.sched_start)} — ${esc(m.caregiver || 'Unassigned')} → ${esc(m.client)}${m.override_reason ? `<div class="sub">${esc(m.override_reason)}</div>` : ''}</li>`, 'None.')}</section>
      <section class="card"><h3>Unfilled shifts</h3>${list(d.unfilled_shifts, (m) => `<li>${fmtDate(m.date)} ${esc(m.sched_start)}–${esc(m.sched_end)} — ${esc(m.client)}</li>`, 'None.')}</section>
      <section class="card"><h3>Missing / incomplete care records</h3>${list(d.incomplete_documentation, (m) => `<li>${fmtDate(m.date)} — ${esc(m.caregiver)} → ${esc(m.client)}${m.exception_note ? `<div class="sub">${esc(m.exception_note)}</div>` : ''}</li>`, 'All completed shifts are fully documented.')}</section>
      <section class="card"><h3>Outstanding incidents</h3>${list(d.outstanding_incidents, (i) => `<li>${fmtDate(i.occurred_at)} — ${esc(i.client || '—')}: ${esc(label(i.type))} ${badge(i.severity)} ${badge(i.status)}</li>`, 'None.')}</section>
      <section class="card"><h3>Expiring credentials</h3>${list(d.expiring_credentials, (c) => `<li>${esc(c.full_name)} — ${esc(c.name)}: ${fmtDate(c.expires_on)}</li>`, 'None within the warning window.')}</section>
      <section class="card"><h3>Care-plan reviews due</h3>${list(d.care_plan_reviews_due, (c) => `<li>${esc(c.legal_name)} — v${c.version}, due ${fmtDate(c.review_due)}</li>`, 'None.')}${d.clients_without_care_plan.length ? `<div class="notice warn"><strong>Active clients without a care plan</strong>${d.clients_without_care_plan.map((c) => esc(c.legal_name)).join(', ')}</div>` : ''}</section>
    </div>`;
  const csv = [['Metric', 'Value'], ['Active clients', d.active_clients], ['Admissions', d.admissions.length], ['Discharges', d.discharges.length], ['Hospital/hospice events', d.hospital_and_hospice_events.length],
    ['Shifts completed', st.completed || 0], ['Missed visits', st.missed || 0], ['Unfilled shifts', d.unfilled_shifts.length], ['Incomplete documentation', d.incomplete_documentation.length],
    ['Open incidents', d.outstanding_incidents.length], ['Expiring credentials', d.expiring_credentials.length], ['Care-plan reviews due', d.care_plan_reviews_due.length]];
  return { html, csv };
}

