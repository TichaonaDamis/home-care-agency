'use strict';
// Settings cache, audit logging, client access scoping and effective-rate lookup.
const { HttpError, todayLocal, parseJson } = require('./util');
const { can, isStaff } = require('./auth');

// ---------- settings ----------
function createSettings(db) {
  let cache = null;
  const load = () => {
    cache = Object.fromEntries(db.all('SELECT key, value FROM settings').map((r) => [r.key, parseJson(r.value, r.value)]));
  };
  return {
    get(key) { if (!cache) load(); return cache[key]; },
    all() { if (!cache) load(); return { ...cache }; },
    set(key, value) {
      db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
      cache = null;
    },
    today() { return todayLocal(this.get('timezone')); },
  };
}

// ---------- audit ----------
// Values are recorded only for financial / time fields; for clinical records we log field names,
// keeping PHI out of the audit trail while still showing who changed what and when.
const VALUE_FIELDS = new Set([
  'rate_cents', 'pay_rate_cents', 'bill_rate_cents', 'mileage_rate_cents', 'amount_cents', 'total_cents',
  'actual_start', 'actual_end', 'break_min', 'mileage', 'sched_start', 'sched_end', 'date', 'status',
  'approval_status', 'effective_from', 'effective_to', 'bill_method', 'role', 'active', 'caregiver_id', 'client_id',
  'start_date', 'end_date', 'override_reason', 'employment_status', 'overtime_rule', 'ot_multiplier',
]);

function audit(db, req, action, entity, entityId = null, { clientId = null, before = null, after = null, note = null } = {}) {
  let details = null;
  if (after || note) {
    const d = {};
    if (after) {
      const changed = Object.keys(after).filter((k) => !before || before[k] !== after[k]);
      d.fields = changed;
      const vals = {};
      for (const k of changed) if (VALUE_FIELDS.has(k)) vals[k] = before ? [before[k] ?? null, after[k] ?? null] : after[k];
      if (Object.keys(vals).length) d.values = vals;
    }
    if (note) d.note = note;
    details = JSON.stringify(d);
  }
  db.run('INSERT INTO audit_log (user_id, username, action, entity, entity_id, client_id, details, ip) VALUES (?,?,?,?,?,?,?,?)',
    [req?.user?.id ?? null, req?.user?.username ?? null, action, entity, entityId, clientId, details, req?.ip ?? null]);
}

// ---------- access scoping ----------
/** Client ids a caregiver may currently access: active assignment covering today, or a shift today. */
function caregiverClientIds(db, caregiverId, today) {
  const rows = db.all(`
    SELECT client_id FROM assignments
     WHERE caregiver_id = ? AND status = 'active' AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)
    UNION
    SELECT client_id FROM shifts
     WHERE caregiver_id = ? AND (date = ? OR status = 'in_progress') AND status <> 'cancelled'`,
  [caregiverId, today, today, caregiverId, today]);
  return new Set(rows.map((r) => r.client_id));
}

function assertClientAccess(db, settings, req, clientId) {
  const client = db.get('SELECT id FROM clients WHERE id = ?', [clientId]);
  if (!client) throw new HttpError(404, 'Client not found.');
  if (isStaff(req.user) && can(req.user, 'clients.view')) return;
  if (req.user.role === 'caregiver' && caregiverClientIds(db, req.user.caregiver_id, settings.today()).has(clientId)) return;
  throw new HttpError(403, 'You are not assigned to this client.');
}

/** For care documentation: caregivers must link to their own shift for the client. */
function assertShiftForCaregiver(db, req, shiftId, clientId) {
  if (req.user.role !== 'caregiver') return;
  if (!shiftId) throw new HttpError(400, 'Documentation must be linked to your shift.');
  const s = db.get('SELECT caregiver_id, client_id, status FROM shifts WHERE id = ?', [shiftId]);
  if (!s || s.caregiver_id !== req.user.caregiver_id || s.client_id !== clientId) throw new HttpError(403, 'That shift is not yours.');
  if (!['in_progress', 'completed'].includes(s.status)) throw new HttpError(400, 'Start the shift before documenting care.');
}

// ---------- effective rates ----------
function payRateFor(db, caregiverId, date) {
  const r = db.get(`SELECT rate_cents FROM caregiver_pay_rates WHERE caregiver_id = ? AND effective_from <= ?
    AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from DESC LIMIT 1`, [caregiverId, date, date]);
  return r ? r.rate_cents : null;
}
function billingFor(db, clientId, serviceTypeId, date) {
  if (!serviceTypeId) return null;
  return db.get(`SELECT bill_rate_cents, bill_method FROM client_services WHERE client_id = ? AND service_type_id = ?
    AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from DESC LIMIT 1`,
  [clientId, serviceTypeId, date, date]) || null;
}

/** Snapshot the rates in effect for a shift's date (assignment overrides win). Approved shifts are never re-rated. */
function rateSnapshot(db, shift) {
  const asg = shift.assignment_id ? db.get('SELECT pay_rate_cents, bill_rate_cents FROM assignments WHERE id = ?', [shift.assignment_id]) : null;
  const bill = billingFor(db, shift.client_id, shift.service_type_id, shift.date);
  const cg = shift.caregiver_id ? db.get('SELECT mileage_rate_cents FROM caregivers WHERE id = ?', [shift.caregiver_id]) : null;
  return {
    pay_rate_cents: asg?.pay_rate_cents ?? (shift.caregiver_id ? payRateFor(db, shift.caregiver_id, shift.date) : null),
    bill_rate_cents: asg?.bill_rate_cents ?? bill?.bill_rate_cents ?? null,
    bill_method: bill?.bill_method ?? (asg?.bill_rate_cents != null ? 'hourly' : null),
    mileage_rate_cents: cg?.mileage_rate_cents ?? null,
  };
}

/** Insert a new versioned rate, closing the previous open-ended row. History before `from` is untouched. */
function addVersionedRate(db, { table, whereSql, whereParams, from, row }) {
  const latest = db.get(`SELECT id, effective_from FROM ${table} WHERE ${whereSql} ORDER BY effective_from DESC LIMIT 1`, whereParams);
  if (latest && from <= latest.effective_from) {
    throw new HttpError(400, `New rate must start after ${latest.effective_from}. Past rates cannot be rewritten.`);
  }
  if (latest) {
    const { addDays } = require('./util');
    db.run(`UPDATE ${table} SET effective_to = ? WHERE id = ? AND (effective_to IS NULL OR effective_to >= ?)`, [addDays(from, -1), latest.id, from]);
  }
  return db.insert(table, { ...row, effective_from: from });
}

module.exports = {
  createSettings, audit, caregiverClientIds, assertClientAccess, assertShiftForCaregiver,
  payRateFor, billingFor, rateSnapshot, addVersionedRate,
};
