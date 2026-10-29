// Caregiver self-service: shifts, clock in/out, documentation, own timesheet, incidents, profile.
import { api } from '../api.js';
import {
  esc, onClick, table, badge, fields, kv, fmtDate, fmtTime, fmtDT, money, hours, label, toast, showError, modal, onSubmit, empty, stat, addDays, weekStart, formModal,
} from '../ui.js';
import { adlDialog, mealDialog, activityDialog, observationDialog, measurementDialog, incidentDialog } from './shared.js';

let timer;
export async function render(el, parts, query, ctx) {
  clearInterval(timer);
  const sub = parts[0];
  if (sub === 'shift') return shiftPage(el, Number(parts[1]), ctx);
  if (sub === 'client') return clientPage(el, Number(parts[1]), ctx);
  if (sub === 'timesheet') return timesheetPage(el, query, ctx);
  if (sub === 'incident') return incidentPage(el, ctx);
  if (sub === 'profile') return profilePage(el, ctx);
  return home(el, ctx);
}

// ================= home =================
async function home(el, ctx) {
  const d = await api.get('/me/dashboard');
  const a = d.active_shift;
  el.innerHTML = `
    <div class="page-head"><div><h1>Hello, ${esc(d.profile.full_name.split(' ')[0])}</h1><p>${fmtDate(ctx.today(), { weekday: 'long' })}</p></div></div>
    ${a ? `<section class="shift-card active"><div class="card-head"><h2>On shift with ${esc(a.client_name)}</h2>${badge('in_progress')}</div>
      <div class="timer" id="timer" data-start="${esc(a.actual_start)}">--:--:--</div>
      <p class="hint">Started ${fmtDT(a.actual_start)} · scheduled ${esc(a.sched_start)}–${esc(a.sched_end)}</p>
      ${a.outstanding.length ? `<div class="notice warn"><strong>${a.outstanding.length} item(s) still to document</strong>${a.outstanding.map((o) => esc(o.text)).join('<br>')}</div>` : '<div class="notice ok"><strong>Documentation complete</strong>You can end the shift when you are done.</div>'}
      <a class="btn primary big" href="#/my/shift/${a.id}">Open shift & document care</a></section>` : ''}
    <div class="stats">
      ${stat('Hours worked this week', hours(d.week.worked_hours), { sub: `Scheduled ${hours(d.week.scheduled_hours)}` })}
      ${stat('Approved this week', hours(d.week.approved_hours), { tone: 'info' })}
      ${stat('Documentation to finish', d.incomplete_docs.length, { tone: d.incomplete_docs.length ? 'warn' : '' })}
    </div>
    <div class="grid two">
      <section class="card"><h2>Today</h2>${d.today.length ? d.today.map((s) => shiftCard(s, !a)).join('') : empty('No more shifts scheduled today.')}
        ${!a && d.clients.length ? '<button class="btn ghost" id="unsched">Start an unscheduled visit</button>' : ''}</section>
      <section class="card"><h2>Upcoming (7 days)</h2>${d.upcoming.length ? `<ul class="list">${d.upcoming.map((s) => `<li><strong>${fmtDate(s.date, { weekday: 'short' })}</strong> ${esc(s.sched_start)}–${esc(s.sched_end)} · ${esc(s.client_name)}${s.room ? ` (Rm ${esc(s.room)})` : ''}</li>`).join('')}</ul>` : empty('Nothing scheduled.')}</section>
      <section class="card"><h2>My clients</h2>${d.clients.length ? `<ul class="list">${d.clients.map((c) => `<li><a href="#/my/client/${c.id}"><strong>${esc(c.legal_name)}</strong></a>${c.preferred_name ? ` “${esc(c.preferred_name)}”` : ''} ${c.status !== 'active' ? badge(c.status) : ''}</li>`).join('')}</ul>` : empty('You have no active client assignments.')}</section>
      <section class="card"><h2>Finish documentation</h2>${d.incomplete_docs.length ? `<ul class="list">${d.incomplete_docs.map((s) => `<li><a href="#/my/shift/${s.id}">${fmtDate(s.date)} · ${esc(s.client_name)}</a></li>`).join('')}</ul>` : empty('All caught up. ✓', '✓')}</section>
    </div>`;
  startTimer(el, d.now);
  onClick(el, async (e) => {
    const id = e.target.dataset.start;
    if (id) { if (await startShift(Number(id))) location.hash = `#/my/shift/${id}`; }
  });
  el.querySelector('#unsched')?.addEventListener('click', async () => {
    const r = await formModal({
      title: 'Unscheduled visit', intro: '<p class="hint">Use only when the office has asked you to provide care outside your schedule. The visit needs supervisor approval.</p>',
      defs: [{ name: 'client_id', label: 'Client', type: 'select', required: true, options: d.clients.filter((c) => c.status === 'active').map((c) => [c.id, c.legal_name]) }, { name: 'reason', label: 'Reason / who asked', type: 'textarea', required: true, full: true }],
      submit: (v) => api.post('/shifts/clock-in', v),
    });
    if (r && await startShift(r.id)) location.hash = `#/my/shift/${r.id}`;
  });
}

