import { api } from '../api.js';
import { esc, table, tabs, badge, fields, readForm, opts, fmtDate, fmtDT, label, addDays, num, empty, kv } from '../ui.js';
import { changeTable, changeActions } from './clients.js';

const TABS = [['lists', 'Medication lists'], ['changes', 'Change history & verification'], ['records', 'Administration / assistance records']];

export async function render(el, parts, query, ctx) {
  if (parts[0] === 'change' && parts[1]) return compare(el, Number(parts[1]), query, ctx);
  const tab = query.tab || 'lists';
  el.innerHTML = `<div class="page-head"><div><h1>Medication Management</h1><p>Orders are changed only by authorized staff; every change is recorded with who documented and verified it.</p></div></div>
    ${tabs(TABS, tab)}<div id="tab"></div>`;
  el.querySelector('.tabs').addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (t) location.hash = `#/medications?tab=${t.dataset.tab}`; });
  const box = el.querySelector('#tab');
  const clients = await api.get('/clients');
  const reload = () => render(el, parts, query, ctx);

  if (tab === 'lists') {
    const meds = await api.get('/medications', { status: query.status || 'active', client_id: query.client_id });
    const byClient = {};
    for (const m of meds) (byClient[m.client_id] ||= { name: m.client_name, reconciled: m.meds_reconciled_on, meds: [] }).meds.push(m);
    box.innerHTML = `<section class="card"><form class="filters" id="filters">${fields([
      { name: 'client_id', label: 'Client', type: 'select', options: opts(clients, 'legal_name'), value: query.client_id },
      { name: 'status', label: 'Status', type: 'select', required: true, options: [['active', 'Active'], ['on_hold', 'On hold'], ['discontinued', 'Discontinued']], value: query.status || 'active' },
    ])}</form></section>
      ${Object.entries(byClient).map(([cid, g]) => `<section class="card"><div class="card-head"><h2><a href="#/clients/${cid}?tab=meds">${esc(g.name)}</a></h2>
        <span class="hint">Reconciled: ${g.reconciled ? fmtDate(g.reconciled) : badge('warn', 'never')}</span></div>
        ${table([
    { label: 'Medication', render: (m) => `<strong>${esc(m.name)}</strong> ${esc(m.strength || '')}${m.prn ? ' ' + badge('info', 'PRN') : ''}` },
    { label: 'Dose / route', render: (m) => `${esc(m.dose || '')} ${esc(m.route || '')}` },
    { label: 'Schedule', render: (m) => `${esc(m.frequency || '')}<div class="sub">${esc(m.times || '')}</div>` },
    { label: 'Prescriber', render: (m) => esc(m.prescriber || '') },
    { label: 'Instructions / precautions', cls: 'wrap', render: (m) => esc([m.instructions, m.precautions].filter(Boolean).join(' · ')) },
    { label: 'Status', render: (m) => badge(m.status) },
  ], g.meds)}</section>`).join('') || `<section class="card">${empty('No medications match.')}</section>`}`;
  }

  if (tab === 'changes') {
    const rows = await api.get('/medication-changes', { client_id: query.client_id, review_status: query.review_status, unverified: query.unverified });
    box.innerHTML = `<section class="card"><form class="filters" id="filters">${fields([
      { name: 'client_id', label: 'Client', type: 'select', options: opts(clients, 'legal_name'), value: query.client_id },
      { name: 'review_status', label: 'Review status', type: 'select', options: [['pending', 'Pending'], ['in_review', 'In review'], ['closed', 'Closed']], value: query.review_status },
      { name: 'unverified', label: 'Verification', type: 'select', options: [['1', 'Not verified only']], value: query.unverified },
    ])}</form>${changeTable(rows, ctx)}</section>`;
    box.addEventListener('click', (e) => changeActions(e, reload));
  }

  if (tab === 'records') {
    const from = query.from || addDays(ctx.today(), -13);
    const to = query.to || ctx.today();
    const rows = await api.get('/med-events', { client_id: query.client_id, action: query.action, from, to });
    box.innerHTML = `<section class="card"><form class="filters" id="filters">${fields([
      { name: 'client_id', label: 'Client', type: 'select', options: opts(clients, 'legal_name'), value: query.client_id },
      { name: 'action', label: 'Recorded action', type: 'select', options: ['administered', 'assisted', 'refused', 'omitted', 'held', 'discrepancy'].map((a) => [a, label(a)]), value: query.action },
      { name: 'from', label: 'From', type: 'date', value: from }, { name: 'to', label: 'To', type: 'date', value: to },
    ])}</form>
    ${table([
    { label: 'Scheduled', render: (e) => (e.scheduled_for ? fmtDT(e.scheduled_for) : 'PRN / unscheduled') },
    { label: 'Client', render: (e) => esc(e.client_name) },
    { label: 'Medication', render: (e) => `${esc(e.medication_name)}<div class="sub">${esc(e.dose || '')}</div>` },
    { label: 'Action', render: (e) => badge(['administered', 'assisted'].includes(e.action) ? 'completed' : e.action, label(e.action)) },
    { label: 'Actual time', render: (e) => fmtDT(e.actual_time) },
    { label: 'Notes / observations', cls: 'wrap', render: (e) => `${esc(e.notes || '')}${e.adverse_observation ? `<div>${badge('high', 'Observation')} ${esc(e.adverse_observation)}</div>` : ''}` },
    { label: 'By', render: (e) => esc(e.author) },
  ], rows, { empty: 'No medication records in this period.' })}</section>`;
  }
  box.querySelector('#filters')?.addEventListener('change', (e) => { location.hash = `#/medications${api.qs({ tab, ...readForm(e.currentTarget) })}`; });
}

