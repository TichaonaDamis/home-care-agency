import { api } from '../api.js';
import {
  esc, table, badge, sampleBadge, formModal, fields, readForm, tabs, kv, fmtDate, fmtTime, fmtDT, money, hours, label, toast, showError,
  confirmDialog, opts, modal, addDays, weekStart, monthStart, monthEnd, parseYmd,
} from '../ui.js';
import { dayNames } from './clients.js';

const TABS = [['calendar', 'Calendar'], ['assignments', 'Assignments'], ['approvals', 'Timesheet approvals'], ['coverage', 'Coverage & gaps']];

export async function render(el, parts, query, ctx) {
  const tab = query.tab || 'calendar';
  el.innerHTML = `<div class="page-head"><div><h1>Assignments & Scheduling</h1><p>Caregiver–client assignments, shifts, time records and coverage.</p></div>
    <div class="page-actions">${ctx.can('schedule.manage') ? '<button class="btn ghost" id="addshift">+ Single / open shift</button><button class="btn primary" id="addasg">+ Assignment</button>' : ''}</div></div>
    ${tabs(TABS.filter(([k]) => k !== 'approvals' || ctx.can('time.approve')), tab)}<div id="tab"></div>`;
  el.querySelector('.tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) location.hash = `#/schedule?tab=${t.dataset.tab}`;
  });
  const reload = () => render(el, parts, query, ctx);
  el.querySelector('#addasg')?.addEventListener('click', async () => { if (await assignmentDialog(ctx)) reload(); });
  el.querySelector('#addshift')?.addEventListener('click', async () => { if (await shiftDialog(ctx)) reload(); });
  const box = el.querySelector('#tab');
  await ({ calendar, assignments, approvals, coverage }[tab] || calendar)(box, query, ctx, reload);
}

/** POST/PATCH that may return 409 with scheduling warnings; asks for an override reason and retries. */
export async function withOverride(send, payload) {
  try {
    return await send(payload);
  } catch (e) {
    if (e.status !== 409 || !e.details?.warnings) throw e;
    const reason = await modal({
      title: 'Scheduling warnings',
      body: `<form class="form"><div class="notice warn"><strong>Please review before continuing</strong><ul>${e.details.warnings.map((w) => `<li>${esc(w.message)}</li>`).join('')}</ul></div>
        ${fields([{ name: 'reason', label: 'Override reason (recorded in the audit log)', type: 'textarea', required: true, full: true }])}
        <div class="actions"><button class="btn primary" type="submit">Override and save</button><button class="btn ghost" type="button" data-close>Go back</button></div></form>`,
      onMount: (m, close) => m.querySelector('form').addEventListener('submit', (ev) => { ev.preventDefault(); close(m.querySelector('[name=reason]').value.trim()); }),
    });
    if (!reason) throw Object.assign(new Error('Not saved — warnings were not overridden.'), { details: null });
    return send({ ...payload, override_reason: reason });
  }
}

async function people() {
  const [cgs, cls] = await Promise.all([api.get('/caregivers', { status: 'active' }), api.get('/clients')]);
  return { cgs, cls };
}

