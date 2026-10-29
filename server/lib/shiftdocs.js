'use strict';
// Shift rules: conflict detection, weekly overtime projection and the documentation checklist.
const { addDays, weekStart, shiftInterval, overlaps, schedHours, minutesBetween } = require('./util');

/** Other non-cancelled shifts for the caregiver that overlap the given time window. */
function shiftConflicts(db, caregiverId, date, start, end, excludeId = null) {
  if (!caregiverId) return [];
  const mine = shiftInterval(date, start, end);
  return db.all(`SELECT s.id, s.date, s.sched_start, s.sched_end, c.legal_name AS client_name FROM shifts s JOIN clients c ON c.id = s.client_id
      WHERE s.caregiver_id = ? AND s.date BETWEEN ? AND ? AND s.status NOT IN ('cancelled','missed') AND s.id IS NOT ?`,
  [caregiverId, addDays(date, -1), addDays(date, 1), excludeId])
    .filter((s) => overlaps(mine, shiftInterval(s.date, s.sched_start, s.sched_end)));
}

/** Scheduled hours in the Mon–Sun week of `date` for a caregiver (excluding one shift). */
function weekScheduledHours(db, caregiverId, date, excludeId = null) {
  const ws = weekStart(date);
  return db.all(`SELECT sched_start, sched_end FROM shifts WHERE caregiver_id = ? AND date BETWEEN ? AND ? AND status NOT IN ('cancelled','missed') AND id IS NOT ?`,
    [caregiverId, ws, addDays(ws, 6), excludeId]).reduce((h, s) => h + schedHours(s), 0);
}

/**
 * Warnings that block scheduling unless an authorized user documents an override reason.
 * Returns [{ code, message }].
 */
function scheduleWarnings(db, settings, { caregiverId, clientId, date, start, end, excludeId = null }) {
  const w = [];
  for (const c of shiftConflicts(db, caregiverId, date, start, end, excludeId)) {
    w.push({ code: 'conflict', message: `Overlaps shift #${c.id} with ${c.client_name} on ${c.date} ${c.sched_start}–${c.sched_end}` });
  }
  if (caregiverId) {
    const cg = db.get('SELECT full_name, overtime_rule, employment_status FROM caregivers WHERE id = ?', [caregiverId]);
    if (cg.employment_status !== 'active') w.push({ code: 'inactive_caregiver', message: `${cg.full_name} is ${cg.employment_status.replace('_', ' ')}` });
    const limit = settings.get('weekly_ot_threshold');
    const total = weekScheduledHours(db, caregiverId, date, excludeId) + schedHours({ sched_start: start, sched_end: end });
    if (cg.overtime_rule !== 'none' && total > limit) {
      w.push({ code: 'overtime', message: `${cg.full_name} would be scheduled ${Math.round(total * 10) / 10} h in the week of ${weekStart(date)} (over ${limit} h — unapproved overtime)` });
    }
    const expired = db.all('SELECT name FROM credentials WHERE caregiver_id = ? AND required = 1 AND expires_on IS NOT NULL AND expires_on < ?', [caregiverId, date]);
    for (const e of expired) w.push({ code: 'credential', message: `${cg.full_name}'s ${e.name} is expired on ${date}` });
  }
  const cl = db.get('SELECT legal_name, status FROM clients WHERE id = ?', [clientId]);
  if (cl && cl.status !== 'active') w.push({ code: 'client_status', message: `${cl.legal_name} is currently ${cl.status.replace('_', ' ')}` });
  return w;
}

/** Scheduled-dose datetimes for a medication falling within [from, to] (local datetimes). */
function dosesInWindow(med, from, to) {
  if (med.prn || !med.times) return [];
  const out = [];
  for (let d = from.slice(0, 10); d <= to.slice(0, 10); d = addDays(d, 1)) {
    for (const t of med.times.split(',').map((x) => x.trim()).filter((x) => /^\d\d:\d\d$/.test(x))) {
      const dt = `${d}T${t}`;
      if (dt >= from && dt <= to && (!med.start_date || d >= med.start_date) && (!med.stop_date || d <= med.stop_date)) out.push(dt);
    }
  }
  return out;
}

/**
 * Outstanding documentation for a shift. Meals and activities are optional; required items are
 * care-plan ADL tasks, scheduled medication doses (for caregivers with medication authority),
 * and at least one general-condition observation.
 */
function outstandingDocs(db, shift, nowLocal) {
  const out = [];
  const plan = db.get(`SELECT adl_tasks FROM care_plans WHERE client_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1`, [shift.client_id]);
  const tasks = (plan?.adl_tasks || '').split('\n').map((t) => t.trim()).filter(Boolean);
  const logged = new Set(db.all('SELECT task FROM adl_logs WHERE shift_id = ?', [shift.id]).map((r) => r.task.toLowerCase()));
  for (const t of tasks) if (!logged.has(t.toLowerCase())) out.push({ kind: 'adl', item: t, text: `Care task not documented: ${t}` });

  const cg = shift.caregiver_id ? db.get('SELECT med_authority FROM caregivers WHERE id = ?', [shift.caregiver_id]) : null;
  if (cg && cg.med_authority !== 'none') {
    const from = shift.actual_start || `${shift.date}T${shift.sched_start}`;
    const to = shift.actual_end || nowLocal;
    const done = new Set(db.all('SELECT medication_id, scheduled_for FROM med_events WHERE shift_id = ?', [shift.id]).map((e) => `${e.medication_id}|${e.scheduled_for}`));
    for (const m of db.all(`SELECT * FROM medications WHERE client_id = ? AND status = 'active'`, [shift.client_id])) {
      for (const dt of dosesInWindow(m, from, to)) {
        if (!done.has(`${m.id}|${dt}`)) out.push({ kind: 'medication', medication_id: m.id, scheduled_for: dt, text: `Scheduled dose not documented: ${m.name} at ${dt.slice(11)}` });
      }
    }
  }
  if (!db.get('SELECT 1 FROM observations WHERE shift_id = ?', [shift.id])) out.push({ kind: 'observation', text: 'General condition / observation not recorded' });
  return out;
}

/** Minutes between scheduled start and now (negative = early). */
function clockInOffset(shift, nowLocal) {
  return minutesBetween(`${shift.date}T${shift.sched_start}`, nowLocal);
}

module.exports = { shiftConflicts, scheduleWarnings, weekScheduledHours, outstandingDocs, dosesInWindow, clockInOffset };
