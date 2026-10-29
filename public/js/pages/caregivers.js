import { api } from '../api.js';
import { esc, onClick, table, wireRowLinks, badge, sampleBadge, formModal, fields, readForm, kv, fmtDate, fmtISO, money, label, toast, showError, confirmDialog, opts, modal } from '../ui.js';
import { dayNames } from './clients.js';

const o = (vals) => vals.map((v) => [v, label(v)]);
export function caregiverDefs(lk, { create = false } = {}) {
  return [
    { name: 'full_name', label: 'Full name', required: true },
    { name: 'code', label: 'Caregiver ID', type: create ? 'text' : 'readonly', hint: create ? 'Leave blank to auto-generate.' : '' },
    { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'email', label: 'Email', type: 'email' },
    { name: 'address', label: 'Address', full: true },
    { name: 'emergency_name', label: 'Emergency contact' }, { name: 'emergency_phone', label: 'Emergency phone', type: 'tel' },
    { name: 'employment_status', label: 'Employment status', type: 'select', required: true, value: 'active', options: o(['applicant', 'active', 'on_leave', 'terminated']) },
    { name: 'employment_class', label: 'Classification', type: 'select', required: true, value: 'w2_hourly', options: [['w2_hourly', 'W-2 hourly'], ['w2_salaried', 'W-2 salaried'], ['per_diem', 'Per diem'], ['contractor', '1099 contractor']] },
    { name: 'hire_date', label: 'Hire date', type: 'date' }, { name: 'termination_date', label: 'Termination date', type: 'date' },
    { name: 'facility_id', label: 'Primary location', type: 'select', options: opts(lk.facilities) },
    ...(create ? [{ name: 'pay_rate', label: 'Standard hourly pay rate ($)', type: 'money', required: true }, { name: 'rate_effective_from', label: 'Rate effective from', type: 'date' }] : []),
    { name: 'overtime_rule', label: 'Overtime rule', type: 'select', required: true, value: 'weekly40', options: [['weekly40', 'Over 40 h/week (FLSA)'], ['daily8_weekly40', 'Over 8 h/day and 40 h/week'], ['none', 'Exempt / no overtime']], hint: 'Confirm with your state and federal requirements.' },
    { name: 'ot_multiplier', label: 'Overtime multiplier', type: 'number', step: '0.05', min: 1, value: 1.5 },
    { name: 'mileage_rate', label: 'Mileage reimbursement ($/mile)', type: 'money', value: '0.67' },
    { name: 'background_status', label: 'Background check', type: 'select', required: true, value: 'not_started', options: o(['not_started', 'pending', 'cleared', 'flagged', 'not_required']) },
    { name: 'background_date', label: 'Background check date', type: 'date' },
    { name: 'med_authority', label: 'Medication authority', type: 'select', required: true, value: 'assist', options: [['none', 'None — report only'], ['assist', 'Medication assistance'], ['administer', 'Administration (delegated / licensed)']], hint: 'Must match training, delegation and state rules.' },
    { name: 'responsibilities', label: 'Approved care responsibilities', type: 'textarea', full: true, rows: 2 },
    { name: 'restrictions', label: 'Restrictions', type: 'textarea', full: true, rows: 2 },
    { name: 'availability', label: 'Preferred availability', type: 'textarea', full: true, rows: 2 },
  ];
}