export async function assignmentDialog(ctx, values = {}) {
  const lk = await ctx.lookups();
  const { cgs, cls } = await people();
  const fin = ctx.can('finance.view');
  return formModal({
    title: 'New assignment', wide: true,
    intro: '<p class="hint">A caregiver can be assigned to several clients, and a client can have several caregivers. New assignments need supervisor approval before shifts are generated.</p>',
    defs: [
      { name: 'caregiver_id', label: 'Caregiver', type: 'select', required: true, options: opts(cgs, 'full_name') },
      { name: 'client_id', label: 'Client', type: 'select', required: true, options: opts(cls.filter((c) => c.status === 'active'), 'legal_name') },
      { name: 'facility_id', label: 'Location', type: 'select', options: opts(lk.facilities) },
      { name: 'service_type_id', label: 'Service', type: 'select', options: opts(lk.service_types.filter((s) => s.active)), hint: 'Determines the client billing rate.' },
      { name: 'start_date', label: 'Start date', type: 'date', required: true, value: ctx.today() },
      { name: 'end_date', label: 'End date', type: 'date', hint: 'Blank = ongoing' },
      { name: 'days_of_week', label: 'Scheduled days', type: 'checks', full: true, options: [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']], value: ['1', '2', '3', '4', '5'] },
      { name: 'shift_start', label: 'Shift start', type: 'time', required: true, value: '08:00' },
      { name: 'shift_end', label: 'Shift end', type: 'time', required: true, value: '12:00' },
      ...(fin ? [{ name: 'pay_rate', label: 'Pay rate override ($/h)', type: 'money', hint: 'Blank = caregiver’s standard rate' }, { name: 'bill_rate', label: 'Bill rate override ($)', type: 'money', hint: 'Blank = client’s service rate' }] : []),
      { name: 'responsibilities', label: 'Assigned services & responsibilities', type: 'textarea', full: true },
    ],
    values,
    submit: (v) => withOverride((p) => api.post('/assignments', p), v),
  });
}

async function shiftDialog(ctx) {
  const lk = await ctx.lookups();
  const { cgs, cls } = await people();
  return formModal({
    title: 'Add a shift',
    intro: '<p class="hint">Leave the caregiver blank to create an <strong>open (unfilled)</strong> shift.</p>',
    defs: [
      { name: 'client_id', label: 'Client', type: 'select', required: true, options: opts(cls.filter((c) => c.status === 'active'), 'legal_name') },
      { name: 'caregiver_id', label: 'Caregiver', type: 'select', options: opts(cgs, 'full_name'), placeholder: '— Open shift —' },
      { name: 'service_type_id', label: 'Service', type: 'select', options: opts(lk.service_types.filter((s) => s.active)) },
      { name: 'facility_id', label: 'Location', type: 'select', options: opts(lk.facilities) },
      { name: 'date', label: 'Date', type: 'date', required: true, value: ctx.today() },
      { name: 'sched_start', label: 'Start', type: 'time', required: true }, { name: 'sched_end', label: 'End', type: 'time', required: true },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    submit: (v) => withOverride((p) => api.post('/shifts', p), v),
  });
}

// ================= calendar =================
async function calendar(box, query, ctx, reload) {
  const view = query.view || 'week';
  const anchor = query.date || ctx.today();
  let from, to;
  if (view === 'day') { from = anchor; to = anchor; }
  else if (view === 'week') { from = weekStart(anchor); to = addDays(from, 6); }
  else { from = weekStart(monthStart(anchor)); to = addDays(weekStart(monthEnd(anchor)), 6); }
  const [{ cgs, cls }, shifts] = await Promise.all([people(), api.get('/shifts', { from, to, caregiver_id: query.caregiver_id, client_id: query.client_id, status: query.status })]);
  const step = view === 'day' ? 1 : view === 'week' ? 7 : 0;
  const prev = view === 'month' ? addDays(monthStart(anchor), -1) : addDays(anchor, -step);
  const next = view === 'month' ? addDays(monthEnd(anchor), 1) : addDays(anchor, step);
  const q = (o) => `#/schedule${api.qs({ tab: 'calendar', view, date: anchor, caregiver_id: query.caregiver_id, client_id: query.client_id, status: query.status, ...o })}`;
  const title = view === 'day' ? fmtDate(anchor, { weekday: 'long' }) : view === 'week' ? `${fmtDate(from)} – ${fmtDate(to)}` : parseYmd(anchor).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const byDate = {};
  for (const s of shifts) (byDate[s.date] ||= []).push(s);
  const ev = (s) => `<a class="ev ${esc(s.caregiver_id ? s.status : 'open')}" data-shift="${s.id}" title="${esc(`${s.sched_start}–${s.sched_end} ${s.caregiver_name || 'OPEN'} → ${s.client_name} (${s.status})`)}">${esc(s.sched_start)} ${esc(s.caregiver_name?.split(' ')[0] || 'OPEN')} → ${esc(s.client_name.split(' ')[0])}</a>`;
  let body;
  if (view === 'day') {
    body = table([
      { label: 'Time', render: (s) => `${esc(s.sched_start)}–${esc(s.sched_end)}` },
      { label: 'Caregiver', render: (s) => (s.caregiver_name ? esc(s.caregiver_name) : badge('open', 'Unfilled')) },
      { label: 'Client', render: (s) => `${esc(s.client_name)}${s.room ? `<div class="sub">Rm ${esc(s.room)}</div>` : ''}` },
      { label: 'Service', render: (s) => esc(s.service_name || '—') },
      { label: 'Status', render: (s) => badge(s.status) },
      { label: 'Actual', render: (s) => (s.actual_start ? `${fmtTime(s.actual_start)}–${s.actual_end ? fmtTime(s.actual_end) : '…'}` : '—') },
      { label: '', render: (s) => `<button class="btn link" data-shift="${s.id}">Open</button>` },
    ], shifts, { empty: 'No shifts scheduled this day.' });
  } else {
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    body = `<div class="cal">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dow">${d}</div>`).join('')}
      ${days.map((d) => `<div class="day${view === 'month' && d.slice(0, 7) !== anchor.slice(0, 7) ? ' out' : ''}${d === ctx.today() ? ' today' : ''}">
        <div class="d"><a href="${q({ view: 'day', date: d })}">${parseYmd(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</a></div>
        ${(byDate[d] || []).map(ev).join('')}</div>`).join('')}</div>`;
  }
  const counts = shifts.reduce((m, s) => { m[s.caregiver_id ? s.status : 'open'] = (m[s.caregiver_id ? s.status : 'open'] || 0) + 1; return m; }, {});
  box.innerHTML = `<section class="card">
    <div class="card-head"><div class="actions"><a class="btn ghost small" href="${q({ date: prev })}" aria-label="Previous">◀</a><a class="btn ghost small" href="${q({ date: ctx.today() })}">Today</a><a class="btn ghost small" href="${q({ date: next })}" aria-label="Next">▶</a><h2>${esc(title)}</h2></div>
      <div class="seg" role="group" aria-label="View">${['day', 'week', 'month'].map((v) => `<button class="${v === view ? 'on' : ''}" data-view="${v}">${label(v)}</button>`).join('')}</div></div>
    <form class="filters" id="filters">${fields([
    { name: 'caregiver_id', label: 'Caregiver', type: 'select', options: opts(cgs, 'full_name'), value: query.caregiver_id },
    { name: 'client_id', label: 'Client', type: 'select', options: opts(cls, 'legal_name'), value: query.client_id },
    { name: 'status', label: 'Shift status', type: 'select', options: ['open', 'scheduled', 'in_progress', 'completed', 'missed', 'cancelled'].map((s) => [s, label(s)]), value: query.status },
  ])}</form>
    <p class="hint">${Object.entries(counts).map(([k, n]) => `${badge(k)} ${n}`).join(' ') || 'No shifts in range.'}</p>
    ${body}</section>`;
  box.querySelector('.seg').addEventListener('click', (e) => { const v = e.target.dataset.view; if (v) location.hash = q({ view: v }); });
  box.querySelector('#filters').addEventListener('change', (e) => { const v = readForm(e.currentTarget); location.hash = q({ caregiver_id: v.caregiver_id, client_id: v.client_id, status: v.status }); });
  box.addEventListener('click', async (e) => {
    const sid = e.target.closest('[data-shift]')?.dataset.shift;
    if (sid) { e.preventDefault(); if (await shiftDetail(Number(sid), ctx)) reload(); }
  });
}

/** Staff view of a shift with supervisor actions. Resolves true if something changed. */
export async function shiftDetail(id, ctx) {
  const s = await api.get(`/shifts/${id}`);
  const manage = ctx.can('schedule.manage');
  const approve = ctx.can('time.approve');
  const d = s.docs;
  return modal({
    title: `Shift #${s.id} — ${s.client.legal_name}`, wide: true,
    body: `<div class="grid two"><div>${kv([
      ['Date', fmtDate(s.date, { weekday: 'short' })], ['Scheduled', `${esc(s.sched_start)}–${esc(s.sched_end)}`],
      ['Status', `${badge(s.caregiver_id ? s.status : 'open', s.caregiver_id ? undefined : 'Unfilled')} ${s.status === 'completed' ? badge(s.approval_status) : ''}`],
      ['Actual', s.actual_start ? `${fmtDT(s.actual_start)} → ${s.actual_end ? fmtDT(s.actual_end) : 'in progress'}` : '—'],
      ['Worked', `${hours(s.worked_hours)} h · break ${s.break_min} min · ${s.mileage} mi`],
      ...(s.pay_rate_cents != null ? [['Pay rate (frozen)', `${money(s.pay_rate_cents)}/h`]] : []),
      ...(s.bill_rate_cents != null ? [['Bill rate (frozen)', `${money(s.bill_rate_cents)} ${esc(label(s.bill_method || ''))}`]] : []),
      ['Documentation', s.status === 'completed' ? (s.doc_complete ? badge('complete') : badge('incomplete')) : '—'],
      ['Exceptions', esc(s.exception_note || '—')], ['Override reason', esc(s.override_reason || '—')], ['Notes', esc(s.notes || '—')],
    ])}</div><div>
      <h3>Documentation</h3>
      <ul class="list">
        <li>ADL tasks: ${d.adl.length} (${d.adl.filter((x) => x.status === 'completed').length} completed)</li>
        <li>Meals / fluids: ${d.meals.length}</li><li>Activities: ${d.activities.length}</li><li>Observations: ${d.observations.length}</li>
        <li>Medication records: ${d.med_events.length}</li><li>Measurements: ${d.measurements.length}</li><li>Incidents: ${d.incidents.length}</li>
      </ul>
      ${s.outstanding.length ? `<div class="notice warn"><strong>Outstanding</strong>${s.outstanding.map((o) => esc(o.text)).join('<br>')}</div>` : ''}
    </div></div>`,
    footer: [
      approve && s.status === 'completed' && s.approval_status !== 'approved' ? '<button class="btn primary" data-act="approve">Approve time</button>' : '',
      approve && s.status === 'completed' && s.approval_status !== 'rejected' ? '<button class="btn ghost" data-act="reject">Reject</button>' : '',
      manage && ['completed', 'in_progress'].includes(s.status) ? '<button class="btn ghost" data-act="time">Correct time record</button>' : '',
      manage && ['scheduled', 'open'].includes(s.status) ? '<button class="btn ghost" data-act="assign">Reassign / reschedule</button>' : '',
      manage && ['scheduled', 'open'].includes(s.status) ? '<button class="btn ghost" data-act="missed">Mark missed</button><button class="btn ghost" data-act="cancel">Cancel shift</button>' : '',
      '<button class="btn ghost" data-close>Close</button>',
    ].join(''),
    onMount: (m, close) => m.addEventListener('click', async (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      try {
        if (act === 'approve') { await api.post(`/shifts/${id}/approve`); toast('Approved.', 'ok'); return close(true); }
        if (act === 'reject') { const r = await confirmDialog('Reject this time record?', { reason: true, danger: true, okLabel: 'Reject' }); if (r) { await api.post(`/shifts/${id}/reject`, { reason: r }); return close(true); } }
        if (act === 'missed' || act === 'cancel') {
          const r = await confirmDialog(act === 'missed' ? 'Mark this shift as missed?' : 'Cancel this shift?', { reason: true, danger: true });
          if (r) { await api.post(`/shifts/${id}/status`, { status: act === 'missed' ? 'missed' : 'cancelled', reason: r }); return close(true); }
        }
        if (act === 'time') {
          const ok = await formModal({
            title: 'Correct time record', intro: '<p class="hint">Changes reset approval and are recorded with your reason in the audit log.</p>',
            defs: [{ name: 'actual_start', label: 'Actual start', type: 'datetime', required: true }, { name: 'actual_end', label: 'Actual end', type: 'datetime' }, { name: 'break_min', label: 'Break (min)', type: 'number', min: 0 }, { name: 'mileage', label: 'Mileage', type: 'number', step: '0.1', min: 0 }, { name: 'reason', label: 'Reason for correction', type: 'textarea', required: true, full: true }],
            values: s, submit: (v) => api.patch(`/shifts/${id}`, v),
          });
          if (ok) return close(true);
        }
        if (act === 'assign') {
          const { cgs } = await people();
          const ok = await formModal({
            title: 'Reassign / reschedule',
            defs: [{ name: 'caregiver_id', label: 'Caregiver', type: 'select', options: opts(cgs, 'full_name'), placeholder: '— Open shift —' }, { name: 'date', label: 'Date', type: 'date', required: true }, { name: 'sched_start', label: 'Start', type: 'time', required: true }, { name: 'sched_end', label: 'End', type: 'time', required: true }],
            values: s, submit: (v) => withOverride((p) => api.patch(`/shifts/${id}`, p), { ...v, status: v.caregiver_id ? 'scheduled' : 'open' }),
          });
          if (ok) return close(true);
        }
      } catch (err) { showError(err); }
    }),
  });
}

