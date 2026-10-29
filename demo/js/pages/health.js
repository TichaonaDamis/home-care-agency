import { api } from '../api.js';
import { esc, table, badge, fields, readForm, opts, fmtDT, addDays, num, lineChart, empty, modal } from '../ui.js';
import { measurementDialog } from './shared.js';

export async function render(el, parts, query, ctx) {
  const to = query.to || ctx.today();
  const range = query.range || '30';
  const from = query.from || addDays(to, -(Number(range) - 1));
  const [clients, types, overdue] = await Promise.all([api.get('/clients', { status: 'active' }), api.get('/measurement-types'), api.get('/health/overdue')]);
  const clientId = query.client_id || '';
  const typeCode = query.type_code || '';
  const rows = await api.get('/measurements', { client_id: clientId, type_code: typeCode, from, to });
  const summary = clientId ? await api.get(`/clients/${clientId}/health-summary`) : null;
  el.innerHTML = `
    <div class="page-head"><div><h1>Health Monitoring</h1><p>Vital signs and other authorized measurements, with trends and overdue checks.</p></div>
      <div class="page-actions">${ctx.can('health.record') ? '<button class="btn primary" id="rec">+ Record measurements</button>' : ''}</div></div>
    <div class="notice"><strong>Documentation and monitoring aid</strong>CareHours does not diagnose. Alert thresholds come from clinician orders or facility policy, and a single reading does not establish health status. Follow approved escalation instructions; in an emergency call 911.</div>
    <section class="card"><form class="filters" id="filters">${fields([
    { name: 'client_id', label: 'Client', type: 'select', options: opts(clients, 'legal_name'), value: clientId },
    { name: 'type_code', label: 'Measurement', type: 'select', options: types.map((t) => [t.code, t.name]), value: typeCode },
    { name: 'range', label: 'Period', type: 'select', required: true, options: [['7', 'Daily (7 days)'], ['30', 'Weekly (30 days)'], ['90', 'Monthly (90 days)'], ['365', '12 months']], value: range },
    { name: 'to', label: 'Ending', type: 'date', value: to },
  ])}</form></section>
    ${summary ? `<section class="card"><h2>Latest values</h2><div class="stats">${summary.filter((s) => s.latest).map((s) => `<div class="stat ${s.out_of_range?.length ? 'danger' : ''}">
      <div class="v">${s.latest.value2 != null ? `${num(s.latest.value, 0)}/${num(s.latest.value2, 0)}` : num(s.latest.value, s.latest.value % 1 ? 1 : 0)}</div>
      <div class="l">${esc(s.name)} (${esc(s.unit)})</div><div class="s">${esc(fmtDT(s.latest.measured_at))}${s.change != null ? ` · ${s.change > 0 ? '+' : ''}${num(s.change, 1)} vs prev` : ''}</div></div>`).join('') || empty('No measurements recorded for this client.')}</div>
      <p class="hint"><a href="#/clients/${clientId}?tab=health">Full health record and thresholds →</a></p></section>` : ''}
    <div class="grid two" id="charts"></div>
    <div class="grid two">
      <section class="card"><h2>Overdue or missing measurements</h2>${table([
    { label: 'Client', render: (o) => `<a href="#/clients/${o.client_id}?tab=health">${esc(o.client_name)}</a>` },
    { label: 'Measurement', render: (o) => esc(o.type) },
    { label: 'Last recorded', render: (o) => (o.last ? `${fmtDT(o.last)} (${o.days_since} d ago)` : badge('high', 'Never')) },
    { label: 'Expected', render: (o) => `every ${o.expected_every_days} d` },
  ], overdue, { empty: 'No scheduled measurements are overdue. ✓' })}</section>
      <section class="card"><h2>Measurements (${esc(from)} → ${esc(to)})</h2>${table([
    { label: 'When', render: (m) => fmtDT(m.measured_at) }, { label: 'Client', render: (m) => esc(m.client_name) },
    { label: 'Type', render: (m) => esc(m.type_name) }, { label: 'Value', render: (m) => `${m.value2 != null ? `${m.value}/${m.value2}` : m.value} ${esc(m.unit)}` },
    { label: 'Notes', cls: 'wrap', render: (m) => esc([m.method, m.symptoms, m.follow_up].filter(Boolean).join(' · ')) },
    { label: 'By', render: (m) => esc(m.recorded_by_name) },
  ], rows.slice(0, 300), { empty: 'No measurements in this period.' })}</section>
    </div>`;
  // Charts: one per client×type when a client is selected, otherwise one per type across clients (series per client).
  const groups = {};
  for (const m of rows) (groups[m.type_code] ||= []).push(m);
  el.querySelector('#charts').innerHTML = Object.entries(groups).map(([code, ms]) => {
    const t = types.find((x) => x.code === code) || { name: ms[0].type_name, unit: ms[0].unit };
    const byClient = {};
    for (const m of ms) (byClient[m.client_name] ||= []).push(m);
    const series = Object.entries(byClient).slice(0, 6).flatMap(([name, list]) => {
      const s = [{ name: clientId ? (t.has_second_value ? 'Systolic' : t.name) : name, points: list.map((m) => ({ x: m.measured_at, y: m.value })) }];
      if (clientId && t.has_second_value) s.push({ name: 'Diastolic', points: list.map((m) => ({ x: m.measured_at, y: m.value2 })) });
      return s;
    });
    const th = summary?.find((s) => s.code === code)?.thresholds;
    const lines = th ? [th.high != null && { value: th.high, label: `high ${th.high}` }, th.low != null && { value: th.low, label: `low ${th.low}` }].filter(Boolean) : [];
    return `<section class="card"><h3>${esc(t.name)} (${esc(t.unit)})</h3>${lineChart(series, { thresholds: lines })}</section>`;
  }).join('');
  el.querySelector('#filters').addEventListener('change', (e) => { location.hash = `#/health${api.qs(readForm(e.currentTarget))}`; });
  el.querySelector('#rec')?.addEventListener('click', async () => {
    let cid = clientId;
    if (!cid) {
      cid = await modal({
        title: 'Choose client',
        body: `<form class="form">${fields([{ name: 'client_id', label: 'Client', type: 'select', required: true, options: opts(clients, 'legal_name') }])}<div class="actions"><button class="btn primary" type="submit">Continue</button></div></form>`,
        onMount: (m, close) => m.querySelector('form').addEventListener('submit', (ev) => { ev.preventDefault(); close(readForm(ev.target).client_id); }),
      });
    }
    if (cid && await measurementDialog({ clientId: Number(cid), types })) render(el, parts, query, ctx);
  });
}
