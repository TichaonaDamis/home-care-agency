import { api } from '../api.js';
import {
  esc, table, wireRowLinks, badge, sampleBadge, formModal, fields, readForm, tabs, kv, fmtDate, fmtISO, fmtDT, money, label, toast, showError,
  empty, confirmDialog, lineChart, num, opts, addDays, modal, onSubmit,
} from '../ui.js';
import { clientDefs, CLIENT_STATUSES, medDefs, measurementDialog, transitionDialog, TRANSITION_TYPES } from './shared.js';

export async function render(el, parts, query, ctx) {
  if (parts[0]) return renderDetail(el, Number(parts[0]), query, ctx);
  return renderList(el, query, ctx);
}

// ================= list =================
async function renderList(el, query, ctx) {
  const lk = await ctx.lookups();
  const rows = await api.get('/clients', { q: query.q, status: query.status, facility_id: query.facility_id, category_id: query.category_id, hospice_status: query.hospice_status });
  el.innerHTML = `
    <div class="page-head"><div><h1>Clients</h1><p>${rows.length} client${rows.length === 1 ? '' : 's'}</p></div>
      <div class="page-actions">${ctx.can('clients.manage') ? '<button class="btn primary" id="add">+ Register client</button>' : ''}</div></div>
    <section class="card">
      <form class="filters" id="filters">${fields([
    { name: 'q', label: 'Search name or ID', value: query.q },
    { name: 'status', label: 'Status', type: 'select', options: CLIENT_STATUSES.map((s) => [s, label(s)]), value: query.status },
    { name: 'hospice_status', label: 'Hospice', type: 'select', options: ['none', 'referred', 'evaluating', 'enrolled', 'discharged'].map((s) => [s, label(s)]), value: query.hospice_status },
    { name: 'facility_id', label: 'Facility', type: 'select', options: opts(lk.facilities), value: query.facility_id },
    { name: 'category_id', label: 'Category', type: 'select', options: opts(lk.categories), value: query.category_id },
  ])}</form>
      ${table([
    { label: 'Client', render: (c) => `<strong>${esc(c.legal_name)}</strong>${c.preferred_name ? ` <span class="sub">“${esc(c.preferred_name)}”</span>` : ''}${sampleBadge(c)}<div class="sub">${esc(c.code)}</div>` },
    { label: 'Location', render: (c) => `${esc(c.facility_name || '—')}${c.room ? ` · Rm ${esc(c.room)}` : ''}` },
    { label: 'Categories', render: (c) => `<span class="sub">${esc(c.categories || '—')}</span>` },
    { label: 'Status', render: (c) => `${badge(c.status)} ${c.hospice_status !== 'none' ? badge(c.hospice_status, `Hospice: ${label(c.hospice_status)}`) : ''}` },
    { label: 'Open alerts', num: true, render: (c) => (c.open_alerts ? badge('high', String(c.open_alerts)) : '0') },
    { label: 'Admitted', render: (c) => fmtDate(c.admission_date) },
  ], rows, { rowLink: (c) => `#/clients/${c.id}`, empty: 'No clients match these filters.' })}
    </section>`;
  wireRowLinks(el);
  el.querySelector('#filters').addEventListener('change', (e) => {
    location.hash = `#/clients${api.qs(readForm(e.currentTarget))}`;
  });
  el.querySelector('#add')?.addEventListener('click', async () => {
    const r = await formModal({ title: 'Register client', wide: true, defs: clientDefs(lk), submitLabel: 'Register', submit: (v) => api.post('/clients', v) });
    if (r) { toast(`Client ${r.code} registered.`, 'ok'); location.hash = `#/clients/${r.id}`; }
  });
}

// ================= detail =================
const TABS = [['overview', 'Overview'], ['careplan', 'Care plan'], ['services', 'Services & rates'], ['meds', 'Medications'], ['health', 'Health'], ['progress', 'Progress'], ['transitions', 'Care transitions'], ['logs', 'Care logs']];

async function renderDetail(el, id, query, ctx) {
  const tab = query.tab || 'overview';
  const c = await api.get(`/clients/${id}`);
  const visible = TABS.filter(([k]) => ({
    meds: ctx.can('meds.view'), health: ctx.can('health.view'), progress: ctx.can('progress.review', 'reports.clinical'),
    logs: ctx.can('care.view'), transitions: ctx.can('transitions.manage', 'clients.view'),
  }[k] ?? true));
  el.innerHTML = `
    <div class="page-head"><div><a href="#/clients" class="hint">← Clients</a>
      <h1>${esc(c.legal_name)}${c.preferred_name ? ` <span class="hint">“${esc(c.preferred_name)}”</span>` : ''}${sampleBadge(c)}</h1>
      <p>${esc(c.code)} · ${badge(c.status)} ${c.hospice_status !== 'none' ? badge(c.hospice_status, `Hospice: ${label(c.hospice_status)}`) : ''} ${c.facility_name ? `· ${esc(c.facility_name)}` : ''}${c.room ? ` Rm ${esc(c.room)}` : ''}</p></div>
      <div class="page-actions"><button class="btn ghost" id="print">Print</button></div></div>
    ${c.status === 'hospitalized' || c.status === 'temporarily_away' ? `<div class="notice warn"><strong>Client is ${esc(label(c.status))}.</strong>Review scheduled shifts and do not bill services that were not delivered.</div>` : ''}
    ${c.allergies || c.alerts ? `<div class="notice danger">${c.allergies ? `<strong>Allergies: ${esc(c.allergies)}</strong>` : ''}${c.alerts ? esc(c.alerts) : ''}</div>` : ''}
    ${tabs(visible, tab)}
    <div id="tab"></div>`;
  el.querySelector('#print').addEventListener('click', () => window.print());
  el.querySelector('.tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) location.hash = `#/clients/${id}?tab=${t.dataset.tab}`;
  });
  const box = el.querySelector('#tab');
  const reload = () => renderDetail(el, id, query, ctx);
  const fn = { overview, careplan, services, meds, health, progress, transitions, logs }[tab] || overview;
  await fn(box, c, ctx, reload, query);
}