// ================= assignments =================
async function assignments(box, query, ctx, reload) {
  const [{ cgs, cls }, rows] = await Promise.all([people(), api.get('/assignments', { caregiver_id: query.caregiver_id, client_id: query.client_id, status: query.status })]);
  const fin = ctx.can('finance.view');
  box.innerHTML = `<section class="card">
    <form class="filters" id="filters">${fields([
    { name: 'caregiver_id', label: 'Caregiver', type: 'select', options: opts(cgs, 'full_name'), value: query.caregiver_id },
    { name: 'client_id', label: 'Client', type: 'select', options: opts(cls, 'legal_name'), value: query.client_id },
    { name: 'status', label: 'Status', type: 'select', options: ['pending', 'active', 'ended', 'cancelled'].map((s) => [s, label(s)]), value: query.status },
  ])}</form>
    ${table([
    { label: 'Caregiver', render: (a) => `<a href="#/caregivers/${a.caregiver_id}">${esc(a.caregiver_name)}</a>${sampleBadge(a)}` },
    { label: 'Client', render: (a) => `<a href="#/clients/${a.client_id}">${esc(a.client_name)}</a><div class="sub">${esc(a.service_name || '')}</div>` },
    { label: 'Days & time', render: (a) => `${esc(dayNames(a.days_of_week))}<div class="sub">${esc(a.shift_start)}–${esc(a.shift_end)}</div>` },
    { label: 'Dates', render: (a) => `${fmtDate(a.start_date)} → ${a.end_date ? fmtDate(a.end_date) : 'ongoing'}` },
    ...(fin ? [{ label: 'Rate overrides', render: (a) => `${a.pay_rate_cents != null ? `Pay ${money(a.pay_rate_cents)}` : ''}${a.bill_rate_cents != null ? `<div>Bill ${money(a.bill_rate_cents)}</div>` : ''}` || '—' }] : []),
    { label: 'Status', render: (a) => `${badge(a.status)}${a.approved_by_name ? `<div class="sub">by ${esc(a.approved_by_name)}</div>` : ''}${a.override_reason ? `<div class="sub" title="${esc(a.override_reason)}">override noted</div>` : ''}` },
    { label: '', render: (a) => [
      a.status === 'pending' && ctx.can('time.approve') ? `<button class="btn link" data-approve="${a.id}">Approve</button>` : '',
      a.status === 'active' && ctx.can('schedule.manage') ? `<button class="btn link" data-gen="${a.id}">Generate shifts</button>` : '',
      ['pending', 'active'].includes(a.status) && ctx.can('schedule.manage') ? `<button class="btn link" data-end="${a.id}">End</button>` : '',
    ].join('') },
  ], rows, { empty: 'No assignments match these filters.' })}</section>`;
  box.querySelector('#filters').addEventListener('change', (e) => { location.hash = `#/schedule${api.qs({ tab: 'assignments', ...readForm(e.currentTarget) })}`; });
  box.addEventListener('click', async (e) => {
    const { approve, gen, end } = e.target.dataset;
    try {
      if (approve && await confirmDialog('Approve this assignment? Shifts can then be generated.', { okLabel: 'Approve' })) { await api.post(`/assignments/${approve}/approve`); reload(); }
      if (gen) {
        const r = await formModal({
          title: 'Generate shifts', intro: '<p class="hint">Creates scheduled shifts on the assignment’s days. Days with conflicts or unapproved overtime are skipped unless you enter an override reason.</p>',
          defs: [{ name: 'from', label: 'From', type: 'date', required: true, value: ctx.today() }, { name: 'to', label: 'To', type: 'date', required: true, value: addDays(ctx.today(), 27) }, { name: 'override_reason', label: 'Override reason (optional)', type: 'textarea', full: true }],
          submit: (v) => api.post(`/assignments/${gen}/generate`, v),
        });
        if (r) {
          await modal({ title: 'Shifts generated', body: `<p>${r.created} shift(s) created.</p>${r.skipped.length ? `<div class="notice warn"><strong>${r.skipped.length} day(s) skipped</strong><ul>${r.skipped.map((s) => `<li>${esc(s.date)}: ${s.warnings.map((w) => esc(w.message)).join('; ')}</li>`).join('')}</ul></div>` : ''}<div class="actions"><button class="btn primary" data-close>OK</button></div>` });
          reload();
        }
      }
      if (end && await formModal({ title: 'End assignment', intro: '<p class="hint">Unstarted shifts after the end date will be cancelled.</p>', defs: [{ name: 'end_date', label: 'Last day', type: 'date', required: true, value: ctx.today() }], submit: (v) => api.patch(`/assignments/${end}`, { ...v, status: 'ended' }) })) reload();
    } catch (err) { showError(err); }
  });
}

