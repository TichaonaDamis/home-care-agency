import { api } from '../api.js';
import { esc, fields, readForm, opts, addDays, downloadCsv, modal } from '../ui.js';
import { logTable } from './clients.js';
import { adlDialog, mealDialog, activityDialog, observationDialog } from './shared.js';

export async function render(el, parts, query, ctx) {
  const to = query.to || ctx.today();
  const from = query.from || addDays(to, -6);
  const [clients, cgs, rows] = await Promise.all([
    api.get('/clients'), api.get('/caregivers'),
    api.get('/care/logs', { from, to, client_id: query.client_id, caregiver_id: query.caregiver_id, types: query.types }),
  ]);
  const undoc = await api.get('/shifts', { from, to, doc_incomplete: 1, client_id: query.client_id, caregiver_id: query.caregiver_id });
  el.innerHTML = `
    <div class="page-head"><div><h1>Daily Care Logs</h1><p>ADLs, meals & fluids, activities and condition observations — each linked to its author, client, date and shift.</p></div>
      <div class="page-actions"><button class="btn ghost" id="csv">Export CSV</button><button class="btn ghost" id="print">Print</button>${ctx.can('care.document') ? '<button class="btn primary" id="add">+ Add entry</button>' : ''}</div></div>
    <section class="card">
      <form class="filters" id="filters">${fields([
    { name: 'from', label: 'From', type: 'date', value: from }, { name: 'to', label: 'To', type: 'date', value: to },
    { name: 'client_id', label: 'Client', type: 'select', options: opts(clients, 'legal_name'), value: query.client_id },
    { name: 'caregiver_id', label: 'Caregiver', type: 'select', options: opts(cgs, 'full_name'), value: query.caregiver_id },
    { name: 'types', label: 'Type', type: 'select', options: [['adl', 'ADLs'], ['meals', 'Meals & fluids'], ['activities', 'Activities'], ['observations', 'Observations']], value: query.types },
  ])}</form>
      ${undoc.length ? `<div class="notice warn"><strong>${undoc.length} completed shift(s) with incomplete documentation</strong>${undoc.slice(0, 8).map((s) => `${esc(s.date)} · ${esc(s.caregiver_name)} → ${esc(s.client_name)}${s.exception_note ? ` (${esc(s.exception_note)})` : ''}`).join('<br>')}</div><br>` : ''}
      ${logTable(rows, { showClient: true })}
    </section>`;
  el.querySelector('#filters').addEventListener('change', (e) => { location.hash = `#/care-logs${api.qs(readForm(e.currentTarget))}`; });
  el.querySelector('#print').addEventListener('click', () => window.print());
  el.querySelector('#csv').addEventListener('click', () => downloadCsv(`care-logs_${from}_${to}.csv`,
    ['Recorded at', 'Client', 'Type', 'Task/meal/activity', 'Status/amount', 'Notes', 'Author', 'Shift'],
    rows.map((r) => [r.recorded_at, r.client_name, r.type, r.task || r.meal || r.activity || r.mood || '', r.status || (r.percent_consumed != null ? `${r.percent_consumed}%` : '') || r.participation || '', r.notes || r.observation || '', r.author, r.shift_id || ''])));
  el.querySelector('#add')?.addEventListener('click', async () => {
    const choice = await modal({
      title: 'Add care documentation',
      body: `<form class="form">${fields([
        { name: 'client_id', label: 'Client', type: 'select', required: true, options: opts(clients.filter((c) => c.status !== 'discharged'), 'legal_name'), value: query.client_id },
        { name: 'kind', label: 'Entry type', type: 'select', required: true, options: [['adl', 'Activities of daily living'], ['meal', 'Meal / fluids'], ['activity', 'Activity'], ['observation', 'Condition / mood / behavior']] },
      ])}<div class="actions"><button class="btn primary" type="submit">Continue</button></div></form>`,
      onMount: (m, close) => m.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); const v = readForm(e.target); if (v.client_id && v.kind) close(v); }),
    });
    if (!choice) return;
    const args = { clientId: Number(choice.client_id), shiftId: null };
    let ok;
    if (choice.kind === 'adl') {
      const c = await api.get(`/clients/${args.clientId}`);
      ok = await adlDialog({ ...args, tasks: (c.care_plan?.adl_tasks || '').split('\n').map((t) => t.trim()).filter(Boolean) });
    } else ok = await ({ meal: mealDialog, activity: activityDialog, observation: observationDialog })[choice.kind](args);
    if (ok) render(el, parts, query, ctx);
  });
}
