import { api } from '../api.js';
import { esc, table, tabs, badge, fields, formModal, onSubmit, fmtISO, label, toast, showError, confirmDialog, readForm, opts, downloadBlob, modal } from '../ui.js';
import { showTempPassword } from './caregivers.js';

const TABS = [['agency', 'Agency & rules', 'settings.manage'], ['users', 'Users & permissions', 'users.manage'], ['lists', 'Facilities & lists', 'settings.manage'], ['measurements', 'Measurements', 'settings.manage'], ['audit', 'Audit log', 'audit.view'], ['data', 'Backup & import', 'settings.manage']];
const ROLE_INFO = {
  admin: 'Everything, including users, settings and audit log.',
  manager: 'Facility manager: clients, caregivers, scheduling, care records, payroll and billing. No user/settings management.',
  nurse: 'Clinical: client records, care plans, medications, health, incidents, alerts, transitions and clinical reports. No payroll or billing.',
  caregiver: 'Own profile, shifts and timesheets; assigned clients only; care documentation.',
};

export async function render(el, parts, query, ctx) {
  const visible = TABS.filter(([, , p]) => ctx.can(p));
  const tab = query.tab || visible[0][0];
  el.innerHTML = `<div class="page-head"><div><h1>Settings</h1></div></div>${tabs(visible.map(([k, l]) => [k, l]), tab)}<div id="tab"></div>`;
  el.querySelector('.tabs').addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (t) location.hash = `#/settings?tab=${t.dataset.tab}`; });
  const box = el.querySelector('#tab');
  const reload = async () => { await ctx.lookups(true); render(el, parts, query, ctx); };
  const s = await ctx.lookups(true);

  if (tab === 'agency') {
    const tr = s.trend_rules;
    const nt = s.notifications;
    box.innerHTML = `<div class="grid two">
      <section class="card"><h2>Agency</h2><form class="form" id="agency"><div class="form-grid">${fields([
      { name: 'agency_name', label: 'Agency name', required: true, value: s.agency_name },
      { name: 'timezone', label: 'Time zone (IANA)', required: true, value: s.timezone, hint: 'e.g. America/Los_Angeles, America/Chicago' },
      { name: 'session_idle_minutes', label: 'Sign out after idle (min)', type: 'number', min: 5, value: s.session_idle_minutes },
      { name: 'session_max_hours', label: 'Maximum session (hours)', type: 'number', min: 1, value: s.session_max_hours },
      { name: 'invoice_due_days', label: 'Invoice due (days)', type: 'number', min: 0, value: s.invoice_due_days },
      { name: 'credential_warning_days', label: 'Credential warning (days ahead)', type: 'number', min: 0, value: s.credential_warning_days },
    ])}</div><h3>Timekeeping & overtime</h3><div class="form-grid">${fields([
      { name: 'clock_in_early_minutes', label: 'Clock-in allowed early (min)', type: 'number', min: 0, value: s.clock_in_early_minutes },
      { name: 'clock_in_late_minutes', label: 'Clock-in allowed late (min)', type: 'number', min: 0, value: s.clock_in_late_minutes },
      { name: 'weekly_ot_threshold', label: 'Weekly overtime after (h)', type: 'number', step: '0.5', value: s.weekly_ot_threshold },
      { name: 'daily_ot_threshold', label: 'Daily overtime after (h)', type: 'number', step: '0.5', value: s.daily_ot_threshold, hint: 'Used for caregivers on the daily + weekly rule' },
    ])}</div><p class="hint">Confirm overtime rules with applicable federal and state wage laws. Each caregiver also has an individual overtime rule.</p>
      <div class="actions"><button class="btn primary" type="submit">Save</button></div></form></section>
      <section class="card"><h2>Trend indicator rules</h2><p class="hint">Compare the last 7 days with the prior 30 days. Adjust with your clinical lead; indicators are aids for staff review.</p>
      <form class="form" id="rules"><div class="form-grid">${fields([
      { name: 'minRecords', label: 'Minimum records per window', type: 'number', min: 0, value: tr.minRecords },
      { name: 'weightChangePct', label: 'Weight change (%)', type: 'number', step: '0.5', value: tr.weightChangePct },
      { name: 'fluidDropPct', label: 'Fluid intake drop (%)', type: 'number', value: tr.fluidDropPct },
      { name: 'mealIntakeDropPct', label: 'Meal intake drop (%)', type: 'number', value: tr.mealIntakeDropPct },
      { name: 'painIncrease', label: 'Pain score increase (points)', type: 'number', step: '0.5', value: tr.painIncrease },
      { name: 'fallsIncrease', label: 'Falls increase (per 7 days)', type: 'number', step: '0.5', value: tr.fallsIncrease },
      { name: 'missedMealsWindowDays', label: 'Missed-meal window (days)', type: 'number', min: 1, value: tr.missedMealsWindowDays },
      { name: 'missedMealsCount', label: 'Missed meals to alert', type: 'number', min: 1, value: tr.missedMealsCount },
    ])}</div><h3>Notifications</h3><div class="form-grid">${fields([
      { name: 'upcomingShiftHours', label: 'Upcoming shift notice (hours)', type: 'number', value: nt.upcomingShiftHours },
      { name: 'missedVisitGraceMinutes', label: 'Missed visit after (min late)', type: 'number', value: nt.missedVisitGraceMinutes },
      { name: 'carePlanReviewDays', label: 'Care-plan review notice (days)', type: 'number', value: nt.carePlanReviewDays },
      { name: 'dischargeFollowUpDays', label: 'Discharge follow-up notice (days)', type: 'number', value: nt.dischargeFollowUpDays },
    ])}</div><p class="hint">Notifications appear inside CareHours only. No medical details are sent by email or text message.</p>
      <div class="actions"><button class="btn primary" type="submit">Save rules</button></div></form></section></div>`;
    onSubmit(box.querySelector('#agency'), async (v) => { await api.put('/settings', v); toast('Settings saved.', 'ok'); reload(); });
    onSubmit(box.querySelector('#rules'), async (v) => {
      const trendKeys = Object.keys(tr);
      await api.put('/settings', { trend_rules: Object.fromEntries(trendKeys.map((k) => [k, v[k]])), notifications: Object.fromEntries(Object.keys(nt).map((k) => [k, v[k]])) });
      toast('Rules saved.', 'ok');
    });
  }

  if (tab === 'users') {
    const [users, cgs] = await Promise.all([api.get('/users'), api.get('/caregivers')]);
    box.innerHTML = `<section class="card"><div class="card-head"><h2>User accounts</h2><button class="btn primary small" id="add">+ User</button></div>
      ${table([
      { label: 'User', render: (u) => `<strong>${esc(u.display_name)}</strong><div class="sub">${esc(u.username)}</div>` },
      { label: 'Role', render: (u) => `${badge('info', label(u.role))}${u.caregiver_name ? `<div class="sub">${esc(u.caregiver_name)}</div>` : ''}` },
      { label: 'Status', render: (u) => `${u.active ? badge('active') : badge('muted', 'Disabled')}${u.locked_until && u.locked_until > new Date().toISOString() ? ' ' + badge('high', 'Locked') : ''}${u.must_change_password ? ' ' + badge('pending', 'Must change password') : ''}` },
      { label: 'Last sign-in', render: (u) => fmtISO(u.last_login_at) },
      { label: '', render: (u) => `<button class="btn link" data-edit="${u.id}">Edit</button><button class="btn link" data-reset="${u.id}">Reset password</button>${u.id !== ctx.me.user.id ? `<button class="btn link ${u.active ? 'danger-text' : ''}" data-toggle="${u.id}">${u.active ? 'Disable' : 'Enable'}</button>` : ''}` },
    ], users)}</section>
      <section class="card"><h2>Roles</h2><ul class="list">${Object.entries(ROLE_INFO).map(([r, d]) => `<li>${badge('info', label(r))} ${esc(d)}</li>`).join('')}</ul>
      <p class="hint">Every protected action is checked on the server. Caregivers can only reach clients they are actively assigned to.</p></section>`;
    const defs = (create) => [
      ...(create ? [{ name: 'username', label: 'Username', required: true }] : []),
      { name: 'display_name', label: 'Display name', required: true },
      { name: 'role', label: 'Role', type: 'select', required: true, options: Object.keys(ROLE_INFO).map((r) => [r, label(r)]) },
      { name: 'caregiver_id', label: 'Linked caregiver profile (caregiver role)', type: 'select', options: opts(cgs, 'full_name') },
    ];
    box.querySelector('#add').addEventListener('click', async () => {
      const r = await formModal({ title: 'New user', defs: defs(true), submit: (v) => api.post('/users', v) });
      if (r) { await showTempPassword(r.temporary_password); reload(); }
    });
    box.addEventListener('click', async (e) => {
      const { edit, reset, toggle } = e.target.dataset;
      try {
        if (edit && await formModal({ title: 'Edit user', defs: defs(false), values: users.find((u) => u.id === Number(edit)), submit: (v) => api.patch(`/users/${edit}`, v) })) reload();
        if (reset && await confirmDialog('Reset this password? The user will be signed out and must set a new password.')) { const r = await api.post(`/users/${reset}/reset-password`); await showTempPassword(r.temporary_password); reload(); }
        if (toggle) { const u = users.find((x) => x.id === Number(toggle)); if (await confirmDialog(`${u.active ? 'Disable' : 'Enable'} ${u.display_name}?`, { danger: u.active })) { await api.patch(`/users/${toggle}`, { active: !u.active }); reload(); } }
      } catch (err) { showError(err); }
    });
  }

  if (tab === 'lists') {
    const list = (title, rows, cols, kind, defs) => `<section class="card"><div class="card-head"><h2>${esc(title)}</h2><button class="btn ghost small" data-add="${kind}">+ Add</button></div>
      ${table([...cols, { label: '', render: (r) => `<button class="btn link" data-edit="${kind}:${r.id}">Edit</button>` }], rows)}</section>`;
    const DEFS = {
      facilities: [{ name: 'name', label: 'Name', required: true }, { name: 'kind', label: 'Type', type: 'select', required: true, options: [['afh', 'Adult Family Home'], ['home_care', 'Home care agency'], ['assisted_living', 'Assisted living'], ['residential', 'Residential care'], ['other', 'Other']] }, { name: 'address', label: 'Address', full: true }, { name: 'phone', label: 'Phone' }, { name: 'capacity', label: 'Capacity', type: 'number', min: 0 }, { name: 'active', label: 'Active', type: 'checkbox', value: true }],
      categories: [{ name: 'name', label: 'Category', required: true }, { name: 'active', label: 'Active', type: 'checkbox', value: true }],
      'service-types': [{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Service', required: true }, { name: 'active', label: 'Active', type: 'checkbox', value: true }],
    };
    const rowsBy = { facilities: s.facilities, categories: s.categories, 'service-types': s.service_types };
    box.innerHTML = `<div class="grid three">
      ${list('Facilities & locations', s.facilities, [{ label: 'Name', render: (f) => `${esc(f.name)}<div class="sub">${esc(label(f.kind))}</div>` }, { label: 'Status', render: (f) => badge(f.active ? 'active' : 'ended', f.active ? 'Active' : 'Inactive') }], 'facilities')}
      ${list('Client categories', s.categories, [{ label: 'Category', key: 'name' }, { label: 'Status', render: (f) => badge(f.active ? 'active' : 'ended', f.active ? 'Active' : 'Inactive') }], 'categories')}
      ${list('Service types', s.service_types, [{ label: 'Service', render: (f) => `${esc(f.name)}<div class="sub">${esc(f.code)}</div>` }, { label: 'Status', render: (f) => badge(f.active ? 'active' : 'ended', f.active ? 'Active' : 'Inactive') }], 'service-types')}
      <section class="card"><h2>Expense categories</h2><form class="form" id="expcats">${fields([{ name: 'cats', label: 'One per line', type: 'textarea', rows: 8, value: (s.expense_categories || []).join('\n') }])}<div class="actions"><button class="btn primary small" type="submit">Save</button></div></form></section></div>`;
    box.addEventListener('click', async (e) => {
      const add = e.target.dataset.add;
      const edit = e.target.dataset.edit;
      if (add && await formModal({ title: 'Add', defs: DEFS[add], submit: (v) => api.post(`/${add}`, v) })) reload();
      if (edit) {
        const [kind, id] = edit.split(':');
        if (await formModal({ title: 'Edit', defs: DEFS[kind], values: rowsBy[kind].find((r) => r.id === Number(id)), submit: (v) => api.patch(`/${kind}/${id}`, v) })) reload();
      }
    });
    onSubmit(box.querySelector('#expcats'), async (v) => { await api.put('/settings', { expense_categories: (v.cats || '').split('\n') }); toast('Saved.', 'ok'); reload(); });
  }

  if (tab === 'measurements') {
    box.innerHTML = `<section class="card"><div class="card-head"><h2>Measurement types & facility default thresholds</h2><button class="btn ghost small" id="add">+ Measurement</button></div>
      <div class="notice warn"><strong>Defaults are placeholders, not clinical guidance.</strong>Set defaults according to facility policy and individualized thresholds per client with an authorized clinician.</div><br>
      ${table([
      { label: 'Measurement', render: (t) => `<strong>${esc(t.name)}</strong> <span class="sub">${esc(t.unit)}</span>` },
      { label: 'Default low / high', render: (t) => `${t.default_low ?? '—'} / ${t.default_high ?? '—'}${t.has_second_value ? `<div class="sub">2nd: ${t.default_low2 ?? '—'} / ${t.default_high2 ?? '—'}</div>` : ''}` },
      { label: 'Expected every', render: (t) => (t.expected_every_days ? `${t.expected_every_days} days` : '—') },
      { label: 'Caregivers may record', render: (t) => (t.caregiver_may_record ? badge('ok', 'Yes') : badge('muted', 'Clinical staff only')) },
      { label: 'Status', render: (t) => (t.active ? badge('active') : badge('muted', 'Inactive')) },
      { label: '', render: (t) => `<button class="btn link" data-code="${esc(t.code)}">Edit</button>` },
    ], s.measurement_types)}</section>`;
    const defs = (t) => [
      { name: 'name', label: 'Name', required: true }, { name: 'unit', label: 'Unit', required: true },
      { name: 'default_low', label: 'Default low', type: 'number', step: 'any' }, { name: 'default_high', label: 'Default high', type: 'number', step: 'any' },
      ...(t?.has_second_value ? [{ name: 'default_low2', label: '2nd value low', type: 'number', step: 'any' }, { name: 'default_high2', label: '2nd value high', type: 'number', step: 'any' }] : []),
      { name: 'expected_every_days', label: 'Expected every (days)', type: 'number', min: 1 },
      { name: 'caregiver_may_record', label: 'Caregivers may record', type: 'checkbox' }, { name: 'active', label: 'Active', type: 'checkbox', value: true },
    ];
    box.addEventListener('click', async (e) => {
      const code = e.target.dataset.code;
      if (code) { const t = s.measurement_types.find((x) => x.code === code); if (await formModal({ title: `Edit ${t.name}`, defs: defs(t), values: t, submit: (v) => api.patch(`/measurement-types/${code}`, v) })) reload(); }
    });
    box.querySelector('#add').addEventListener('click', async () => {
      if (await formModal({ title: 'New measurement', defs: [{ name: 'code', label: 'Code (lowercase)', required: true }, ...defs(null).filter((d) => d.name !== 'active')], submit: (v) => api.post('/measurement-types', v) })) reload();
    });
  }

  if (tab === 'audit') {
    const rows = await api.get('/audit', { entity: query.entity, user: query.user, action: query.action, from: query.from, to: query.to, limit: 500 });
    box.innerHTML = `<section class="card"><p class="hint">Who accessed or changed protected records, and when. Clinical values are not copied into the log; financial and time changes show before/after values.</p>
      <form class="filters" id="filters">${fields([
      { name: 'user', label: 'Username', value: query.user }, { name: 'action', label: 'Action', type: 'select', value: query.action, options: ['view', 'create', 'update', 'delete', 'approve', 'login', 'login_failed', 'export', 'clock_in', 'clock_out', 'verify', 'void', 'reset_password'].map((a) => [a, label(a)]) },
      { name: 'entity', label: 'Record type', value: query.entity }, { name: 'from', label: 'From', type: 'date', value: query.from }, { name: 'to', label: 'To', type: 'date', value: query.to },
    ])}</form>
      ${table([
      { label: 'When', render: (a) => fmtISO(a.at) }, { label: 'User', render: (a) => esc(a.username || '—') }, { label: 'Action', render: (a) => badge('info', label(a.action)) },
      { label: 'Record', render: (a) => `${esc(label(a.entity))}${a.entity_id ? ` #${a.entity_id}` : ''}${a.client_id ? `<div class="sub">client #${a.client_id}</div>` : ''}` },
      { label: 'Details', cls: 'wrap', render: (a) => `<span class="sub">${esc(a.details || '')}</span>` }, { label: 'IP', render: (a) => `<span class="sub">${esc(a.ip || '')}</span>` },
    ], rows, { empty: 'No audit entries match.' })}</section>`;
    box.querySelector('#filters').addEventListener('change', (e) => { location.hash = `#/settings${api.qs({ tab: 'audit', ...readForm(e.currentTarget) })}`; });
  }

  if (tab === 'data') {
    box.innerHTML = `<div class="grid two">
      <section class="card"><h2>Database backup</h2><p>Download a consistent copy of the entire database. Store backups encrypted, off-site, and test restoring them regularly.</p>
        <button class="btn primary" id="backup">Download backup</button>
        <p class="hint">Server operators can also run <code>npm run backup</code> on a schedule (see README). Downloads are recorded in the audit log.</p></section>
      <section class="card"><h2>Import from CareHours v1</h2><p>Bring in caregivers, clients and visits from the earlier browser-only version (Settings → “Download backup (JSON)”).</p>
        <p class="hint">Old PINs are not imported; create proper user accounts afterwards. Imported visits are marked “pending approval”. Re-importing the same file skips duplicates.</p>
        <input type="file" id="legacy" accept="application/json"><br><br><button class="btn ghost" id="import">Import file</button></section></div>`;
    box.querySelector('#backup').addEventListener('click', async () => {
      try { const r = await api.raw('/backup'); downloadBlob(`carehours-backup-${ctx.today()}.sqlite`, await r.blob()); } catch (err) { showError(err); }
    });
    box.querySelector('#import').addEventListener('click', async () => {
      const f = box.querySelector('#legacy').files[0];
      if (!f) return toast('Choose a file first.');
      try {
        const data = JSON.parse(await f.text());
        const r = await api.post('/import/legacy', data);
        await modal({ title: 'Import complete', body: `<p>Caregivers: ${r.caregivers} · Clients: ${r.clients} · Visits: ${r.visits} · Skipped: ${r.skipped}</p><div class="actions"><button class="btn primary" data-close>OK</button></div>` });
        reload();
      } catch (err) { showError(err.message.includes('JSON') ? new Error('That file is not valid JSON.') : err); }
    });
  }
}