/** Before/after review: temporal association only. */
async function compare(el, id, query, ctx) {
  const days = Number(query.days) || 14;
  const d = await api.get(`/medication-changes/${id}/compare`, { days });
  const b = d.before;
  const a = d.after;
  const row = (lbl, f) => `<tr><th scope="row">${esc(lbl)}</th><td class="num">${f(b) ?? '—'}</td><td class="num">${f(a) ?? '—'}</td></tr>`;
  const mv = (s, code) => (s.measurements[code] ? `${num(s.measurements[code].avg, 1)} (n=${s.measurements[code].count})` : '—');
  const c = d.change;
  el.innerHTML = `
    <div class="page-head"><div><a class="hint" href="#/medications?tab=changes">← Medication changes</a><h1>Before / after review</h1>
      <p>${esc(c.medication_name)} · ${esc(label(c.change_type))} effective ${fmtDate(c.effective_date)}</p></div>
      <div class="page-actions"><form id="win" class="filters">${fields([{ name: 'days', label: 'Window (days each side)', type: 'select', required: true, options: [[7, '7'], [14, '14'], [30, '30']], value: days }])}</form>
      <button class="btn ghost" id="print">Print</button></div></div>
    <div class="notice warn"><strong>Temporal association only</strong>${esc(d.disclaimer)}</div>
    <div class="grid two">
      <section class="card"><h2>Change</h2>${kv([['Change', esc(label(c.change_type))], ['From', esc(c.previous_value || '—')], ['To', esc(c.new_value || '—')], ['Details', esc(c.details || '—')],
    ['Verified', c.verified ? badge('verified') : badge('high', 'Not verified')], ['Follow-up', esc(c.follow_up || '—')], ['Review', badge(c.review_status)]])}</section>
      <section class="card"><h2>Other events in the window</h2>
        <p class="hint">These may also explain changes and should be considered.</p>
        ${d.confounders.other_medication_changes.length || d.confounders.care_transitions.length ? `<ul class="list">
          ${d.confounders.other_medication_changes.map((x) => `<li>${fmtDate(x.effective_date)} — ${esc(x.name)}: ${esc(label(x.change_type))}</li>`).join('')}
          ${d.confounders.care_transitions.map((x) => `<li>${fmtDate(x.event_date)} — ${esc(label(x.event_type))}</li>`).join('')}</ul>` : empty('No other medication changes or care transitions documented.')}</section>
    </div>
    <section class="card"><h2>Documented observations: ${days} days before vs ${days} days from the change</h2>
      <div class="table-wrap"><table><thead><tr><th></th><th class="num">Before (${esc(b.period.from)} → ${esc(b.period.to)})</th><th class="num">After (${esc(a.period.from)} → ${esc(a.period.to)})</th></tr></thead><tbody>
      ${row('Meal entries', (s) => s.meals.entries)}
      ${row('Avg % of meals eaten', (s) => s.meals.avg_pct_consumed)}
      ${row('Meals refused', (s) => s.meals.refused)}
      ${row('Reports of decreased/poor appetite', (s) => s.meals.low_appetite)}
      ${row('Avg fluids per recorded day (mL)', (s) => s.fluids.avg_ml_per_recorded_day)}
      ${row('Observation entries', (s) => s.observations.entries)}
      ${row('Poor sleep observations', (s) => s.observations.poor_sleep)}
      ${row('Reduced alertness observations', (s) => s.observations.reduced_alertness)}
      ${row('Agitation / distress observations', (s) => s.observations.agitation + s.observations.distress)}
      ${row('Avg pain score', (s) => s.observations.pain_avg)}
      ${row('Falls / near-falls', (s) => `${s.observations.falls} / ${s.observations.near_falls}`)}
      ${row('Most frequent moods', (s) => s.observations.moods.slice(0, 3).map((m) => `${esc(m.mood)} (${m.n})`).join(', ') || '—')}
      ${row('Activities (declined)', (s) => `${s.activities.entries} (${s.activities.declined})`)}
      ${row('Avg weight', (s) => mv(s, 'weight'))}
      ${row('Avg systolic BP', (s) => mv(s, 'bp'))}
      ${row('Avg glucose', (s) => mv(s, 'glucose'))}
      ${row('Avg pulse', (s) => mv(s, 'pulse'))}
      ${row('Incidents', (s) => s.incidents)}
      </tbody></table></div>
      <p class="hint">Counts depend on how often care was documented in each window. “—” means nothing was recorded.</p></section>
    <section class="card"><h2>Timeline after the change</h2>${d.after_timeline.length ? `<ul class="timeline">${d.after_timeline.map((e) => `<li class="k-${esc(e.kind)}"><div class="when">${esc(fmtDT(e.at))}</div><strong>${esc(e.title)}</strong>${e.detail ? `<div class="hint">${esc(e.detail)}</div>` : ''}</li>`).join('')}</ul>` : empty('Nothing documented after the change yet.')}</section>`;
  el.querySelector('#win').addEventListener('change', (e) => { location.hash = `#/medications/change/${id}?days=${readForm(e.currentTarget).days}`; });
  el.querySelector('#print').addEventListener('click', () => window.print());
}
