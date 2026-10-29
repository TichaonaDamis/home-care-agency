/* CareHours – caregiver timesheets for a home care agency.
 * Runs entirely in the browser; data lives in localStorage. */
(() => {
  'use strict';

  const STORE_KEY = 'carehours:v1';
  const SESSION_KEY = 'carehours:session';
  const DEFAULT_TASKS = [
    'Personal care / bathing', 'Dressing & grooming', 'Meal preparation', 'Medication reminders',
    'Light housekeeping', 'Laundry', 'Mobility / transfers', 'Toileting / incontinence',
    'Companionship', 'Errands / transport',
  ];

  // ---------- storage ----------
  const blank = () => ({
    agency: 'CareHours',
    adminPin: '0000',
    tasks: DEFAULT_TASKS.slice(),
    caregivers: [],
    clients: [],
    entries: [],
    active: {},
  });

  let db = load();
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? Object.assign(blank(), JSON.parse(raw)) : blank();
    } catch { return blank(); }
  }
  function save() { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }

  let session = null;
  try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { /* none */ }
  function setSession(s) {
    session = s;
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  }

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const weekStart = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); };
  const fmtDate = (s) => parseYmd(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const fmtTime = (t) => { const [h, m] = t.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
  const h2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
  const money = (n) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });

  function entryHours(e) {
    const [sh, sm] = e.start.split(':').map(Number);
    const [eh, em] = e.end.split(':').map(Number);
    let mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins < 0) mins += 24 * 60; // overnight shift
    mins -= Number(e.breakMin) || 0;
    return Math.max(0, mins) / 60;
  }
  const cgById = (id) => db.caregivers.find((c) => c.id === id);
  const clById = (id) => db.clients.find((c) => c.id === id);
  const cgName = (id) => cgById(id)?.name ?? '(removed)';
  const clName = (id) => clById(id)?.name ?? '(removed)';
  const byDate = (a, b) => (b.date + b.start).localeCompare(a.date + a.start);

  function options(list, { all, placeholder } = {}) {
    let html = all ? `<option value="">${esc(all)}</option>` : '';
    if (placeholder) html += `<option value="" disabled selected>${esc(placeholder)}</option>`;
    return html + list.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  }
  const activeOnly = (list) => list.filter((x) => x.active !== false).sort((a, b) => a.name.localeCompare(b.name));

  function stat(label, value) { return `<div class="stat"><div class="v">${value}</div><div class="l">${esc(label)}</div></div>`; }

  // Weekly overtime: hours beyond 40 in a Mon–Sun week, per caregiver.
  function overtimeFor(entries) {
    const weeks = {};
    for (const e of entries) {
      const k = e.cgId + '|' + ymd(weekStart(parseYmd(e.date)));
      weeks[k] = (weeks[k] || 0) + entryHours(e);
    }
    const ot = {};
    for (const [k, h] of Object.entries(weeks)) {
      const cg = k.split('|')[0];
      ot[cg] = (ot[cg] || 0) + Math.max(0, h - 40);
    }
    return ot;
  }

  // ---------- routing ----------
  const NAV = {
    admin: [['reports', 'Reports'], ['people', 'Caregivers & Clients'], ['settings', 'Settings']],
    cg: [['log', 'My Hours']],
  };
  let currentView = null;

  function render() {
    $('agencyName').textContent = db.agency;
    document.title = `${db.agency} – Timesheets`;
    if (!session || (session.role === 'cg' && !cgById(session.id))) {
      setSession(null);
      show('login');
      return;
    }
    const items = NAV[session.role];
    const view = items.some(([v]) => v === currentView) ? currentView : items[0][0];
    $('nav').innerHTML = items.map(([v, label]) => `<button data-view="${v}" class="${v === view ? 'active' : ''}">${label}</button>`).join('');
    $('userLabel').textContent = session.role === 'admin' ? 'Administrator' : cgName(session.id);
    show(view);
  }

  function show(view) {
    currentView = view;
    document.querySelectorAll('.view').forEach((s) => s.classList.add('hidden'));
    $('view-' + view).classList.remove('hidden');
    const loggedIn = view !== 'login';
    $('nav').classList.toggle('hidden', !loggedIn);
    $('userBox').classList.toggle('hidden', !loggedIn);
    ({ login: renderLogin, log: renderLog, reports: renderReports, people: renderPeople, settings: renderSettings })[view]();
  }

  $('nav').addEventListener('click', (e) => {
    const v = e.target.dataset.view;
    if (v) { currentView = v; render(); }
  });
  $('logoutBtn').addEventListener('click', () => { setSession(null); currentView = null; render(); });

  // ---------- login ----------
  function renderLogin() {
    $('loginUser').innerHTML = '<option value="" disabled selected>Select…</option>' +
      activeOnly(db.caregivers).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('') +
      '<option value="__admin">Administrator</option>';
    $('loginPin').value = '';
    $('loginError').classList.add('hidden');
  }
  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const who = $('loginUser').value;
    const pin = $('loginPin').value.trim();
    if (who === '__admin' && pin === db.adminPin) { setSession({ role: 'admin' }); }
    else {
      const cg = cgById(who);
      if (!cg || cg.pin !== pin) {
        $('loginError').textContent = 'Incorrect name or PIN.';
        $('loginError').classList.remove('hidden');
        return;
      }
      setSession({ role: 'cg', id: cg.id });
    }
    currentView = null;
    render();
  });

  // ---------- caregiver: log ----------
  let weekOffset = 0;
  let timerHandle = null;

  function renderLog() {
    const clients = activeOnly(db.clients);
    $('clockClient').innerHTML = options(clients, { placeholder: clients.length ? 'Select client…' : 'No clients yet – ask the office' });
    $('entryClient').innerHTML = options(clients, { placeholder: 'Select client…' });
    $('taskChecks').innerHTML = db.tasks.map((t, i) =>
      `<label><input type="checkbox" value="${esc(t)}" id="task${i}"> ${esc(t)}</label>`).join('');
    resetEntryForm();
    renderClock();
    renderMyTimesheet();
  }

  function renderClock() {
    clearInterval(timerHandle);
    const act = db.active[session.id];
    $('clockIdle').classList.toggle('hidden', !!act);
    $('clockActive').classList.toggle('hidden', !act);
    if (!act) return;
    const since = new Date(act.start);
    $('activeClient').textContent = clName(act.clientId);
    $('activeSince').textContent = since.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const tick = () => {
      const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
      $('timer').textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
    };
    tick();
    timerHandle = setInterval(tick, 1000);
  }

  $('clockInBtn').addEventListener('click', () => {
    const clientId = $('clockClient').value;
    if (!clientId) { alert('Choose a client first.'); return; }
    db.active[session.id] = { clientId, start: new Date().toISOString() };
    save();
    renderClock();
  });

  $('clockOutBtn').addEventListener('click', () => {
    const act = db.active[session.id];
    if (!act) return;
    const start = new Date(act.start);
    const end = new Date();
    const entry = {
      id: uid(), cgId: session.id, clientId: act.clientId,
      date: ymd(start), start: hm(start), end: hm(end),
      breakMin: 0, miles: 0, tasks: [], notes: '', createdAt: end.toISOString(),
    };
    db.entries.push(entry);
    delete db.active[session.id];
    save();
    renderClock();
    renderMyTimesheet();
    editEntry(entry.id);
    $('entryFormTitle').textContent = 'Shift saved – add care details';
  });

  function resetEntryForm() {
    $('entryForm').reset();
    $('entryId').value = '';
    $('entryDate').value = ymd(new Date());
    $('entryBreak').value = 0;
    $('entryMiles').value = 0;
    $('entryHours').value = '';
    $('entryError').classList.add('hidden');
    $('entryCancel').classList.add('hidden');
    $('entryFormTitle').textContent = 'Log a visit';
  }

  function updateHoursPreview() {
    const e = { start: $('entryStart').value, end: $('entryEnd').value, breakMin: $('entryBreak').value };
    $('entryHours').value = e.start && e.end ? h2(entryHours(e)) : '';
  }
  ['entryStart', 'entryEnd', 'entryBreak'].forEach((id) => $(id).addEventListener('input', updateHoursPreview));

  function editEntry(id) {
    const e = db.entries.find((x) => x.id === id);
    if (!e) return;
    $('entryId').value = e.id;
    // Visit may belong to a client who has since been deactivated.
    if (![...$('entryClient').options].some((o) => o.value === e.clientId)) {
      $('entryClient').insertAdjacentHTML('beforeend', `<option value="${esc(e.clientId)}">${esc(clName(e.clientId))}</option>`);
    }
    $('entryClient').value = e.clientId;
    $('entryDate').value = e.date;
    $('entryStart').value = e.start;
    $('entryEnd').value = e.end;
    $('entryBreak').value = e.breakMin;
    $('entryMiles').value = e.miles;
    $('entryNotes').value = e.notes;
    document.querySelectorAll('#taskChecks input').forEach((cb) => { cb.checked = e.tasks.includes(cb.value); });
    updateHoursPreview();
    $('entryCancel').classList.remove('hidden');
    $('entryFormTitle').textContent = 'Edit visit';
    $('entryForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('entryCancel').addEventListener('click', resetEntryForm);

  $('entryForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const err = $('entryError');
    const data = {
      clientId: $('entryClient').value,
      date: $('entryDate').value,
      start: $('entryStart').value,
      end: $('entryEnd').value,
      breakMin: Number($('entryBreak').value) || 0,
      miles: Number($('entryMiles').value) || 0,
      tasks: [...document.querySelectorAll('#taskChecks input:checked')].map((c) => c.value),
      notes: $('entryNotes').value.trim(),
    };
    if (!data.clientId) { err.textContent = 'Choose a client.'; err.classList.remove('hidden'); return; }
    if (entryHours(data) <= 0) { err.textContent = 'Shift must be longer than the break (check start and end times).'; err.classList.remove('hidden'); return; }
    if (data.date > ymd(addDays(new Date(), 1))) { err.textContent = 'Date cannot be in the future.'; err.classList.remove('hidden'); return; }

    const id = $('entryId').value;
    if (id) {
      Object.assign(db.entries.find((x) => x.id === id), data, { updatedAt: new Date().toISOString() });
    } else {
      db.entries.push({ id: uid(), cgId: session.id, ...data, createdAt: new Date().toISOString() });
    }
    save();
    resetEntryForm();
    weekOffset = Math.round((weekStart(parseYmd(data.date)) - weekStart(new Date())) / 864e5 / 7);
    renderMyTimesheet();
  });

  document.querySelectorAll('[data-week]').forEach((b) => b.addEventListener('click', () => {
    weekOffset += Number(b.dataset.week);
    renderMyTimesheet();
  }));

  function entriesTable(rows, { showCaregiver, editable }) {
    if (!rows.length) return `<tr><td class="empty">No visits logged.</td></tr>`;
    const head = `<thead><tr><th>Date</th>${showCaregiver ? '<th>Caregiver</th>' : ''}<th>Client</th><th>Time</th>
      <th class="num">Break</th><th class="num">Hours</th><th class="num">Miles</th><th>Care / notes</th>${editable ? '<th class="noprint"></th>' : ''}</tr></thead>`;
    const body = rows.map((e) => `<tr>
      <td>${esc(fmtDate(e.date))}</td>
      ${showCaregiver ? `<td>${esc(cgName(e.cgId))}</td>` : ''}
      <td>${esc(clName(e.clientId))}</td>
      <td>${esc(fmtTime(e.start))} – ${esc(fmtTime(e.end))}</td>
      <td class="num">${e.breakMin ? e.breakMin + 'm' : '—'}</td>
      <td class="num">${h2(entryHours(e))}</td>
      <td class="num">${e.miles ? e.miles : '—'}</td>
      <td class="notes">${esc(e.tasks.join(', '))}${e.notes ? `<br><em>${esc(e.notes)}</em>` : ''}</td>
      ${editable ? `<td class="noprint" style="white-space:nowrap">
        <button class="btn link" data-edit="${e.id}">Edit</button>
        <button class="btn link danger-text" data-del="${e.id}">Delete</button></td>` : ''}
    </tr>`).join('');
    const total = rows.reduce((s, e) => s + entryHours(e), 0);
    const miles = rows.reduce((s, e) => s + (Number(e.miles) || 0), 0);
    const pre = showCaregiver ? 5 : 4;
    return `${head}<tbody>${body}</tbody><tfoot><tr><td colspan="${pre}">Total</td>
      <td class="num">${h2(total)}</td><td class="num">${miles ? h2(miles) : '—'}</td><td colspan="${editable ? 2 : 1}"></td></tr></tfoot>`;
  }

  function deleteEntry(id) {
    if (!confirm('Delete this visit? This cannot be undone.')) return false;
    db.entries = db.entries.filter((e) => e.id !== id);
    save();
    return true;
  }

  function renderMyTimesheet() {
    const ws = addDays(weekStart(new Date()), weekOffset * 7);
    const we = addDays(ws, 6);
    $('weekLabel').textContent = `${ws.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${we.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    const rows = db.entries
      .filter((e) => e.cgId === session.id && e.date >= ymd(ws) && e.date <= ymd(we))
      .sort(byDate);
    const total = rows.reduce((s, e) => s + entryHours(e), 0);
    const clients = new Set(rows.map((e) => e.clientId)).size;
    $('myStats').innerHTML = stat('Hours this week', h2(total)) + stat('Visits', rows.length) +
      stat('Clients seen', clients) + stat('Overtime', h2(Math.max(0, total - 40)));
    $('myTable').innerHTML = entriesTable(rows, { showCaregiver: false, editable: true });
  }

  $('myTable').addEventListener('click', (e) => {
    if (e.target.dataset.edit) editEntry(e.target.dataset.edit);
    if (e.target.dataset.del && deleteEntry(e.target.dataset.del)) renderMyTimesheet();
  });

  // ---------- admin: reports ----------
  function quickRange(kind) {
    const now = new Date();
    if (kind === 'thisWeek') { const s = weekStart(now); return [s, addDays(s, 6)]; }
    if (kind === 'lastWeek') { const s = addDays(weekStart(now), -7); return [s, addDays(s, 6)]; }
    if (kind === 'thisMonth') return [new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 0)];
    if (kind === 'lastMonth') return [new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 0)];
    return null;
  }

  function renderReports() {
    const keepCg = $('rCaregiver').value, keepCl = $('rClient').value;
    $('rCaregiver').innerHTML = options([...db.caregivers].sort((a, b) => a.name.localeCompare(b.name)), { all: 'All caregivers' });
    $('rClient').innerHTML = options([...db.clients].sort((a, b) => a.name.localeCompare(b.name)), { all: 'All clients' });
    $('rCaregiver').value = keepCg; $('rClient').value = keepCl;
    if (!$('rFrom').value) {
      const [s, e] = quickRange('thisMonth');
      $('rFrom').value = ymd(s); $('rTo').value = ymd(e);
      $('rQuick').value = 'thisMonth';
    }
    runReport();
  }

  function reportRows() {
    const from = $('rFrom').value, to = $('rTo').value, cg = $('rCaregiver').value, cl = $('rClient').value;
    return db.entries.filter((e) =>
      (!from || e.date >= from) && (!to || e.date <= to) && (!cg || e.cgId === cg) && (!cl || e.clientId === cl)
    ).sort(byDate);
  }

  function runReport() {
    const rows = reportRows();
    const total = rows.reduce((s, e) => s + entryHours(e), 0);
    const miles = rows.reduce((s, e) => s + (Number(e.miles) || 0), 0);
    const ot = overtimeFor(rows);
    const otTotal = Object.values(ot).reduce((a, b) => a + b, 0);

    // by caregiver
    const byCg = {};
    for (const e of rows) {
      const r = byCg[e.cgId] ||= { hours: 0, visits: 0, miles: 0 };
      r.hours += entryHours(e); r.visits++; r.miles += Number(e.miles) || 0;
    }
    let payTotal = 0;
    const cgRows = Object.entries(byCg).sort((a, b) => cgName(a[0]).localeCompare(cgName(b[0]))).map(([id, r]) => {
      const rate = Number(cgById(id)?.rate) || 0;
      const o = ot[id] || 0;
      const pay = r.hours * rate + o * rate * 0.5;
      payTotal += pay;
      return `<tr><td>${esc(cgName(id))}</td><td class="num">${r.visits}</td><td class="num">${h2(r.hours)}</td>
        <td class="num ${o ? 'ot' : ''}">${h2(o)}</td><td class="num">${h2(r.miles)}</td><td class="num">${money(pay)}</td></tr>`;
    }).join('');
    $('byCaregiver').innerHTML = cgRows
      ? `<thead><tr><th>Caregiver</th><th class="num">Visits</th><th class="num">Hours</th><th class="num">OT</th><th class="num">Miles</th><th class="num">Est. pay</th></tr></thead>
         <tbody>${cgRows}</tbody><tfoot><tr><td>Total</td><td class="num">${rows.length}</td><td class="num">${h2(total)}</td>
         <td class="num">${h2(otTotal)}</td><td class="num">${h2(miles)}</td><td class="num">${money(payTotal)}</td></tr></tfoot>`
      : '<tr><td class="empty">No data for this period.</td></tr>';

    // by client
    const byCl = {};
    for (const e of rows) {
      const r = byCl[e.clientId] ||= { hours: 0, visits: 0, cgs: new Set() };
      r.hours += entryHours(e); r.visits++; r.cgs.add(e.cgId);
    }
    const clRows = Object.entries(byCl).sort((a, b) => clName(a[0]).localeCompare(clName(b[0]))).map(([id, r]) =>
      `<tr><td>${esc(clName(id))}</td><td class="num">${r.visits}</td><td class="num">${r.cgs.size}</td><td class="num">${h2(r.hours)}</td></tr>`).join('');
    $('byClient').innerHTML = clRows
      ? `<thead><tr><th>Client</th><th class="num">Visits</th><th class="num">Caregivers</th><th class="num">Hours</th></tr></thead>
         <tbody>${clRows}</tbody><tfoot><tr><td>Total</td><td class="num">${rows.length}</td><td></td><td class="num">${h2(total)}</td></tr></tfoot>`
      : '<tr><td class="empty">No data for this period.</td></tr>';

    const onShift = Object.keys(db.active).filter(cgById).length;
    $('reportStats').innerHTML = stat('Total hours', h2(total)) + stat('Visits', rows.length) +
      stat('Overtime hours', h2(otTotal)) + stat('Mileage', h2(miles)) + stat('Est. payroll', money(payTotal)) +
      stat('On shift now', onShift);

    $('allVisits').innerHTML = entriesTable(rows, { showCaregiver: true, editable: true });
  }

  $('reportFilters').addEventListener('input', (e) => {
    if (e.target.id === 'rQuick') {
      const r = quickRange(e.target.value);
      if (r) { $('rFrom').value = ymd(r[0]); $('rTo').value = ymd(r[1]); }
    } else if (e.target.id === 'rFrom' || e.target.id === 'rTo') {
      $('rQuick').value = '';
    }
    runReport();
  });
  $('allVisits').addEventListener('click', (e) => {
    if (e.target.dataset.del && deleteEntry(e.target.dataset.del)) runReport();
    if (e.target.dataset.edit) adminEdit(e.target.dataset.edit);
  });

  function adminEdit(id) {
    const e = db.entries.find((x) => x.id === id);
    const start = prompt('Start time (HH:MM, 24h)', e.start); if (start === null) return;
    const end = prompt('End time (HH:MM, 24h)', e.end); if (end === null) return;
    const brk = prompt('Break (minutes)', e.breakMin); if (brk === null) return;
    const re = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!re.test(start) || !re.test(end)) { alert('Times must look like 08:30 or 17:45.'); return; }
    Object.assign(e, { start, end, breakMin: Number(brk) || 0, updatedAt: new Date().toISOString(), editedBy: 'admin' });
    save();
    runReport();
  }

  $('exportCsv').addEventListener('click', () => {
    const rows = reportRows();
    const head = ['Date', 'Caregiver', 'Client', 'Start', 'End', 'Break (min)', 'Hours', 'Miles', 'Tasks', 'Notes'];
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [head, ...rows.map((e) => [e.date, cgName(e.cgId), clName(e.clientId), e.start, e.end, e.breakMin,
      h2(entryHours(e)), e.miles, e.tasks.join('; '), e.notes])].map((r) => r.map(q).join(',')).join('\r\n');
    download(`timesheet_${$('rFrom').value || 'all'}_${$('rTo').value || 'all'}.csv`, csv, 'text/csv');
  });
  $('printReport').addEventListener('click', () => window.print());

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- admin: people ----------
  function renderPeople() {
    const cgs = [...db.caregivers].sort((a, b) => a.name.localeCompare(b.name));
    $('cgTable').innerHTML = cgs.length
      ? `<thead><tr><th>Name</th><th>PIN</th><th class="num">Rate</th><th>Status</th><th></th></tr></thead><tbody>` +
        cgs.map((c) => `<tr><td>${esc(c.name)}${db.active[c.id] ? ' <span class="ok">● on shift</span>' : ''}</td>
          <td>${esc(c.pin)}</td><td class="num">${money(Number(c.rate) || 0)}</td>
          <td>${c.active === false ? 'Inactive' : 'Active'}</td>
          <td style="white-space:nowrap"><button class="btn link" data-cg-edit="${c.id}">Edit</button>
          <button class="btn link" data-cg-toggle="${c.id}">${c.active === false ? 'Activate' : 'Deactivate'}</button></td></tr>`).join('') + '</tbody>'
      : '<tr><td class="empty">No caregivers yet.</td></tr>';
    const cls = [...db.clients].sort((a, b) => a.name.localeCompare(b.name));
    $('clTable').innerHTML = cls.length
      ? `<thead><tr><th>Name</th><th>Address</th><th>Status</th><th></th></tr></thead><tbody>` +
        cls.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.addr)}</td><td>${c.active === false ? 'Inactive' : 'Active'}</td>
          <td style="white-space:nowrap"><button class="btn link" data-cl-edit="${c.id}">Edit</button>
          <button class="btn link" data-cl-toggle="${c.id}">${c.active === false ? 'Activate' : 'Deactivate'}</button></td></tr>`).join('') + '</tbody>'
      : '<tr><td class="empty">No clients yet.</td></tr>';
  }

  $('cgForm').addEventListener('submit', (e) => {
    e.preventDefault();
    db.caregivers.push({ id: uid(), name: $('cgName').value.trim(), pin: $('cgPin').value.trim(), rate: Number($('cgRate').value) || 0, active: true });
    save(); e.target.reset(); $('cgRate').value = '18.00'; renderPeople();
  });
  $('clForm').addEventListener('submit', (e) => {
    e.preventDefault();
    db.clients.push({ id: uid(), name: $('clName').value.trim(), addr: $('clAddr').value.trim(), active: true });
    save(); e.target.reset(); renderPeople();
  });
  $('cgTable').addEventListener('click', (e) => {
    const t = e.target.dataset;
    if (t.cgToggle) { const c = cgById(t.cgToggle); c.active = c.active === false; save(); renderPeople(); }
    if (t.cgEdit) {
      const c = cgById(t.cgEdit);
      const name = prompt('Name', c.name); if (name === null) return;
      const pin = prompt('PIN (4–8 digits)', c.pin); if (pin === null) return;
      if (!/^\d{4,8}$/.test(pin)) { alert('PIN must be 4–8 digits.'); return; }
      const rate = prompt('Hourly rate', c.rate); if (rate === null) return;
      Object.assign(c, { name: name.trim() || c.name, pin, rate: Number(rate) || 0 });
      save(); renderPeople();
    }
  });
  $('clTable').addEventListener('click', (e) => {
    const t = e.target.dataset;
    if (t.clToggle) { const c = clById(t.clToggle); c.active = c.active === false; save(); renderPeople(); }
    if (t.clEdit) {
      const c = clById(t.clEdit);
      const name = prompt('Name', c.name); if (name === null) return;
      const addr = prompt('Address', c.addr); if (addr === null) return;
      Object.assign(c, { name: name.trim() || c.name, addr: addr.trim() });
      save(); renderPeople();
    }
  });

  // ---------- admin: settings ----------
  function renderSettings() {
    $('setAgency').value = db.agency;
    $('setAdminPin').value = db.adminPin;
    $('setTasks').value = db.tasks.join('\n');
    $('settingsMsg').classList.add('hidden');
  }
  $('agencyForm').addEventListener('submit', (e) => {
    e.preventDefault();
    db.agency = $('setAgency').value.trim() || 'CareHours';
    db.adminPin = $('setAdminPin').value.trim();
    db.tasks = $('setTasks').value.split('\n').map((s) => s.trim()).filter(Boolean);
    save();
    $('agencyName').textContent = db.agency;
    $('settingsMsg').classList.remove('hidden');
  });
  $('backupBtn').addEventListener('click', () =>
    download(`carehours-backup-${ymd(new Date())}.json`, JSON.stringify(db, null, 2), 'application/json'));
  $('restoreInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.entries) || !Array.isArray(data.caregivers)) throw new Error('bad file');
      if (!confirm('Replace ALL current data with this backup?')) return;
      db = Object.assign(blank(), data);
      save();
      alert('Backup restored.');
      render();
    } catch { alert('That file is not a valid CareHours backup.'); }
    e.target.value = '';
  });
  $('wipeBtn').addEventListener('click', () => {
    if (!confirm('Erase ALL caregivers, clients and timesheets on this device?')) return;
    if (prompt('Type ERASE to confirm') !== 'ERASE') return;
    db = blank(); save(); setSession(null); render();
  });
  $('demoBtn').addEventListener('click', () => {
    if (db.entries.length && !confirm('Add demo caregivers, clients and visits to your existing data?')) return;
    const cgs = [['Maria Lopez', '1111', 19], ['James Carter', '2222', 18], ['Aisha Bello', '3333', 20]]
      .map(([name, pin, rate]) => ({ id: uid(), name, pin, rate, active: true }));
    const cls = [['Dorothy Evans', '12 Maple St'], ['Harold Kim', '48 Oak Ave'], ['Ruth Thompson', '7 Pine Ct'], ['George Patel', '301 Elm Rd']]
      .map(([name, addr]) => ({ id: uid(), name, addr, active: true }));
    db.caregivers.push(...cgs); db.clients.push(...cls);
    const today = new Date();
    for (let d = 34; d >= 0; d--) {
      const day = addDays(today, -d);
      if (day.getDay() === 0) continue;
      cgs.forEach((cg, i) => {
        const cl = cls[(i + d) % cls.length];
        const startH = 7 + i * 2;
        const len = 4 + ((d + i) % 5);
        db.entries.push({
          id: uid(), cgId: cg.id, clientId: cl.id, date: ymd(day),
          start: `${pad(startH)}:00`, end: `${pad(startH + len)}:${(d % 2) ? '30' : '00'}`,
          breakMin: len >= 6 ? 30 : 0, miles: (3 + ((d * 7 + i) % 12)),
          tasks: db.tasks.filter((_, k) => (k + d + i) % 3 === 0).slice(0, 4),
          notes: d % 6 === 0 ? 'Client in good spirits; ate full lunch.' : '',
          createdAt: day.toISOString(),
        });
      });
    }
    save();
    alert('Demo data loaded. Caregiver PINs: Maria 1111, James 2222, Aisha 3333.');
    render();
  });

  // Keep multiple tabs in sync.
  window.addEventListener('storage', (e) => { if (e.key === STORE_KEY) { db = load(); render(); } });

  render();
})();