export async function render(el, parts, query, ctx) {
  if (parts[0]) return renderDetail(el, Number(parts[0]), ctx);
  const lk = await ctx.lookups();
  const rows = await api.get('/caregivers', { q: query.q, status: query.status, facility_id: query.facility_id });
  const sens = ctx.can('caregivers.sensitive');
  el.innerHTML = `
    <div class="page-head"><div><h1>Caregivers</h1><p>${rows.length} caregiver${rows.length === 1 ? '' : 's'}</p></div>
      <div class="page-actions">${ctx.can('caregivers.manage') ? '<button class="btn primary" id="add">+ Register caregiver</button>' : ''}</div></div>
    <section class="card">
      <form class="filters" id="filters">${fields([
    { name: 'q', label: 'Search name or ID', value: query.q },
    { name: 'status', label: 'Status', type: 'select', options: o(['applicant', 'active', 'on_leave', 'terminated']), value: query.status },
    { name: 'facility_id', label: 'Location', type: 'select', options: opts(lk.facilities), value: query.facility_id },
  ])}</form>
      ${table([
    { label: 'Caregiver', render: (c) => `<strong>${esc(c.full_name)}</strong>${sampleBadge(c)}<div class="sub">${esc(c.code)}</div>` },
    { label: 'Status', render: (c) => badge(c.employment_status) },
    { label: 'Clients', num: true, render: (c) => c.active_clients },
    ...(sens ? [{ label: 'Pay rate', num: true, render: (c) => (c.pay_rate_cents != null ? `${money(c.pay_rate_cents)}/h` : badge('high', 'None')) }] : []),
    { label: 'Medication role', render: (c) => esc(label(c.med_authority)) },
    { label: 'Login', render: (c) => (c.has_login ? badge('ok', 'Yes') : badge('muted', 'No')) },
    { label: 'Warnings', cls: 'wrap', render: (c) => c.warnings.map((w) => badge(/expired|background|pay_rate/.test(w.kind) ? 'high' : 'medium', w.text)).join(' ') || '—' },
  ], rows, { rowLink: (c) => `#/caregivers/${c.id}`, empty: 'No caregivers match these filters.' })}
    </section>`;
  wireRowLinks(el);
  el.querySelector('#filters').addEventListener('change', (e) => { location.hash = `#/caregivers${api.qs(readForm(e.currentTarget))}`; });
  el.querySelector('#add')?.addEventListener('click', async () => {
    const r = await formModal({ title: 'Register caregiver', wide: true, defs: caregiverDefs(lk, { create: true }), values: { rate_effective_from: ctx.today() }, submitLabel: 'Register', submit: (v) => api.post('/caregivers', v) });
    if (r) { toast(`Caregiver ${r.code} registered.`, 'ok'); location.hash = `#/caregivers/${r.id}`; }
  });
}