// ================= approvals =================
async function approvals(box, query, ctx, reload) {
  const from = query.from || addDays(ctx.today(), -30);
  const to = query.to || ctx.today();
  const rows = await api.get('/shifts', { from, to, status: 'completed', approval_status: query.approval_status || 'pending', caregiver_id: query.caregiver_id });
  const { cgs } = await people();
  box.innerHTML = `<section class="card">
    <div class="card-head"><h2>Completed shifts awaiting approval</h2><button class="btn primary small" id="approveSel">Approve selected</button></div>
    <form class="filters" id="filters">${fields([
    { name: 'from', label: 'From', type: 'date', value: from }, { name: 'to', label: 'To', type: 'date', value: to },
    { name: 'caregiver_id', label: 'Caregiver', type: 'select', options: opts(cgs, 'full_name'), value: query.caregiver_id },
    { name: 'approval_status', label: 'Approval', type: 'select', required: true, options: [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']], value: query.approval_status || 'pending' },
  ])}</form>
    ${table([
    { label: '<input type="checkbox" id="all" aria-label="Select all">', html: true, render: (s) => (s.approval_status === 'pending' ? `<input type="checkbox" data-sel="${s.id}" aria-label="Select shift ${s.id}">` : '') },
    { label: 'Date', render: (s) => fmtDate(s.date, { weekday: 'short' }) },
    { label: 'Caregiver', render: (s) => esc(s.caregiver_name) }, { label: 'Client', render: (s) => esc(s.client_name) },
    { label: 'Scheduled', render: (s) => `${esc(s.sched_start)}–${esc(s.sched_end)}<div class="sub">${hours(s.sched_hours)} h</div>` },
    { label: 'Actual', render: (s) => `${fmtTime(s.actual_start)}–${fmtTime(s.actual_end)}<div class="sub">break ${s.break_min}m · ${s.mileage} mi</div>` },
    { label: 'Hours', num: true, render: (s) => hours(s.worked_hours), total: (r) => r.reduce((t, s) => t + s.worked_hours, 0), fmt: hours },
    { label: 'Docs', render: (s) => (s.doc_complete ? badge('complete') : badge('incomplete')) },
    { label: 'Exceptions', cls: 'wrap', render: (s) => `<span class="sub">${esc(s.exception_note || '')}</span>` },
    { label: '', render: (s) => `<button class="btn link" data-open="${s.id}">Review</button>` },
  ], rows, { empty: 'Nothing waiting for approval.' })}</section>`;
  box.querySelector('#filters').addEventListener('change', (e) => { location.hash = `#/schedule${api.qs({ tab: 'approvals', ...readForm(e.currentTarget) })}`; });
  box.querySelector('#all')?.addEventListener('change', (e) => box.querySelectorAll('[data-sel]').forEach((c) => { c.checked = e.target.checked; }));
  box.querySelector('#approveSel').addEventListener('click', async () => {
    const ids = [...box.querySelectorAll('[data-sel]:checked')].map((c) => Number(c.dataset.sel));
    if (!ids.length) return toast('Select shifts to approve.');
    try { const r = await api.post('/shifts/approve-batch', { ids }); toast(`${r.approved} shift(s) approved.`, 'ok'); reload(); } catch (err) { showError(err); }
  });
  box.addEventListener('click', async (e) => { const id = e.target.dataset.open; if (id && await shiftDetail(Number(id), ctx)) reload(); });
}