const shiftCard = (s, canStart) => `<div class="shift-card"><div class="card-head"><strong>${esc(s.sched_start)}–${esc(s.sched_end)} · ${esc(s.client_name)}</strong>${badge(s.status)}</div>
  <span class="hint">${esc(s.service_name || '')}${s.room ? ` · Room ${esc(s.room)}` : ''}</span>
  ${canStart ? `<button class="btn primary" data-start="${s.id}">Start shift</button>` : ''}</div>`;

/**
 * Elapsed-time display. Shift times are agency-local wall-clock strings, so elapsed time is measured
 * against the server's agency-local "now" (not the browser's time zone).
 */
function startTimer(el, serverNow) {
  const t = el.querySelector('#timer');
  if (!t || !serverNow) return;
  const asUtc = (s) => Date.parse(`${s}:00Z`);
  const start = asUtc(t.dataset.start);
  const base = asUtc(serverNow);
  const t0 = Date.now();
  const tick = () => {
    const s = Math.max(0, Math.floor((base + (Date.now() - t0) - start) / 1000));
    t.textContent = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
  };
  tick();
  timer = setInterval(tick, 1000);
}

/** Start a shift, handling care-plan acknowledgement and clock-in window exceptions. */
async function startShift(id, extra = {}) {
  try {
    await api.post(`/shifts/${id}/start`, extra);
    toast('Shift started.', 'ok');
    return true;
  } catch (e) {
    if (e.details?.code === 'ACK_REQUIRED') {
      const s = await api.get(`/shifts/${id}`);
      const ok = await ackDialog(s.client_id);
      return ok ? startShift(id, extra) : false;
    }
    if (e.details?.code === 'OUTSIDE_WINDOW') {
      const reason = await modal({
        title: 'Outside the clock-in window',
        body: `<form class="form"><p>${esc(e.message)}</p>${fields([{ name: 'r', label: 'Reason (sent to your supervisor)', type: 'textarea', required: true, full: true }])}<div class="actions"><button class="btn primary" type="submit">Clock in with exception</button><button class="btn ghost" type="button" data-close>Cancel</button></div></form>`,
        onMount: (m, close) => m.querySelector('form').addEventListener('submit', (ev) => { ev.preventDefault(); close(m.querySelector('[name=r]').value.trim()); }),
      });
      return reason ? startShift(id, { exception_reason: reason }) : false;
    }
    showError(e);
    return false;
  }
}

