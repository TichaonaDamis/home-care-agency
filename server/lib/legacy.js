'use strict';
// Import a CareHours v1 browser backup (Settings → "Download backup (JSON)" in the old app).
// PINs are intentionally NOT imported: v1 stored them in plain text. Create user accounts afterwards.
const { HttpError, addDays } = require('./util');

function importLegacy(db, settings, data, userId) {
  if (!data || !Array.isArray(data.caregivers) || !Array.isArray(data.clients) || !Array.isArray(data.entries)) {
    throw new HttpError(400, 'That file is not a CareHours v1 backup.');
  }
  const cgMap = new Map();
  const clMap = new Map();
  const result = { caregivers: 0, clients: 0, visits: 0, skipped: 0 };
  const earliest = data.entries.map((e) => e.date).filter(Boolean).sort()[0] || settings.today();

  for (const c of data.caregivers) {
    const code = `V1-${String(c.id).slice(0, 12)}`;
    const existing = db.get('SELECT id FROM caregivers WHERE code = ?', [code]);
    if (existing) { cgMap.set(c.id, existing.id); continue; }
    const id = db.insert('caregivers', {
      code, full_name: String(c.name || 'Unnamed').slice(0, 120),
      employment_status: c.active === false ? 'terminated' : 'active', mileage_rate_cents: 0,
    });
    db.insert('caregiver_pay_rates', { caregiver_id: id, rate_cents: Math.round((Number(c.rate) || 0) * 100), effective_from: earliest, created_by: userId });
    cgMap.set(c.id, id);
    result.caregivers++;
  }
  for (const c of data.clients) {
    const code = `V1-${String(c.id).slice(0, 12)}`;
    const existing = db.get('SELECT id FROM clients WHERE code = ?', [code]);
    if (existing) { clMap.set(c.id, existing.id); continue; }
    const id = db.insert('clients', {
      code, legal_name: String(c.name || 'Unnamed').slice(0, 120), address: c.addr ? String(c.addr).slice(0, 300) : null,
      status: c.active === false ? 'discharged' : 'active',
    });
    clMap.set(c.id, id);
    result.clients++;
  }
  const valid = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
  for (const e of data.entries) {
    const cg = cgMap.get(e.cgId);
    const cl = clMap.get(e.clientId);
    if (!cg || !cl || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || !valid(e.start) || !valid(e.end)) { result.skipped++; continue; }
    const tag = `v1:${e.id}`;
    if (db.get('SELECT id FROM shifts WHERE notes LIKE ?', [`%[${tag}]%`])) { result.skipped++; continue; }
    const endDate = e.end <= e.start ? addDays(e.date, 1) : e.date;
    const rate = db.get('SELECT rate_cents FROM caregiver_pay_rates WHERE caregiver_id = ? ORDER BY effective_from LIMIT 1', [cg]);
    const shiftId = db.insert('shifts', {
      caregiver_id: cg, client_id: cl, date: e.date, sched_start: e.start, sched_end: e.end, status: 'completed',
      actual_start: `${e.date}T${e.start}`, actual_end: `${endDate}T${e.end}`, break_min: Math.max(0, Number(e.breakMin) || 0),
      mileage: Math.max(0, Number(e.miles) || 0), pay_rate_cents: rate?.rate_cents ?? null, mileage_rate_cents: 0,
      notes: `${e.notes ? String(e.notes).slice(0, 2000) + ' ' : ''}[${tag}]`, doc_complete: 1, source: 'legacy_import',
    });
    for (const task of Array.isArray(e.tasks) ? e.tasks : []) {
      db.insert('adl_logs', { client_id: cl, shift_id: shiftId, author_id: userId, recorded_at: `${e.date}T${e.start}`, task: String(task).slice(0, 120), status: 'completed', notes: 'Imported from CareHours v1' });
    }
    result.visits++;
  }
  return result;
}

module.exports = { importLegacy };