// ----- overview -----
async function overview(box, c, ctx, reload) {
  const lk = await ctx.lookups();
  const cats = lk.categories.filter((x) => c.category_ids.includes(x.id)).map((x) => x.name);
  const canEdit = ctx.can('clients.manage');
  box.innerHTML = `<div class="grid two">
    <section class="card"><div class="card-head"><h2>Profile</h2>${canEdit ? '<button class="btn ghost small" id="edit">Edit</button>' : ''}</div>
      ${kv([
    ['Client ID', esc(c.code)], ['Legal name', esc(c.legal_name)], ['Preferred name', esc(c.preferred_name)], ['Date of birth', fmtDate(c.dob)],
    ['Address', esc(c.address)], ['Phone', esc(c.phone)], ['Email', esc(c.email)], ['Facility / room', `${esc(c.facility_name || '—')} ${c.room ? `· ${esc(c.room)}` : ''}`],
    ['Admission', fmtDate(c.admission_date)], ['Discharge', fmtDate(c.discharge_date)], ['Categories', cats.length ? cats.map(esc).join(', ') : '—'],
    ['Primary care provider', `${esc(c.pcp_name || '—')} ${c.pcp_phone ? `· ${esc(c.pcp_phone)}` : ''}`], ['Diet', esc(c.diet)],
    ['Daily fluid goal', c.min_fluid_ml ? `${c.min_fluid_ml} mL` : '—'], ['Consent', esc(c.consent_notes)], ['Contact preferences', esc(c.contact_preferences)],
  ])}</section>
    <section class="card"><div class="card-head"><h2>Contacts & representatives</h2>${canEdit ? '<button class="btn ghost small" id="addc">+ Contact</button>' : ''}</div>
      ${table([
    { label: 'Name', render: (x) => `<strong>${esc(x.name)}</strong>${x.is_decision_maker ? ' ' + badge('info', 'Decision-maker') : ''}<div class="sub">${esc(x.relationship || '')}</div>` },
    { label: 'Type', render: (x) => esc(label(x.kind)) },
    { label: 'Phone', render: (x) => esc(x.phone || '—') },
    ...(canEdit ? [{ label: '', render: (x) => `<button class="btn link" data-edit-contact="${x.id}">Edit</button><button class="btn link danger-text" data-del-contact="${x.id}">Remove</button>` }] : []),
  ], c.contacts, { empty: 'No contacts recorded. Add at least one emergency contact.' })}
    </section>
    <section class="card"><div class="card-head"><h2>Assigned caregivers</h2><a class="btn ghost small" href="#/schedule?tab=assignments&client_id=${c.id}">Manage</a></div>
      ${table([
    { label: 'Caregiver', render: (a) => esc(a.caregiver_name) },
    { label: 'Schedule', render: (a) => `${esc(dayNames(a.days_of_week))} ${esc(a.shift_start)}–${esc(a.shift_end)}` },
    { label: 'Dates', render: (a) => `${fmtDate(a.start_date)} → ${a.end_date ? fmtDate(a.end_date) : 'ongoing'}` },
    { label: 'Status', render: (a) => badge(a.status) },
  ], c.assignments, { empty: 'No caregivers assigned.' })}
    </section></div>`;
  const contactDefs = [
    { name: 'kind', label: 'Type', type: 'select', required: true, options: ['emergency', 'representative', 'care_team', 'family', 'other'].map((k) => [k, label(k)]) },
    { name: 'name', label: 'Name', required: true }, { name: 'relationship', label: 'Relationship / role' },
    { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'email', label: 'Email', type: 'email' },
    { name: 'is_decision_maker', label: 'Authorized decision-maker', type: 'checkbox' }, { name: 'notes', label: 'Notes', type: 'textarea', full: true },
  ];
  box.querySelector('#edit')?.addEventListener('click', async () => {
    const defs = clientDefs(lk).map((d) => (d.name === 'code' ? { ...d, type: 'readonly' } : d));
    if (await formModal({ title: 'Edit client', wide: true, defs, values: { ...c, category_ids: c.category_ids.map(String) }, submit: (v) => { delete v.code; return api.patch(`/clients/${c.id}`, v); } })) { toast('Saved.', 'ok'); reload(); }
  });
  box.querySelector('#addc')?.addEventListener('click', async () => {
    if (await formModal({ title: 'Add contact', defs: contactDefs, submit: (v) => api.post(`/clients/${c.id}/contacts`, v) })) reload();
  });
  box.addEventListener('click', async (e) => {
    const ed = e.target.dataset.editContact;
    const del = e.target.dataset.delContact;
    if (ed) {
      const x = c.contacts.find((k) => k.id === Number(ed));
      if (await formModal({ title: 'Edit contact', defs: contactDefs, values: x, submit: (v) => api.patch(`/client-contacts/${ed}`, v) })) reload();
    }
    if (del && await confirmDialog('Remove this contact?', { danger: true, okLabel: 'Remove' })) {
      try { await api.del(`/client-contacts/${del}`); reload(); } catch (err) { showError(err); }
    }
  });
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const dayNames = (s) => String(s).split(',').map((d) => DAYS[Number(d)]).join(' ');

// ----- care plan -----
async function careplan(box, c, ctx, reload) {
  const versions = await api.get(`/clients/${c.id}/care-plans`);
  const cur = versions.find((v) => v.status === 'active');
  const canEdit = ctx.can('careplan.manage');
  const show = (p) => kv([
    ['Version', `${p.version} ${badge(p.status)}`], ['Effective', fmtDate(p.effective_date)], ['Review due', p.review_due ? `${fmtDate(p.review_due)} ${p.review_due < ctx.today() ? badge('high', 'Overdue') : ''}` : '—'],
    ['Summary', esc(p.summary)], ['Goals', esc(p.goals)], ['Instructions', esc(p.instructions)],
    ['Required ADL tasks', p.adl_tasks ? `<ul>${p.adl_tasks.split('\n').filter(Boolean).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '—'],
    ['Mobility', esc(p.mobility)], ['Diet', esc(p.diet)], ['Behavior support', esc(p.behavior_support)],
    ['Acknowledgement', p.requires_ack ? `Required · ${p.ack_count ?? 0} caregiver(s) acknowledged` : 'Not required'], ['Author', esc(p.author || '—')],
  ]);
  box.innerHTML = `<div class="grid two">
    <section class="card"><div class="card-head"><h2>Current care plan</h2>${canEdit ? `<button class="btn primary small" id="newv">${cur ? 'New version' : 'Create care plan'}</button>` : ''}</div>
      ${cur ? show(cur) : empty('No care plan yet. Caregivers will see the plan and must acknowledge it before their next shift.')}</section>
    <section class="card"><h2>Version history</h2>
      ${table([
    { label: 'Version', render: (p) => `v${p.version}` }, { label: 'Effective', render: (p) => fmtDate(p.effective_date) },
    { label: 'Status', render: (p) => badge(p.status) }, { label: 'Author', render: (p) => esc(p.author || '—') },
    { label: '', render: (p) => `<button class="btn link" data-view="${p.id}">View</button>` },
  ], versions, { empty: 'No versions.' })}
      <p class="hint">Earlier versions are kept for reference and cannot be edited.</p></section></div>`;
  box.addEventListener('click', (e) => {
    const vid = e.target.dataset.view;
    if (vid) modal({ title: `Care plan v${versions.find((p) => p.id === Number(vid)).version}`, wide: true, body: show(versions.find((p) => p.id === Number(vid))) });
  });
  box.querySelector('#newv')?.addEventListener('click', async () => {
    const defs = [
      { name: 'effective_date', label: 'Effective date', type: 'date', required: true, value: ctx.today() },
      { name: 'review_due', label: 'Next review due', type: 'date', value: addDays(ctx.today(), 90) },
      { name: 'summary', label: 'Summary of needs', type: 'textarea', full: true },
      { name: 'goals', label: 'Goals', type: 'textarea', full: true },
      { name: 'instructions', label: 'Care instructions (authorized)', type: 'textarea', full: true, rows: 4 },
      { name: 'adl_tasks', label: 'ADL tasks to document each shift (one per line)', type: 'textarea', full: true, rows: 4, hint: 'Caregivers must record each of these before completing a shift (or file an exception).' },
      { name: 'mobility', label: 'Mobility & transfers', type: 'textarea' },
      { name: 'diet', label: 'Diet & hydration', type: 'textarea' },
      { name: 'behavior_support', label: 'Behavior support', type: 'textarea', full: true },
      { name: 'requires_ack', label: 'Caregivers must acknowledge this version before their next shift', type: 'checkbox', full: true, value: true },
    ];
    if (await formModal({ title: cur ? `New care plan version (v${cur.version + 1})` : 'Create care plan', wide: true, defs, values: cur ? { ...cur, effective_date: ctx.today(), requires_ack: true } : {}, submit: (v) => api.post(`/clients/${c.id}/care-plans`, v) })) {
      toast('Care plan saved.', 'ok');
      reload();
    }
  });
}

// ----- services & billing rates -----
async function services(box, c, ctx, reload) {
  const lk = await ctx.lookups();
  const canEdit = ctx.can('clients.manage');
  const fin = ctx.can('finance.view');
  box.innerHTML = `<section class="card"><div class="card-head"><h2>Services received</h2>${canEdit ? '<button class="btn primary small" id="adds">+ Service / new rate</button>' : ''}</div>
    <p class="hint">Rates are versioned by effective date. Adding a new rate closes the previous one; past shifts keep the rate in effect when they were worked.</p>
    ${table([
    { label: 'Service', render: (s) => `<strong>${esc(s.service_name)}</strong><div class="sub">${esc(s.frequency || '')}</div>` },
    { label: 'Effective', render: (s) => `${fmtDate(s.effective_from)} → ${s.effective_to ? fmtDate(s.effective_to) : 'ongoing'}` },
    ...(fin ? [{ label: 'Billing', render: (s) => (s.bill_method === 'not_billed' ? 'Not billed' : `${money(s.bill_rate_cents)} / ${esc(label(s.bill_method).replace('Per ', ''))}`) }] : []),
    { label: 'Instructions', cls: 'wrap', render: (s) => esc(s.instructions || '') },
    { label: 'Responsible', render: (s) => esc(s.responsible || '') },
    { label: 'Status', render: (s) => (!s.effective_to || s.effective_to >= ctx.today() ? badge('active') : badge('ended')) },
    ...(canEdit ? [{ label: '', render: (s) => (!s.effective_to ? `<button class="btn link" data-end="${s.id}">End</button>` : '') }] : []),
  ], c.services, { empty: 'No services recorded.' })}</section>`;
  box.querySelector('#adds')?.addEventListener('click', async () => {
    if (await formModal({
      title: 'Add service or new rate',
      defs: [
        { name: 'service_type_id', label: 'Service', type: 'select', required: true, options: opts(lk.service_types.filter((s) => s.active)) },
        { name: 'effective_from', label: 'Effective from', type: 'date', required: true, value: ctx.today() },
        { name: 'bill_method', label: 'Billing method', type: 'select', required: true, value: 'hourly', options: [['hourly', 'Hourly'], ['per_visit', 'Per visit'], ['daily', 'Daily (day rate)'], ['monthly', 'Monthly'], ['not_billed', 'Not billed']] },
        { name: 'bill_rate', label: 'Rate ($)', type: 'money', required: true, value: '0' },
        { name: 'frequency', label: 'Authorized frequency' }, { name: 'responsible', label: 'Responsible staff' },
        { name: 'instructions', label: 'Care instructions', type: 'textarea', full: true },
      ],
      submit: (v) => api.post(`/clients/${c.id}/services`, v),
    })) { toast('Service saved.', 'ok'); reload(); }
  });
  box.addEventListener('click', async (e) => {
    const sid = e.target.dataset.end;
    if (!sid) return;
    if (await formModal({ title: 'End service', defs: [{ name: 'effective_to', label: 'Last day of service', type: 'date', required: true, value: ctx.today() }], submit: (v) => api.patch(`/client-services/${sid}`, v) })) reload();
  });
}

// ----- medications -----
async function meds(box, c, ctx, reload) {
  const [list, changes] = await Promise.all([api.get(`/clients/${c.id}/medications`), api.get('/medication-changes', { client_id: c.id })]);
  const canEdit = ctx.can('meds.manage');
  box.innerHTML = `<section class="card"><div class="card-head"><h2>Medication list</h2><div class="actions">
      ${ctx.can('meds.verify') ? '<button class="btn ghost small" id="recon">Mark list reconciled</button>' : ''}
      ${canEdit ? '<button class="btn primary small" id="addm">+ Medication</button>' : ''}</div></div>
    <p class="hint">Last reconciled: ${c.meds_reconciled_on ? `${fmtDate(c.meds_reconciled_on)} by ${esc(c.reconciled_by_name || '—')}` : 'never'}. Order changes are recorded in the history below; caregivers cannot change orders.</p>
    ${table([
    { label: 'Medication', render: (m) => `<strong>${esc(m.name)}</strong> ${esc(m.strength || '')} ${esc(m.form || '')}${m.prn ? ' ' + badge('info', 'PRN') : ''}<div class="sub">${esc(m.instructions || '')}</div>` },
    { label: 'Dose / route', render: (m) => `${esc(m.dose || '')} ${esc(m.route || '')}` },
    { label: 'Frequency', render: (m) => `${esc(m.frequency || '')}<div class="sub">${esc(m.times || '')}</div>` },
    { label: 'Prescriber', render: (m) => esc(m.prescriber || '—') },
    { label: 'Dates', render: (m) => `${fmtDate(m.start_date)}${m.stop_date ? ` → ${fmtDate(m.stop_date)}` : ''}` },
    { label: 'Status', render: (m) => badge(m.status) },
    ...(canEdit ? [{ label: '', render: (m) => `<button class="btn link" data-editm="${m.id}">Change order</button>` }] : []),
  ], list, { empty: 'No medications recorded.' })}</section>
  <section class="card"><h2>Medication change history</h2>${changeTable(changes, ctx)}</section>`;
  box.querySelector('#addm')?.addEventListener('click', async () => {
    if (await formModal({ title: 'Add medication', wide: true, defs: [...medDefs(), { name: 'verified', label: 'Order verified against source', type: 'checkbox' }, { name: 'follow_up', label: 'Follow-up required', type: 'textarea', full: true }], values: { start_date: ctx.today() }, submit: (v) => api.post(`/clients/${c.id}/medications`, v) })) reload();
  });
  box.querySelector('#recon')?.addEventListener('click', async () => {
    if (await confirmDialog('Confirm the medication list has been reconciled against current orders today.')) { await api.post(`/clients/${c.id}/reconcile-medications`, { date: ctx.today() }); reload(); }
  });
  box.addEventListener('click', async (e) => {
    const mid = e.target.dataset.editm;
    if (mid) {
      const m = list.find((x) => x.id === Number(mid));
      const defs = [...medDefs(), { name: 'status', label: 'Status', type: 'select', required: true, options: [['active', 'Active'], ['on_hold', 'On hold'], ['discontinued', 'Discontinued']] },
        { name: 'effective_date', label: 'Change effective date', type: 'date', required: true }, { name: 'details', label: 'Reason / details of change', type: 'textarea', full: true },
        { name: 'verified', label: 'Updated order verified', type: 'checkbox' }, { name: 'follow_up', label: 'Follow-up required', type: 'textarea', full: true }];
      if (await formModal({ title: `Change order: ${m.name}`, wide: true, defs, values: { ...m, effective_date: ctx.today() }, submit: (v) => api.patch(`/medications/${mid}`, v) })) { toast('Change recorded in history.', 'ok'); reload(); }
    }
    await changeActions(e, reload);
  });
}

export function changeTable(changes, ctx) {
  return table([
    { label: 'Effective', render: (x) => fmtDate(x.effective_date) },
    { label: 'Medication', render: (x) => `<strong>${esc(x.medication_name)}</strong>${x.client_name ? `<div class="sub">${esc(x.client_name)}</div>` : ''}` },
    { label: 'Change', render: (x) => `${badge('info', label(x.change_type))}<div class="sub">${esc(x.previous_value || '')}${x.previous_value ? ' → ' : ''}${esc(x.new_value || '')}</div>` },
    { label: 'Documented by', render: (x) => esc(x.documented_by_name) },
    { label: 'Verified', render: (x) => (x.verified ? `${badge('verified')}<div class="sub">${esc(x.verified_by_name || '')}</div>` : badge('high', 'Not verified')) },
    { label: 'Follow-up', cls: 'wrap', render: (x) => `${esc(x.follow_up || '')} ${badge(x.review_status)}` },
    { label: '', render: (x) => `<a class="btn link" href="#/medications/change/${x.id}">Before/after</a>${!x.verified && ctx.can('meds.verify') ? `<button class="btn link" data-verify="${x.id}">Verify</button>` : ''}${ctx.can('meds.verify') && x.review_status !== 'closed' ? `<button class="btn link" data-review="${x.id}">Review</button>` : ''}` },
  ], changes, { empty: 'No medication changes recorded.' });
}
export async function changeActions(e, reload) {
  const v = e.target.dataset.verify;
  const r = e.target.dataset.review;
  try {
    if (v && await confirmDialog('Confirm this change has been verified against the order source.', { okLabel: 'Verify' })) { await api.post(`/medication-changes/${v}/verify`); reload(); }
    if (r && await formModal({ title: 'Update review', defs: [{ name: 'review_status', label: 'Review status', type: 'select', required: true, options: [['pending', 'Pending'], ['in_review', 'In review'], ['closed', 'Closed']] }, { name: 'follow_up', label: 'Follow-up / outcome', type: 'textarea', full: true }], submit: (x) => api.patch(`/medication-changes/${r}`, x) })) reload();
  } catch (err) { showError(err); }
}

// ----- health -----
async function health(box, c, ctx, reload) {
  const from = addDays(ctx.today(), -89);
  const [summary, list, types, thresholds] = await Promise.all([
    api.get(`/clients/${c.id}/health-summary`), api.get('/measurements', { client_id: c.id, from }), api.get('/measurement-types'), api.get(`/clients/${c.id}/thresholds`),
  ]);
  const recorded = summary.filter((s) => s.latest || s.overdue);
  box.innerHTML = `
    <div class="page-actions">${ctx.can('health.record') ? '<button class="btn primary" id="rec">+ Record measurements</button>' : ''}${ctx.can('thresholds.manage') ? '<button class="btn ghost" id="thr">Alert thresholds</button>' : ''}</div>
    <section class="card"><h2>Latest values</h2>
      ${recorded.length ? table([
    { label: 'Measurement', render: (s) => `<strong>${esc(s.name)}</strong>` },
    { label: 'Latest', render: (s) => (s.latest ? `${val(s.latest)} ${esc(s.unit)} ${s.out_of_range?.length ? badge('high', 'Outside threshold') : ''}<div class="sub">${fmtDT(s.latest.measured_at)}</div>` : '—') },
    { label: 'Previous', render: (s) => (s.previous ? `${val(s.previous)}<div class="sub">${fmtDT(s.previous.measured_at)}</div>` : '—') },
    { label: 'Change', render: (s) => (s.change != null ? `${s.change > 0 ? '+' : ''}${num(s.change, 1)}${s.change2 != null ? ` / ${s.change2 > 0 ? '+' : ''}${num(s.change2, 1)}` : ''}${s.change_pct != null ? ` <span class="sub">(${s.change_pct > 0 ? '+' : ''}${num(s.change_pct, 1)}%)</span>` : ''}` : '—') },
    { label: 'Thresholds', render: (s) => `<span class="sub">${thr(s.thresholds)}${s.thresholds.individualized ? ' (client-specific)' : ' (facility default)'}</span>` },
    { label: 'Schedule', render: (s) => (s.expected_every_days ? `${s.overdue ? badge('high', 'Overdue') : badge('ok', 'On schedule')}<div class="sub">every ${s.expected_every_days} d${s.days_since != null ? ` · last ${s.days_since} d ago` : ' · never recorded'}</div>` : '') },
  ], recorded) : empty('No measurements recorded yet.')}
      <p class="disclaimer">A single measurement does not establish health status. Thresholds should be set by an authorized clinician or facility policy.</p></section>
    <div class="grid two" id="charts"></div>
    <section class="card"><h2>All measurements (90 days)</h2>${table([
    { label: 'When', render: (m) => fmtDT(m.measured_at) }, { label: 'Type', render: (m) => esc(m.type_name) },
    { label: 'Value', render: (m) => `${val(m)} ${esc(m.unit)}` }, { label: 'Method', render: (m) => esc(m.method || '') },
    { label: 'Notes', cls: 'wrap', render: (m) => esc([m.symptoms, m.follow_up].filter(Boolean).join(' · ')) },
    { label: 'Recorded by', render: (m) => `${esc(m.recorded_by_name)}${m.clinician_notified ? `<div class="sub">clinician notified</div>` : ''}` },
    { label: '', render: (m) => `<button class="btn link danger-text" data-err="${m.id}">Entered in error</button>` },
  ], list, { empty: 'No measurements in the last 90 days.' })}</section>`;
  const byType = {};
  for (const m of list) (byType[m.type_code] ||= []).push(m);
  box.querySelector('#charts').innerHTML = Object.entries(byType).map(([code, ms]) => {
    const s = summary.find((x) => x.code === code);
    const series = [{ name: s.has_second_value ? 'Systolic' : s.name, points: ms.map((m) => ({ x: m.measured_at, y: m.value })) }];
    if (s.has_second_value) series.push({ name: 'Diastolic', points: ms.map((m) => ({ x: m.measured_at, y: m.value2 })) });
    const t = s.thresholds;
    const lines = [t.high != null && { value: t.high, label: `high ${t.high}` }, t.low != null && { value: t.low, label: `low ${t.low}` }].filter(Boolean);
    return `<section class="card"><h3>${esc(s.name)} (${esc(s.unit)})</h3>${lineChart(series, { thresholds: lines, fmt: (v) => num(v, 0) })}</section>`;
  }).join('') || '';
  box.querySelector('#rec')?.addEventListener('click', async () => { if (await measurementDialog({ clientId: c.id, types })) reload(); });
  box.querySelector('#thr')?.addEventListener('click', () => thresholdDialog(c, thresholds, reload));
  box.addEventListener('click', async (e) => {
    const id = e.target.dataset.err;
    if (!id) return;
    const reason = await confirmDialog('Mark this measurement as entered in error? It will be excluded from trends but kept in the audit trail.', { reason: true, danger: true, okLabel: 'Mark in error' });
    if (reason) { await api.post(`/measurements/${id}/entered-in-error`, { reason }); reload(); }
  });
}
const val = (m) => (m.value2 != null ? `${num(m.value, 0)}/${num(m.value2, 0)}` : num(m.value, m.value % 1 ? 1 : 0));
const thr = (t) => [t.low != null && `≥ ${t.low}`, t.high != null && `≤ ${t.high}`, t.low2 != null && `2nd ≥ ${t.low2}`, t.high2 != null && `2nd ≤ ${t.high2}`].filter(Boolean).join(', ') || 'none';

function thresholdDialog(c, rows, reload) {
  modal({
    title: 'Individualized alert thresholds',
    wide: true,
    body: `<p class="hint">Set by an authorized clinician or facility policy. Blank values fall back to facility defaults (shown as placeholders).</p>
      ${rows.map((t) => `<form class="form card" data-code="${esc(t.code)}"><h3>${esc(t.name)} (${esc(t.unit)})</h3><div class="form-grid">
        ${fields([
    { name: 'low', label: t.has_second_value ? 'Systolic low' : 'Low', type: 'number', step: 'any', value: t.low, placeholder: t.default_low ?? '' },
    { name: 'high', label: t.has_second_value ? 'Systolic high' : 'High', type: 'number', step: 'any', value: t.high, placeholder: t.default_high ?? '' },
    ...(t.has_second_value ? [{ name: 'low2', label: 'Diastolic low', type: 'number', step: 'any', value: t.low2, placeholder: t.default_low2 ?? '' }, { name: 'high2', label: 'Diastolic high', type: 'number', step: 'any', value: t.high2, placeholder: t.default_high2 ?? '' }] : []),
    { name: 'expected_every_days', label: 'Expected every (days)', type: 'number', min: 1, value: t.expected_every_days },
    { name: 'approved_by', label: 'Approved by (clinician / policy)', required: true, value: t.approved_by },
    { name: 'escalation', label: 'Escalation instructions', type: 'textarea', full: true, value: t.escalation },
  ])}</div><div class="actions"><button class="btn primary small" type="submit">Save ${esc(t.name)}</button></div></form>`).join('')}`,
    onMount: (el) => el.querySelectorAll('form[data-code]').forEach((f) => onSubmit(f, async (v) => {
      await api.put(`/clients/${c.id}/thresholds/${f.dataset.code}`, v);
      toast('Threshold saved.', 'ok');
      reload();
    })),
  });
}

// ----- progress overview -----
async function progress(box, c, ctx, reload, query) {
  const to = query.to || ctx.today();
  const from = query.from || addDays(to, -29);
  const p = await api.get(`/clients/${c.id}/progress`, { from, to });
  const t = p.trend;
  const cmp = p.comparison;
  const row = (labelTxt, f) => `<tr><th scope="row">${esc(labelTxt)}</th>${['prior7', 'last7', 'last30', 'selected'].map((k) => `<td class="num">${f(cmp[k]) ?? '—'}</td>`).join('')}</tr>`;
  const mv = (s, code) => (s.measurements[code] ? `${num(s.measurements[code].avg, 1)} <span class="sub">(n=${s.measurements[code].count})</span>` : '—');
  box.innerHTML = `
    <section class="card"><div class="card-head"><h2>Trend indicator ${badge(t.indicator)}</h2>${ctx.can('progress.review') ? '<button class="btn primary small" id="review">+ Staff review</button>' : ''}</div>
      <p class="hint">Last 7 days (${esc(t.windows.recent.join(' → '))}) compared with the 30 days before (${esc(t.windows.baseline.join(' → '))}).</p>
      <ul class="list">${t.reasons.map((r) => `<li>${badge(r.kind === 'decline' ? 'possible_decline' : r.kind === 'review' ? 'requires_review' : r.kind === 'improve' ? 'improving' : 'info', label(r.kind))} ${esc(r.text)}
        ${r.evidence.length ? `<details class="sub"><summary>Supporting records (${r.evidence.length}${r.evidence.length === 20 ? '+' : ''})</summary>${r.evidence.map((e) => `${esc(label(e.type))} #${e.id} (${esc(fmtDT(e.at))})`).join(' · ')}</details>` : ''}</li>`).join('')}</ul>
      <p class="disclaimer">${esc(t.disclaimer)}</p></section>
    ${p.alerts.length ? `<section class="card"><h2>Open alerts</h2><ul class="list">${p.alerts.map((a) => `<li>${badge(a.severity)} ${esc(a.message)} <span class="sub">${fmtISO(a.created_at)} · ${esc(label(a.status))}</span></li>`).join('')}</ul><a href="#/incidents?client_id=${c.id}">Manage alerts →</a></section>` : ''}
    <section class="card"><div class="card-head"><h2>Comparison</h2>
      <form class="filters noprint" id="range">${fields([{ name: 'from', label: 'Selected from', type: 'date', value: from }, { name: 'to', label: 'to', type: 'date', value: to }])}</form></div>
      <div class="table-wrap"><table><thead><tr><th></th><th class="num">Prior 7 days</th><th class="num">Last 7 days</th><th class="num">Last 30 days</th><th class="num">Selected period</th></tr></thead><tbody>
      ${row('Meal entries', (s) => s.meals.entries)}
      ${row('Avg % of meals eaten', (s) => s.meals.avg_pct_consumed)}
      ${row('Meals refused', (s) => s.meals.refused)}
      ${row('Avg fluids / recorded day (mL)', (s) => s.fluids.avg_ml_per_recorded_day)}
      ${row('ADL tasks completed', (s) => s.adl.completed ?? 0)}
      ${row('ADL tasks declined / not done', (s) => (s.adl.declined ?? 0) + (s.adl.not_completed ?? 0))}
      ${row('Activities (declined)', (s) => `${s.activities.entries} (${s.activities.declined})`)}
      ${row('Avg pain score', (s) => s.observations.pain_avg)}
      ${row('Poor sleep observations', (s) => s.observations.poor_sleep)}
      ${row('Reduced alertness observations', (s) => s.observations.reduced_alertness)}
      ${row('Agitation / distress', (s) => s.observations.agitation + s.observations.distress)}
      ${row('Falls / near-falls', (s) => `${s.observations.falls} / ${s.observations.near_falls}`)}
      ${row('Avg weight', (s) => mv(s, 'weight'))}
      ${row('Avg systolic BP', (s) => mv(s, 'bp'))}
      ${row('Avg glucose', (s) => mv(s, 'glucose'))}
      ${row('Incidents', (s) => s.incidents)}
      ${row('Medication changes', (s) => s.med_changes)}
      ${row('Care transitions', (s) => s.transitions)}
      </tbody></table></div><p class="hint">“—” means no records in that window; values are never estimated.</p></section>
    <div class="grid two">
      <section class="card"><h2>Timeline</h2>${p.timeline.length ? `<ul class="timeline">${p.timeline.map((e) => `<li class="k-${esc(e.kind)}"><div class="when">${esc(fmtDT(e.at))}</div><strong>${esc(e.title)}</strong>${e.detail ? `<div class="hint">${esc(e.detail)}</div>` : ''}</li>`).join('')}</ul>` : empty('Nothing documented in this period.')}</section>
      <section class="card"><h2>Staff reviews</h2>${p.reviews.length ? `<ul class="list">${p.reviews.map((r) => `<li>${badge(r.assessment)} <strong>${esc(r.author)}</strong> <span class="sub">${fmtISO(r.created_at)}</span>
        <p>${esc(r.summary)}</p>${r.action_taken ? `<p class="hint">Action: ${esc(r.action_taken)}</p>` : ''}
        ${r.concern_resolved_at ? `<p class="hint">Resolved ${fmtDate(r.concern_resolved_at)}</p>` : ctx.can('progress.review') ? `<button class="btn link" data-resolve="${r.id}">Mark concern resolved</button>` : ''}</li>`).join('')}</ul>` : empty('No staff reviews yet.')}</section>
    </div>`;
  box.querySelector('#range').addEventListener('change', (e) => {
    const v = readForm(e.currentTarget);
    location.hash = `#/clients/${c.id}?tab=progress&from=${v.from}&to=${v.to}`;
  });
  box.querySelector('#review')?.addEventListener('click', async () => {
    if (await formModal({
      title: 'Professional / supervisory review', wide: true,
      intro: `<p class="hint">Your own assessment after reviewing the records. The automated indicator is currently “${esc(label(t.indicator))}”.</p>`,
      defs: [
        { name: 'assessment', label: 'Assessment', type: 'select', required: true, options: [['improving', 'Improving'], ['stable', 'Stable'], ['possible_decline', 'Possible decline'], ['requires_review', 'Requires further review']] },
        { name: 'period_from', label: 'Period from', type: 'date', value: from }, { name: 'period_to', label: 'to', type: 'date', value: to },
        { name: 'summary', label: 'Summary of review', type: 'textarea', required: true, full: true, rows: 4 },
        { name: 'action_taken', label: 'Action taken / person notified', type: 'textarea', full: true },
      ],
      submit: (v) => api.post(`/clients/${c.id}/reviews`, v),
    })) reload();
  });
  box.addEventListener('click', async (e) => {
    const id = e.target.dataset.resolve;
    if (id) { await api.patch(`/progress-reviews/${id}`, { concern_resolved_at: ctx.today() }); reload(); }
  });
}

// ----- care transitions -----
async function transitions(box, c, ctx, reload) {
  const list = await api.get('/transitions', { client_id: c.id });
  const typeLabel = Object.fromEntries(TRANSITION_TYPES);
  box.innerHTML = `<section class="card"><div class="card-head"><h2>Care transitions</h2>${ctx.can('transitions.manage') ? '<button class="btn primary small" id="addt">+ Record event</button>' : ''}</div>
    <div class="grid three">
      <div>${kv([['Residence status', badge(c.status)], ['Hospice status', badge(c.hospice_status, label(c.hospice_status))]])}</div>
    </div>
    ${table([
    { label: 'Date', render: (t) => fmtDate(t.event_date) },
    { label: 'Event', render: (t) => `<strong>${esc(typeLabel[t.event_type] || t.event_type)}</strong>${t.status ? `<div class="sub">${esc(t.status)}</div>` : ''}` },
    { label: 'Location / provider', render: (t) => esc([t.location, t.provider, t.contact].filter(Boolean).join(' · ')) },
    { label: 'Source', render: (t) => esc(t.source || '') },
    { label: 'Notes / impact', cls: 'wrap', render: (t) => esc([t.notes, t.service_impact].filter(Boolean).join(' · ')) },
    { label: 'Follow-up', render: (t) => (t.follow_up_due ? `${fmtDate(t.follow_up_due)} ${t.follow_up_done ? badge('complete', 'Done') : `${badge('pending')} ${ctx.can('transitions.manage') ? `<button class="btn link" data-done="${t.id}">Mark done</button>` : ''}`}` : '—') },
    { label: 'By', render: (t) => esc(t.created_by_name) },
  ], list, { empty: 'No hospital, hospice or other transitions recorded.' })}</section>`;
  box.querySelector('#addt')?.addEventListener('click', async () => { if (await transitionDialog(c.id)) reload(); });
  box.addEventListener('click', async (e) => {
    const id = e.target.dataset.done;
    if (id) { await api.patch(`/transitions/${id}`, { follow_up_done: ctx.today() }); reload(); }
  });
}

// ----- care logs -----
async function logs(box, c, ctx) {
  const from = addDays(ctx.today(), -13);
  const rows = await api.get('/care/logs', { client_id: c.id, from });
  box.innerHTML = `<section class="card"><div class="card-head"><h2>Care logs — last 14 days</h2><a class="btn ghost small" href="#/care-logs?client_id=${c.id}">Open in Daily Care Logs</a></div>${logTable(rows)}</section>`;
}

export function logSummary(r) {
  switch (r.type) {
    case 'adl': return `${badge(r.status)} ${esc(r.task)}${r.notes ? ` — ${esc(r.notes)}` : ''}`;
    case 'meals': return `<strong>${esc(label(r.meal))}</strong>${r.percent_consumed != null ? ` · ${r.percent_consumed}% eaten` : ''}${r.fluid_ml != null ? ` · ${r.fluid_ml} mL` : ''}${r.refused ? ' · ' + badge('refused') : ''}${r.swallowing_issue ? ' · ' + badge('high', 'swallowing difficulty') : ''}${r.appetite ? ` · appetite ${esc(r.appetite)}` : ''}${r.notes ? `<div class="sub">${esc(r.notes)}</div>` : ''}`;
    case 'activities': return `<strong>${esc(r.activity)}</strong>${r.minutes ? ` · ${r.minutes} min` : ''}${r.participation ? ` · ${esc(r.participation)}` : ''}${r.tolerance ? ` · tolerance ${esc(r.tolerance)}` : ''}${r.notes ? `<div class="sub">${esc(r.notes)}</div>` : ''}`;
    case 'observations': return `${[r.mood && `Mood: ${esc(r.mood)}`, r.alertness && esc(label(r.alertness)), r.sleep && `Sleep: ${esc(r.sleep)}`, r.pain_score != null && `Pain ${r.pain_score}/10`, r.fall_event !== 'none' && badge('high', label(r.fall_event)), r.agitation && badge('warn', 'agitation'), r.distress && badge('warn', 'distress'), r.skin_change && badge('warn', 'skin change')].filter(Boolean).join(' · ')}
      ${r.observation ? `<div>${esc(r.observation)}</div>` : ''}${r.action_taken ? `<div class="sub">Action: ${esc(r.action_taken)}${r.notified ? ` · notified ${esc(r.notified)}` : ''}</div>` : ''}`;
    default: return '';
  }
}
export function logTable(rows, { showClient = false } = {}) {
  return table([
    { label: 'When', render: (r) => fmtDT(r.recorded_at) },
    ...(showClient ? [{ label: 'Client', render: (r) => esc(r.client_name) }] : []),
    { label: 'Type', render: (r) => esc({ adl: 'ADL', meals: 'Meal / fluids', activities: 'Activity', observations: 'Observation' }[r.type]) },
    { label: 'Entry', cls: 'wrap', render: logSummary },
    { label: 'Author', render: (r) => `${esc(r.author)}${r.shift_id ? `<div class="sub">shift #${r.shift_id}</div>` : ''}` },
  ], rows, { empty: 'No care documentation in this period.' });
}