async function renderDetail(el, id, ctx) {
  const lk = await ctx.lookups();
  const c = await api.get(`/caregivers/${id}`);
  const sens = 'pay_rates' in c;
  const manage = ctx.can('caregivers.manage');
  const reload = () => renderDetail(el, id, ctx);
  el.innerHTML = `
    <div class="page-head"><div><a href="#/caregivers" class="hint">← Caregivers</a><h1>${esc(c.full_name)}${sampleBadge(c)}</h1><p>${esc(c.code)} · ${badge(c.employment_status)}</p></div>
      <div class="page-actions">
        ${manage ? '<button class="btn ghost" id="edit">Edit profile</button>' : ''}
        ${ctx.can('users.manage') && !c.user ? '<button class="btn ghost" id="login">Create login</button>' : ''}
        <a class="btn ghost" href="#/schedule?tab=assignments&caregiver_id=${c.id}">Assignments</a>
        <a class="btn ghost" href="#/reports?caregiver_id=${c.id}">Timesheet report</a></div></div>
    ${c.warnings.length ? `<div class="notice warn"><strong>Needs attention</strong>${c.warnings.map((w) => esc(w.text)).join(' · ')}</div>` : ''}
    <div class="grid two">
      <section class="card"><h2>Profile</h2>${kv([
    ['Phone', esc(c.phone)], ['Email', esc(c.email)], ['Address', esc(c.address)], ['Emergency contact', esc([c.emergency_name, c.emergency_phone].filter(Boolean).join(' · '))],
    ['Location', esc(c.facility_name)], ['Medication authority', esc(label(c.med_authority))], ['Responsibilities', esc(c.responsibilities)], ['Restrictions', esc(c.restrictions)],
    ['Availability', esc(c.availability)],
    ...(sens ? [['Classification', esc(label(c.employment_class))], ['Hire / termination', `${fmtDate(c.hire_date)}${c.termination_date ? ` → ${fmtDate(c.termination_date)}` : ''}`],
      ['Background check', `${badge(c.background_status)} ${fmtDate(c.background_date)}`], ['Overtime', `${esc(label(c.overtime_rule))} × ${c.ot_multiplier}`], ['Mileage rate', `${money(c.mileage_rate_cents)}/mile`]] : []),
    ['Login', c.user ? `${esc(c.user.username)} ${c.user.active ? badge('active') : badge('muted', 'disabled')}<div class="sub">Last sign-in ${fmtISO(c.user.last_login_at)}</div>` : 'No login'],
  ])}</section>
      ${sens ? `<section class="card"><div class="card-head"><h2>Pay-rate history</h2>${manage ? '<button class="btn ghost small" id="rate">+ New rate</button>' : ''}</div>
        <p class="hint">Current: <strong>${c.pay_rate_cents != null ? `${money(c.pay_rate_cents)}/h` : 'none in effect'}</strong>. Past shifts keep the rate that applied when worked.</p>
        ${table([{ label: 'Rate', render: (r) => `${money(r.rate_cents)}/h` }, { label: 'From', render: (r) => fmtDate(r.effective_from) }, { label: 'To', render: (r) => (r.effective_to ? fmtDate(r.effective_to) : 'current') }], c.pay_rates)}</section>` : ''}
      <section class="card"><div class="card-head"><h2>Qualifications & credentials</h2>${manage ? '<button class="btn ghost small" id="cred">+ Credential</button>' : ''}</div>
        ${table([
    { label: 'Credential', render: (r) => `<strong>${esc(r.name)}</strong>${r.number ? `<div class="sub">#${esc(r.number)}</div>` : ''}` },
    { label: 'Expires', render: (r) => (r.expires_on ? `${fmtDate(r.expires_on)} ${r.expires_on < ctx.today() ? badge('expired') : ''}` : '—') },
    { label: 'Verified', render: (r) => (r.verified ? badge('verified') : badge('pending', 'Unverified')) },
    ...(manage ? [{ label: '', render: (r) => `<button class="btn link" data-cred="${r.id}">Edit</button><button class="btn link danger-text" data-delcred="${r.id}">Remove</button>` }] : []),
  ], c.credentials, { empty: 'No credentials recorded.' })}</section>
      <section class="card"><h2>Assigned clients</h2>${table([
    { label: 'Client', render: (a) => `<a href="#/clients/${a.client_id}">${esc(a.client_name)}</a>` },
    { label: 'Schedule', render: (a) => `${esc(dayNames(a.days_of_week))} ${esc(a.shift_start)}–${esc(a.shift_end)}` },
    { label: 'Dates', render: (a) => `${fmtDate(a.start_date)} → ${a.end_date ? fmtDate(a.end_date) : 'ongoing'}` },
    { label: 'Status', render: (a) => badge(a.status) },
  ], c.assignments, { empty: 'Not assigned to any clients.' })}</section>
    </div>`;
  el.querySelector('#edit')?.addEventListener('click', async () => {
    const values = { ...c, mileage_rate: (c.mileage_rate_cents / 100).toFixed(2) };
    if (await formModal({ title: 'Edit caregiver', wide: true, defs: caregiverDefs(lk), values, submit: (v) => { delete v.code; return api.patch(`/caregivers/${id}`, v); } })) { toast('Saved.', 'ok'); reload(); }
  });
  el.querySelector('#rate')?.addEventListener('click', async () => {
    if (await formModal({ title: 'New pay rate', defs: [{ name: 'rate', label: 'Hourly rate ($)', type: 'money', required: true }, { name: 'effective_from', label: 'Effective from', type: 'date', required: true, value: ctx.today() }], submit: (v) => api.post(`/caregivers/${id}/pay-rates`, v) })) reload();
  });
  const credDefs = [{ name: 'name', label: 'Credential / training', required: true }, { name: 'number', label: 'Number' }, { name: 'issued_on', label: 'Issued', type: 'date' }, { name: 'expires_on', label: 'Expires', type: 'date' }, { name: 'verified', label: 'Verified', type: 'checkbox' }, { name: 'required', label: 'Required for role', type: 'checkbox', value: true }, { name: 'notes', label: 'Notes', type: 'textarea', full: true }];
  el.querySelector('#cred')?.addEventListener('click', async () => { if (await formModal({ title: 'Add credential', defs: credDefs, submit: (v) => api.post(`/caregivers/${id}/credentials`, v) })) reload(); });
  el.querySelector('#login')?.addEventListener('click', async () => {
    const r = await formModal({
      title: 'Create caregiver login',
      defs: [{ name: 'username', label: 'Username', required: true, value: c.email || '' }, { name: 'display_name', label: 'Display name', required: true, value: c.full_name }],
      submit: (v) => api.post('/users', { ...v, role: 'caregiver', caregiver_id: id }),
    });
    if (r) { await showTempPassword(r.temporary_password); reload(); }
  });
  onClick(el, async (e) => {
    const cid = e.target.dataset.cred;
    const did = e.target.dataset.delcred;
    try {
      if (cid && await formModal({ title: 'Edit credential', defs: credDefs, values: c.credentials.find((x) => x.id === Number(cid)), submit: (v) => api.patch(`/credentials/${cid}`, v) })) reload();
      if (did && await confirmDialog('Remove this credential?', { danger: true })) { await api.del(`/credentials/${did}`); reload(); }
    } catch (err) { showError(err); }
  });
}

export function showTempPassword(pw) {
  return modal({
    title: 'Temporary password',
    body: `<p>Give this one-time password to the user privately. It is shown only once and must be changed at first sign-in.</p>
      <p><code>${esc(pw)}</code></p><div class="actions"><button class="btn primary" data-close>Done</button></div>`,
  });
}