async function ackDialog(clientId) {
  const c = await api.get(`/clients/${clientId}`);
  const p = c.care_plan;
  return modal({
    title: `Care plan — ${c.legal_name}`, wide: true,
    body: `<div class="notice warn"><strong>Please read before starting care</strong>You must acknowledge the current care plan (version ${p.version}).</div><br>${planView(c)}
      <div class="actions"><button class="btn primary" id="ack">I have read and will follow this care plan</button><button class="btn ghost" data-close>Not now</button></div>`,
    onMount: (m, close) => m.querySelector('#ack').addEventListener('click', async () => {
      try { await api.post(`/care-plans/${p.id}/ack`); toast('Acknowledged.', 'ok'); close(true); } catch (err) { showError(err); }
    }),
  });
}

function planView(c) {
  const p = c.care_plan;
  if (!p) return empty('No care plan on file. Ask your supervisor for instructions.');
  return `${c.allergies || c.alerts ? `<div class="notice danger">${c.allergies ? `<strong>Allergies: ${esc(c.allergies)}</strong>` : ''}${esc(c.alerts || '')}</div><br>` : ''}
    ${kv([['Summary', esc(p.summary)], ['Goals', esc(p.goals)], ['Instructions', esc(p.instructions)],
    ['Tasks to document each shift', p.adl_tasks ? `<ul>${p.adl_tasks.split('\n').filter(Boolean).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '—'],
    ['Mobility', esc(p.mobility)], ['Diet', esc(p.diet || c.diet)], ['Behavior support', esc(p.behavior_support)], ['Fluid goal', c.min_fluid_ml ? `${c.min_fluid_ml} mL/day` : '—'],
    ['Effective', `${fmtDate(p.effective_date)} (version ${p.version})`]])}`;
}

// ================= shift documentation =================
async function shiftPage(el, id, ctx) {
  const s = await api.get(`/shifts/${id}`);
  const c = await api.get(`/clients/${s.client_id}`).catch(() => null);
  const types = await api.get('/measurement-types');
  const live = s.status === 'in_progress';
  const canDoc = ['in_progress', 'completed'].includes(s.status) && s.approval_status !== 'approved';
  const tasks = (c?.care_plan?.adl_tasks || '').split('\n').map((t) => t.trim()).filter(Boolean);
  const d = s.docs;
  const step = (done, title, detail, btn) => `<div class="step ${done ? 'done' : ''}"><span aria-hidden="true">${done ? '✓' : '○'}</span><div class="grow"><strong>${esc(title)}</strong><div class="hint">${detail}</div></div>${btn}</div>`;
  const outKinds = new Set(s.outstanding.map((o) => o.kind));
  el.innerHTML = `
    <div class="page-head"><div><a class="hint" href="#/my">← My dashboard</a><h1>${esc(s.client.legal_name)}${s.client.preferred_name ? ` <span class="hint">“${esc(s.client.preferred_name)}”</span>` : ''}</h1>
      <p>${fmtDate(s.date, { weekday: 'long' })} · ${esc(s.sched_start)}–${esc(s.sched_end)} · ${badge(s.status)} ${s.status === 'completed' ? badge(s.approval_status) : ''}</p></div>
      <div class="page-actions">${c ? `<a class="btn ghost" href="#/my/client/${s.client_id}">Care plan</a>` : ''}<button class="btn ghost" id="incident">Report incident</button></div></div>
    ${c && (c.allergies || c.alerts) ? `<div class="notice danger">${c.allergies ? `<strong>Allergies: ${esc(c.allergies)}</strong>` : ''}${esc(c.alerts || '')}</div>` : ''}
    ${live ? `<section class="shift-card active"><div class="timer" id="timer" data-start="${esc(s.actual_start)}"></div><p class="hint">Started ${fmtDT(s.actual_start)}</p></section>` : ''}
    ${s.status === 'scheduled' ? `<section class="card"><p>This shift has not started.</p><button class="btn primary big" id="start">Start shift</button></section>` : ''}
    ${canDoc ? `<section class="card"><h2>Document care</h2><div class="doc-steps">
      ${step(!outKinds.has('adl') && d.adl.length > 0, 'Activities of daily living', `${d.adl.length} recorded${tasks.length ? ` · ${tasks.length} required by care plan` : ''}`, '<button class="btn ghost small" data-doc="adl">Record</button>')}
      ${step(d.meals.length > 0, 'Meals & fluids (optional)', `${d.meals.length} entr${d.meals.length === 1 ? 'y' : 'ies'}${d.meals.length ? ` · ${d.meals.reduce((t, m) => t + (m.fluid_ml || 0), 0)} mL fluids` : ''}`, '<button class="btn ghost small" data-doc="meal">Add</button>')}
      ${step(d.activities.length > 0, 'Activities (optional)', `${d.activities.length} recorded`, '<button class="btn ghost small" data-doc="activity">Add</button>')}
      ${step(!outKinds.has('medication'), 'Medications', `${d.med_events.length} recorded${outKinds.has('medication') ? ` · ${s.outstanding.filter((o) => o.kind === 'medication').length} scheduled dose(s) to document` : ''}`, '<button class="btn ghost small" data-doc="meds">Record</button>')}
      ${step(d.measurements.length > 0, 'Health measurements (if ordered)', `${d.measurements.length} recorded`, '<button class="btn ghost small" data-doc="vitals">Record</button>')}
      ${step(!outKinds.has('observation'), 'Condition, mood & behavior', `${d.observations.length} recorded`, '<button class="btn ghost small" data-doc="obs">Record</button>')}
    </div></section>` : ''}
    ${s.outstanding.length && canDoc ? `<div class="notice warn"><strong>Outstanding before you finish</strong>${s.outstanding.map((o) => esc(o.text)).join('<br>')}</div>` : ''}
    ${live ? '<section class="card"><h2>Finish</h2><button class="btn danger big" id="end">End shift</button></section>' : ''}
    ${s.status === 'completed' ? `<section class="card"><h2>Time record</h2>${kv([['Worked', `${fmtDT(s.actual_start)} → ${fmtDT(s.actual_end)}`], ['Hours', `${hours(s.worked_hours)} (break ${s.break_min} min)`], ['Mileage', s.mileage], ['Documentation', s.doc_complete ? badge('complete') : badge('incomplete')], ['Exceptions', esc(s.exception_note || '—')]])}
      <div class="actions">${!s.doc_complete ? '<button class="btn primary" id="docdone">Mark documentation complete</button>' : ''}${s.approval_status !== 'approved' ? '<button class="btn ghost" id="fix">Correct my time</button>' : '<span class="hint">Approved — contact your supervisor for corrections.</span>'}</div></section>` : ''}
    <section class="card"><h2>Recorded this shift</h2>
      ${[...d.adl.map((x) => `ADL: ${esc(x.task)} — ${badge(x.status)}${x.notes ? ` <span class="sub">${esc(x.notes)}</span>` : ''}`),
    ...d.meals.map((x) => `Meal: ${esc(label(x.meal))}${x.percent_consumed != null ? ` ${x.percent_consumed}%` : ''}${x.fluid_ml != null ? ` · ${x.fluid_ml} mL` : ''}`),
    ...d.activities.map((x) => `Activity: ${esc(x.activity)}`),
    ...d.med_events.map((x) => `Medication: ${esc(x.medication_name)} — ${badge(['administered', 'assisted'].includes(x.action) ? 'completed' : x.action, label(x.action))}${x.scheduled_for ? ` (${fmtTime(x.scheduled_for)})` : ''}`),
    ...d.measurements.map((x) => `Measurement: ${esc(types.find((y) => y.code === x.type_code)?.name || x.type_code)} ${x.value}${x.value2 != null ? `/${x.value2}` : ''} ${esc(x.unit)}`),
    ...d.observations.map((x) => `Observation: ${esc([x.mood, x.alertness && label(x.alertness), x.observation].filter(Boolean).join(' · '))}`),
    ...d.incidents.map((x) => `Incident: ${esc(label(x.type))} ${badge(x.severity)}`)].map((x) => `<div class="hint">• ${x}</div>`).join('') || empty('Nothing recorded yet.')}
    </section>`;
  startTimer(el, s.now);
  const reload = () => shiftPage(el, id, ctx);
  const args = { clientId: s.client_id, shiftId: s.id };
  el.querySelector('#start')?.addEventListener('click', async () => { if (await startShift(id)) reload(); });
  el.querySelector('#incident').addEventListener('click', async () => {
    if (await incidentDialog({ clientId: s.client_id, shiftId: ['in_progress', 'completed'].includes(s.status) ? s.id : null, now: nowLocalInput() })) reload();
  });
  onClick(el, async (e) => {
    const k = e.target.dataset.doc;
    if (!k) return;
    let ok;
    if (k === 'adl') ok = await adlDialog({ ...args, tasks });
    if (k === 'meal') ok = await mealDialog(args);
    if (k === 'activity') ok = await activityDialog(args);
    if (k === 'obs') ok = await observationDialog(args);
    if (k === 'vitals') ok = await measurementDialog({ ...args, types });
    if (k === 'meds') ok = await medDialog(s, ctx);
    if (ok) reload();
  });
  el.querySelector('#end')?.addEventListener('click', async () => { if (await endShift(s)) location.hash = '#/my'; });
  el.querySelector('#docdone')?.addEventListener('click', async () => {
    try { await api.post(`/shifts/${id}/complete-docs`); toast('Documentation marked complete.', 'ok'); reload(); } catch (err) { showError(err); }
  });
  el.querySelector('#fix')?.addEventListener('click', async () => {
    if (await formModal({
      title: 'Correct my time', intro: '<p class="hint">Your supervisor will review the change.</p>',
      defs: [{ name: 'actual_start', label: 'Start', type: 'datetime', required: true }, { name: 'actual_end', label: 'End', type: 'datetime', required: true }, { name: 'break_min', label: 'Break (min)', type: 'number', min: 0 }, { name: 'mileage', label: 'Mileage', type: 'number', min: 0, step: '0.1' }, { name: 'reason', label: 'Reason', type: 'textarea', required: true, full: true }],
      values: s, submit: (v) => api.patch(`/shifts/${id}`, v),
    })) reload();
  });
}

function nowLocalInput() {
  const n = new Date();
  return new Date(n.getTime() - n.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

async function endShift(s) {
  const body = (outstanding) => `<form class="form">
    ${outstanding?.length ? `<div class="notice warn"><strong>Outstanding documentation</strong>${outstanding.map((o) => esc(o.text)).join('<br>')}<br>Go back and complete it, or explain below why it could not be done. Your supervisor will be notified.</div>` : ''}
    <div class="form-grid">${fields([
    { name: 'break_min', label: 'Unpaid break (minutes)', type: 'number', min: 0, value: 0 },
    { name: 'mileage', label: 'Mileage driven for client', type: 'number', min: 0, step: '0.1', value: 0 },
    { name: 'notes', label: 'Shift notes', type: 'textarea', full: true },
    ...(outstanding?.length ? [{ name: 'exception_note', label: 'Exception report — why documentation is incomplete', type: 'textarea', required: true, full: true }] : []),
  ])}</div><div class="actions"><button class="btn danger" type="submit">End shift</button><button class="btn ghost" type="button" data-close>Go back</button></div></form>`;
  const open = (outstanding) => modal({
    title: 'End shift', body: body(outstanding),
    onMount: (m, close) => onSubmit(m.querySelector('form'), async (v) => {
      try {
        const r = await api.post(`/shifts/${s.id}/end`, v);
        toast(`Shift ended — ${hours(r.worked_hours)} h recorded.`, 'ok');
        close(true);
      } catch (e) {
        if (e.details?.code === 'DOCS_OUTSTANDING' && !outstanding) { close('outstanding:' + JSON.stringify(e.details.outstanding)); return; }
        throw e;
      }
    }),
  });
  const r = await open(null);
  if (typeof r === 'string' && r.startsWith('outstanding:')) return open(JSON.parse(r.slice(12)));
  return r;
}

/** Medication documentation limited by the caregiver's authorized role. */
async function medDialog(s, ctx) {
  const [meds, me] = await Promise.all([api.get(`/clients/${s.client_id}/medications`), api.get(`/caregivers/${ctx.me.user.caregiver_id}`)]);
  const auth = me.med_authority;
  const actions = { none: ['refused', 'discrepancy'], assist: ['assisted', 'refused', 'omitted', 'held', 'discrepancy'], administer: ['administered', 'assisted', 'refused', 'omitted', 'held', 'discrepancy'] }[auth];
  const due = s.outstanding.filter((o) => o.kind === 'medication');
  const done = s.docs.med_events;
  const row = (m, when, i) => `<div class="adl-row"><div><strong>${esc(m.name)}</strong> ${esc(m.strength || '')} · ${esc(m.dose || '')} ${esc(m.route || '')}<div class="hint">${when ? `Scheduled ${fmtTime(when)}` : 'PRN / as needed'}${m.instructions ? ` · ${esc(m.instructions)}` : ''}</div></div>
    <select name="a_${i}" aria-label="Action for ${esc(m.name)}"><option value="">— not now —</option>${actions.map((a) => `<option value="${a}">${esc(label(a))}</option>`).join('')}</select>
    <input name="n_${i}" placeholder="Note (required if refused, omitted, held or discrepancy)" aria-label="Note">
    <input type="hidden" name="m_${i}" value="${m.id}"><input type="hidden" name="w_${i}" value="${esc(when || '')}"></div>`;
  const items = [
    ...due.map((o) => ({ m: meds.find((x) => x.id === o.medication_id), when: o.scheduled_for })).filter((x) => x.m),
    ...meds.filter((m) => m.prn).map((m) => ({ m, when: null })),
  ];
  return modal({
    title: 'Medications', wide: true,
    body: `<form class="form"><p class="hint">Your medication role: <strong>${esc(label(auth))}</strong>. Only record what you are trained and authorized to do. You cannot change medication orders — report any discrepancy.</p>
      ${items.length ? items.map((x, i) => row(x.m, x.when, i)).join('') : empty('No scheduled doses are due in this shift.')}
      ${field2()}
      ${done.length ? `<h3>Already recorded</h3>${done.map((e) => `<div class="hint">• ${esc(e.medication_name)} — ${esc(label(e.action))}${e.scheduled_for ? ` (${fmtTime(e.scheduled_for)})` : ''}</div>`).join('')}` : ''}
      <div class="actions"><button class="btn primary" type="submit">Save</button><button class="btn ghost" type="button" data-close>Cancel</button></div></form>`,
    onMount: (m, close) => onSubmit(m.querySelector('form'), async (v) => {
      const entries = items.map((x, i) => ({ medication_id: Number(v[`m_${i}`]), scheduled_for: v[`w_${i}`] || null, action: v[`a_${i}`], notes: v[`n_${i}`] })).filter((x) => x.action);
      if (v.disc_med && v.disc_note) entries.push({ medication_id: Number(v.disc_med), action: 'discrepancy', notes: v.disc_note, adverse_observation: v.adverse || null });
      if (!entries.length) throw new Error('Nothing to save.');
      for (const e of entries) await api.post('/med-events', { ...e, shift_id: s.id });
      toast('Medication records saved. Refusals and discrepancies notify your supervisor.', 'ok');
      close(true);
    }),
  });
  function field2() {
    return `<fieldset><legend>Report a medication discrepancy or observation</legend><div class="form-grid">${fields([
      { name: 'disc_med', label: 'Medication', type: 'select', options: meds.map((x) => [x.id, x.name]) },
      { name: 'disc_note', label: 'What happened', type: 'textarea', full: true, rows: 2 },
      { name: 'adverse', label: 'Observation after the dose (describe only)', type: 'textarea', full: true, rows: 2 },
    ])}</div></fieldset>`;
  }
}

// ================= client (caregiver view) =================
async function clientPage(el, id, ctx) {
  const [c, meds] = await Promise.all([api.get(`/clients/${id}`), api.get(`/clients/${id}/medications`)]);
  const p = c.care_plan;
  el.innerHTML = `<div class="page-head"><div><a class="hint" href="#/my">← My dashboard</a><h1>${esc(c.legal_name)}</h1><p>${esc(c.code)} ${c.room ? `· Room ${esc(c.room)}` : ''} ${badge(c.status)}</p></div></div>
    ${p && !p.acknowledged ? `<div class="notice warn"><strong>New care plan</strong>Please read and acknowledge it. <button class="btn primary small" id="ack">Acknowledge</button></div>` : ''}
    <div class="grid two">
      <section class="card"><h2>Care plan</h2>${planView(c)}</section>
      <section class="card"><h2>Emergency contacts</h2>${table([{ label: 'Name', key: 'name' }, { label: 'Relationship', key: 'relationship' }, { label: 'Phone', key: 'phone' }], c.contacts, { empty: 'Contact the office.' })}
        <h2>Current medications</h2>${table([{ label: 'Medication', render: (m) => `<strong>${esc(m.name)}</strong> ${esc(m.strength || '')}${m.prn ? ' ' + badge('info', 'PRN') : ''}` }, { label: 'Dose', render: (m) => `${esc(m.dose || '')} ${esc(m.route || '')}` }, { label: 'When', render: (m) => esc(m.times || m.frequency || '') }, { label: 'Instructions', cls: 'wrap', render: (m) => esc([m.instructions, m.precautions].filter(Boolean).join(' · ')) }], meds, { empty: 'No active medications.' })}
        <p class="hint">Medication orders can only be changed by authorized staff.</p></section>
    </div>`;
  el.querySelector('#ack')?.addEventListener('click', async () => { try { await api.post(`/care-plans/${p.id}/ack`); toast('Acknowledged.', 'ok'); clientPage(el, id, ctx); } catch (err) { showError(err); } });
}

// ================= timesheet =================
async function timesheetPage(el, query, ctx) {
  const from = query.from || weekStart(ctx.today());
  const to = addDays(from, 6);
  const t = await api.get('/me/timesheet', { from, to });
  el.innerHTML = `<div class="page-head"><div><h1>My timesheet</h1><p>${fmtDate(from)} – ${fmtDate(to)}</p></div>
    <div class="page-actions"><a class="btn ghost" href="#/my/timesheet?from=${addDays(from, -7)}">◀ Previous</a><a class="btn ghost" href="#/my/timesheet">This week</a><a class="btn ghost" href="#/my/timesheet?from=${addDays(from, 7)}">Next ▶</a><button class="btn ghost" id="print">Print</button></div></div>
    <div class="stats">${stat('Hours', hours(t.totals.hours))}${stat('Approved hours', hours(t.totals.approved_hours), { tone: 'info' })}${stat('Regular / overtime', `${hours(t.totals.regular_hours)} / ${hours(t.totals.overtime_hours)}`)}${stat('Mileage', t.totals.miles)}${t.totals.current_rate_cents != null ? stat('Current rate', `${money(t.totals.current_rate_cents)}/h`) : ''}</div>
    <section class="card">${table([
    { label: 'Date', render: (s) => `<a href="#/my/shift/${s.id}">${fmtDate(s.date, { weekday: 'short' })}</a>` },
    { label: 'Client', key: 'client_name' },
    { label: 'Time', render: (s) => (s.actual_start ? `${fmtTime(s.actual_start)}–${s.actual_end ? fmtTime(s.actual_end) : '…'}` : '—') },
    { label: 'Break', num: true, render: (s) => `${s.break_min}m` },
    { label: 'Hours', num: true, render: (s) => hours(s.hours), total: (r) => r.reduce((x, s) => x + s.hours, 0), fmt: hours },
    { label: 'Miles', num: true, key: 'mileage' },
    { label: 'Status', render: (s) => `${badge(s.status)} ${s.status === 'completed' ? badge(s.approval_status) : ''} ${s.status === 'completed' && !s.doc_complete ? badge('incomplete', 'docs') : ''}` },
  ], t.shifts, { empty: 'No shifts worked this week.' })}<p class="hint">${esc(t.note)}</p></section>`;
  el.querySelector('#print').addEventListener('click', () => window.print());
}

// ================= incident =================
async function incidentPage(el, ctx) {
  const d = await api.get('/me/dashboard');
  const mine = await api.get('/incidents');
  el.innerHTML = `<div class="page-head"><div><h1>Report an incident</h1><p>Falls, injuries, medication discrepancies, missed tasks, sudden changes and other events.</p></div></div>
    <div class="notice danger"><strong>Emergency?</strong>If anyone is in immediate danger, call 911 first and follow emergency procedures.</div>
    <section class="card"><button class="btn primary big" id="new">Start incident report</button></section>
    <section class="card"><h2>My reports</h2>${table([{ label: 'When', render: (i) => fmtDT(i.occurred_at) }, { label: 'Client', render: (i) => esc(i.client_name || '—') }, { label: 'Type', render: (i) => `${esc(label(i.type))} ${badge(i.severity)}` }, { label: 'Status', render: (i) => badge(i.status) }], mine, { empty: 'You have not filed any reports.' })}</section>`;
  el.querySelector('#new').addEventListener('click', async () => {
    const shiftId = d.active_shift?.id ?? null;
    if (await incidentDialog({ clients: d.clients, clientId: null, shiftId, now: nowLocalInput() })) incidentPage(el, ctx);
  });
}

// ================= profile =================
async function profilePage(el, ctx) {
  const c = await api.get(`/caregivers/${ctx.me.user.caregiver_id}`);
  el.innerHTML = `<div class="page-head"><div><h1>My profile</h1><p>${esc(c.code)}</p></div></div>
    <div class="grid two">
      <section class="card"><h2>${esc(c.full_name)}</h2>${kv([['Phone', esc(c.phone)], ['Email', esc(c.email)], ['Emergency contact', esc([c.emergency_name, c.emergency_phone].filter(Boolean).join(' · '))], ['Employment', badge(c.employment_status)], ['Medication role', esc(label(c.med_authority))], ['Current pay rate', c.pay_rate_cents != null ? `${money(c.pay_rate_cents)}/h` : '—'], ['Responsibilities', esc(c.responsibilities)], ['Restrictions', esc(c.restrictions)]])}
        <p class="hint">To update your details, contact the office.</p></section>
      <section class="card"><h2>Credentials</h2>${table([{ label: 'Credential', key: 'name' }, { label: 'Expires', render: (r) => (r.expires_on ? `${fmtDate(r.expires_on)} ${r.expires_on < ctx.today() ? badge('expired') : ''}` : '—') }, { label: 'Verified', render: (r) => (r.verified ? badge('verified') : badge('pending')) }], c.credentials, { empty: 'None on file.' })}
        <h2>My assignments</h2>${table([{ label: 'Client', key: 'client_name' }, { label: 'Time', render: (a) => `${esc(a.shift_start)}–${esc(a.shift_end)}` }, { label: 'Status', render: (a) => badge(a.status) }], c.assignments.filter((a) => a.status === 'active'), { empty: 'No active assignments.' })}</section>
    </div>`;
}