// ================= coverage =================
async function coverage(box, query, ctx, reload) {
  const from = query.from || ctx.today();
  const to = query.to || addDays(from, 13);
  const c = await api.get('/coverage', { from, to });
  box.innerHTML = `<form class="filters card" id="filters">${fields([{ name: 'from', label: 'From', type: 'date', value: from }, { name: 'to', label: 'To', type: 'date', value: to }])}</form>
    <div class="grid two">
      <section class="card"><h2>Unfilled shifts</h2>${table([
    { label: 'Date', render: (s) => fmtDate(s.date, { weekday: 'short' }) }, { label: 'Time', render: (s) => `${esc(s.sched_start)}–${esc(s.sched_end)}` },
    { label: 'Client', render: (s) => esc(s.client_name) }, { label: '', render: (s) => `<button class="btn link" data-shift="${s.id}">Fill</button>` },
  ], c.open_shifts, { empty: 'No unfilled shifts. ✓' })}</section>
      <section class="card"><h2>Active clients without scheduled care</h2>${table([
    { label: 'Client', render: (x) => `<a href="#/clients/${x.id}">${esc(x.legal_name)}</a>` }, { label: 'ID', render: (x) => esc(x.code) },
  ], c.clients_without_coverage, { empty: 'Every active client has scheduled care in this period. ✓' })}</section>
      <section class="card"><h2>Assignments missing generated shifts</h2>${table([
    { label: 'Assignment', render: (x) => `${esc(x.caregiver_name)} → ${esc(x.client_name)}` }, { label: 'Days missing', num: true, render: (x) => x.missing_days },
  ], c.ungenerated, { empty: 'All active assignments have shifts in this period. ✓' })}<p class="hint">Use “Generate shifts” on the Assignments tab.</p></section>
      <section class="card"><h2>Assignments awaiting approval</h2>${table([{ label: 'Assignment', render: (x) => `${esc(x.caregiver_name)} → ${esc(x.client_name)}` }], c.pending_assignments, { empty: 'None. ✓' })}</section>
    </div>`;
  box.querySelector('#filters').addEventListener('change', (e) => { location.hash = `#/schedule${api.qs({ tab: 'coverage', ...readForm(e.currentTarget) })}`; });
  box.addEventListener('click', async (e) => { const id = e.target.dataset.shift; if (id && await shiftDetail(Number(id), ctx)) reload(); });
}

