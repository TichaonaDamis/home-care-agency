'use strict';
// End-to-end acceptance scenarios from the project specification (section 20), exercised over HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, nowUtc, plusMinutes } = require('./helpers');

test('acceptance scenarios', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  s.makeUser('admin', 'admin');
  s.makeUser('nurse', 'nurse');
  const admin = await s.login('admin');
  const nurse = await s.login('nurse');
  const today = s.ctx.settings.today();
  const lk = (await admin.get('/settings')).body;
  const svc = Object.fromEntries(lk.service_types.map((x) => [x.code, x.id]));
  const cat = Object.fromEntries(lk.categories.map((x) => [x.name, x.id]));
  const ids = {};

  await t.test('1. register a client with care needs, contacts, services and an individualized care plan', async () => {
    const r = await admin.post('/clients', {
      legal_name: 'Alice Test', preferred_name: 'Ali', dob: '1940-02-03', status: 'active', admission_date: today, allergies: 'Penicillin',
      category_ids: [cat['Adult Family Home resident'], cat['Dementia / cognitive support']],
    });
    assert.equal(r.status, 201);
    assert.match(r.body.code, /^CL-\d{4}$/);
    ids.alice = r.body.id;
    assert.equal((await admin.post(`/clients/${ids.alice}/contacts`, { kind: 'emergency', name: 'Bob Test', phone: '555-1000' })).status, 201);
    assert.equal((await admin.post(`/clients/${ids.alice}/contacts`, { kind: 'representative', name: 'Rep Test', is_decision_maker: true })).status, 201);
    assert.equal((await admin.post(`/clients/${ids.alice}/services`, { service_type_id: svc.HYG, effective_from: '2020-01-01', bill_method: 'hourly', bill_rate: 30, frequency: 'Daily' })).status, 201);
    const plan = await nurse.post(`/clients/${ids.alice}/care-plans`, { effective_date: today, summary: 'Needs help with ADLs', instructions: 'Use gait belt', adl_tasks: 'Bathing\nDressing', requires_ack: true });
    assert.equal(plan.status, 201);
    const plan2 = await nurse.post(`/clients/${ids.alice}/care-plans`, { effective_date: today, summary: 'Updated', adl_tasks: 'Bathing\nDressing', requires_ack: true });
    const versions = (await admin.get(`/clients/${ids.alice}/care-plans`)).body;
    assert.deepEqual(versions.map((v) => [v.version, v.status]), [[2, 'active'], [1, 'superseded']], 'previous version retained');
    ids.plan = plan2.body.id;
    const c = (await admin.get(`/clients/${ids.alice}`)).body;
    assert.equal(c.contacts.length, 2);
    assert.equal(c.category_ids.length, 2);
    assert.equal(c.care_plan.version, 2);

    const r2 = await admin.post('/clients', { legal_name: 'Ben Second' });
    ids.ben = r2.body.id;
    await admin.post(`/clients/${ids.ben}/services`, { service_type_id: svc.COMP, effective_from: '2020-01-01', bill_method: 'per_visit', bill_rate: 80 });
  });

  await t.test('2. register a caregiver with an hourly rate and assign to multiple clients in the same month', async () => {
    const r = await admin.post('/caregivers', { full_name: 'Carla Care', pay_rate: 20, rate_effective_from: '2020-01-01', med_authority: 'assist', mileage_rate: 0.5 });
    assert.equal(r.status, 201);
    ids.carla = r.body.id;
    s.makeUser('carla', 'caregiver', ids.carla);
    const a1 = await admin.post('/assignments', { caregiver_id: ids.carla, client_id: ids.alice, service_type_id: svc.HYG, start_date: today, days_of_week: [0, 1, 2, 3, 4, 5, 6], shift_start: '06:00', shift_end: '07:00' });
    const a2 = await admin.post('/assignments', { caregiver_id: ids.carla, client_id: ids.ben, service_type_id: svc.COMP, start_date: today, days_of_week: [0, 1, 2, 3, 4, 5, 6], shift_start: '07:30', shift_end: '08:30' });
    assert.equal(a1.status, 201);
    assert.equal(a2.status, 201);
    for (const a of [a1, a2]) assert.equal((await admin.post(`/assignments/${a.body.id}/approve`)).status, 200);
    const gen = await admin.post(`/assignments/${a1.body.id}/generate`, { from: today, to: today });
    assert.equal(gen.body.created, 1);

    // Conflicting assignment is blocked until an override reason is documented.
    const clash = { caregiver_id: ids.carla, client_id: ids.ben, start_date: today, days_of_week: [0, 1, 2, 3, 4, 5, 6], shift_start: '06:30', shift_end: '07:15' };
    const blocked = await admin.post('/assignments', clash);
    assert.equal(blocked.status, 409);
    assert.ok(blocked.body.details.warnings.some((w) => w.code === 'conflict'));
    const forced = await admin.post('/assignments', { ...clash, override_reason: 'Two-person assist needed this week' });
    assert.equal(forced.status, 201);
    await admin.patch(`/assignments/${forced.body.id}`, { status: 'cancelled' });
    assert.ok(s.db.get(`SELECT details FROM audit_log WHERE entity = 'assignment' AND entity_id = ?`, [forced.body.id]).details.includes('Two-person assist'));
    const cg = (await admin.get(`/caregivers/${ids.carla}`)).body;
    assert.equal(new Set(cg.assignments.filter((a) => a.status === 'active').map((a) => a.client_id)).size, 2);
  });

  await t.test('4. caregiver sees only authorized clients and information', async () => {
    const other = (await admin.post('/clients', { legal_name: 'Unassigned Person' })).body.id;
    const carla = await s.login('carla');
    const list = (await carla.get('/clients')).body.map((c) => c.id).sort();
    assert.deepEqual(list, [ids.alice, ids.ben].sort());
    assert.equal((await carla.get(`/clients/${other}`)).status, 403);
    const shifts = (await carla.get('/shifts', { from: today, to: today })).body;
    assert.ok(shifts.every((x) => x.caregiver_id === ids.carla));
    assert.ok(shifts.every((x) => x.bill_rate_cents === undefined), 'billing rates hidden from caregivers');
  });

  await t.test('5. caregiver records a visit with hours, meals, activities, care, medication and observations', async () => {
    const now = nowUtc();
    const med = (await nurse.post(`/clients/${ids.alice}/medications`, { name: 'Testamol', strength: '10 mg', dose: '1 tab', route: 'oral', times: now.time, start_date: '2020-01-01', verified: true })).body.id;
    ids.med = med;
    const shift = await admin.post('/shifts', { caregiver_id: ids.carla, client_id: ids.alice, service_type_id: svc.HYG, date: now.date, sched_start: now.time, sched_end: plusMinutes(now.time, 120), override_reason: 'test shift' });
    assert.equal(shift.status, 201);
    ids.shift = shift.body.id;
    const carla = await s.login('carla');

    const needAck = await carla.post(`/shifts/${ids.shift}/start`);
    assert.equal(needAck.status, 409);
    assert.equal(needAck.body.details.code, 'ACK_REQUIRED');
    assert.equal((await carla.post(`/care-plans/${ids.plan}/ack`)).status, 200);
    const started = await carla.post(`/shifts/${ids.shift}/start`);
    assert.equal(started.status, 200, JSON.stringify(started.body));

    // Ending without documentation lists what is outstanding.
    const early = await carla.post(`/shifts/${ids.shift}/end`, {});
    assert.equal(early.status, 409);
    const kinds = early.body.details.outstanding.map((o) => o.kind).sort();
    assert.deepEqual([...new Set(kinds)], ['adl', 'medication', 'observation']);

    const base = { client_id: ids.alice, shift_id: ids.shift };
    assert.equal((await carla.post('/care/adl', { ...base, items: [{ task: 'Bathing', status: 'completed' }, { task: 'Dressing', status: 'declined', notes: 'Prefers later' }] })).status, 201);
    assert.equal((await carla.post('/care/adl', { ...base, items: [{ task: 'Oral care', status: 'declined' }] })).status, 400, 'declined needs a note');
    assert.equal((await carla.post('/care/meals', { ...base, meal: 'breakfast', percent_consumed: 75, fluid_ml: 240 })).status, 201);
    assert.equal((await carla.post('/care/meals', { ...base, meal: 'fluids_only' })).status, 201, 'optional fields are optional');
    assert.equal((await carla.post('/care/activities', { ...base, activity: 'Walk', minutes: 15, participation: 'active' })).status, 201);
    assert.equal((await carla.post('/care/observations', { ...base, mood: 'calm', alertness: 'alert_oriented', pain_score: 2 })).status, 201);
    const notAllowed = await carla.post('/med-events', { medication_id: med, shift_id: ids.shift, scheduled_for: `${now.date}T${now.time}`, action: 'administered' });
    assert.equal(notAllowed.status, 403, 'assist-only caregiver cannot record administration');
    assert.equal((await carla.post('/med-events', { medication_id: med, shift_id: ids.shift, scheduled_for: `${now.date}T${now.time}`, action: 'assisted' })).status, 201);
    const vit = await carla.post('/measurements', { ...base, items: [{ type_code: 'bp', value: 128, value2: 82 }] });
    assert.equal(vit.status, 201);
    const gl = await carla.post('/measurements', { ...base, items: [{ type_code: 'glucose', value: 110 }] });
    assert.equal(gl.status, 403, 'glucose restricted to clinical staff by default');

    const end = await carla.post(`/shifts/${ids.shift}/end`, { break_min: 0, mileage: 4, notes: 'Good visit' });
    assert.equal(end.status, 200, JSON.stringify(end.body));
    assert.equal(end.body.doc_complete, true);
    const sh = (await admin.get(`/shifts/${ids.shift}`)).body;
    assert.equal(sh.status, 'completed');
    assert.equal(sh.pay_rate_cents, 2000);
    assert.equal(sh.bill_rate_cents, 3000);
    assert.equal(sh.docs.adl.length, 2);

    // Supervisor corrects the time record to a 4h visit; a reason is mandatory and logged.
    const noReason = await admin.patch(`/shifts/${ids.shift}`, { actual_start: `${now.date}T06:00`, actual_end: `${now.date}T10:00` });
    assert.equal(noReason.status, 400);
    const fixed = await admin.patch(`/shifts/${ids.shift}`, { actual_start: `${now.date}T06:00`, actual_end: `${now.date}T10:00`, reason: 'Clock-in was late; verified with client family' });
    assert.equal(fixed.status, 200);
    const log = s.db.get(`SELECT details FROM audit_log WHERE entity = 'shift' AND entity_id = ? AND action = 'update' ORDER BY id DESC`, [ids.shift]);
    assert.match(log.details, /actual_start/);
  });

  await t.test('3. client and caregiver rate changes do not rewrite history', async () => {
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
    assert.equal((await admin.post(`/caregivers/${ids.carla}/pay-rates`, { rate: 25, effective_from: tomorrow })).status, 201);
    assert.equal((await admin.post(`/clients/${ids.alice}/services`, { service_type_id: svc.HYG, effective_from: tomorrow, bill_method: 'hourly', bill_rate: 45 })).status, 201);
    const back = await admin.post(`/caregivers/${ids.carla}/pay-rates`, { rate: 99, effective_from: '2019-01-01' });
    assert.equal(back.status, 400, 'cannot insert a rate before the latest one');
    const sh = (await admin.get(`/shifts/${ids.shift}`)).body;
    assert.equal(sh.pay_rate_cents, 2000);
    assert.equal(sh.bill_rate_cents, 3000);
    const rates = (await admin.get(`/caregivers/${ids.carla}`)).body.pay_rates;
    assert.equal(rates.length, 2);
    assert.equal(rates.find((r) => r.rate_cents === 2000).effective_to, today);
  });

  await t.test('6. clinical staff record measurements and view trends; abnormal values show escalation instructions', async () => {
    await nurse.put(`/clients/${ids.alice}/thresholds/bp`, { high: 150, low: 90, high2: 95, low2: 50, approved_by: 'Dr Test', escalation: 'Recheck in 5 min; call Dr Test if still high.' });
    const r = await nurse.post('/measurements', { client_id: ids.alice, items: [{ type_code: 'bp', value: 172, value2: 99 }, { type_code: 'glucose', value: 140 }, { type_code: 'weight', value: 150.5 }] });
    assert.equal(r.status, 201);
    assert.equal(r.body.alerts.length, 1);
    assert.match(r.body.alerts[0].escalation, /call Dr Test/);
    assert.match(r.body.alerts[0].message, /single reading does not establish/i);
    const summary = (await nurse.get(`/clients/${ids.alice}/health-summary`)).body;
    const bp = summary.find((x) => x.code === 'bp');
    assert.equal(bp.latest.value, 172);
    assert.equal(bp.previous.value, 128);
    assert.equal(bp.change, 44);
    assert.ok(bp.thresholds.individualized);
    const series = (await nurse.get('/measurements', { client_id: ids.alice, type_code: 'bp' })).body;
    assert.equal(series.length, 2);
    const weight = summary.find((x) => x.code === 'weight');
    assert.equal(weight.overdue, false);
  });

  await t.test('7. medication change is documented and shown as a timeline without asserting causation', async () => {
    const r = await nurse.patch(`/medications/${ids.med}`, { strength: '20 mg', effective_date: today, details: 'Per new order', verified: false });
    assert.equal(r.status, 200);
    const changes = (await nurse.get('/medication-changes', { client_id: ids.alice })).body;
    const dose = changes.find((c) => c.change_type === 'dose_change');
    assert.ok(dose);
    assert.equal(dose.previous_value, 'strength: 10 mg');
    assert.equal(dose.new_value, 'strength: 20 mg');
    assert.equal(dose.verified, 0);
    assert.equal((await nurse.post(`/medication-changes/${dose.id}/verify`)).status, 200);
    const cmp = (await nurse.get(`/medication-changes/${dose.id}/compare`, { days: 7 })).body;
    assert.match(cmp.disclaimer, /does not mean the medication caused/);
    assert.ok(cmp.before && cmp.after && Array.isArray(cmp.after_timeline));
    assert.ok(!JSON.stringify(cmp).match(/caused by|due to the medication/i));
  });

  await t.test('8. hospitalization, discharge, hospice referral and enrollment are distinct events', async () => {
    const ref = await nurse.post(`/clients/${ids.ben}/transitions`, { event_type: 'hospice_referral', event_date: today, source: 'PCP call', provider: 'Hospice Co' });
    assert.equal(ref.status, 201);
    let c = (await admin.get(`/clients/${ids.ben}`)).body;
    assert.equal(c.hospice_status, 'referred');
    assert.equal(c.status, 'active');
    await nurse.post(`/clients/${ids.ben}/transitions`, { event_type: 'hospital_admission', event_date: today, source: 'ED nurse', location: 'General' });
    c = (await admin.get(`/clients/${ids.ben}`)).body;
    assert.equal(c.status, 'hospitalized');
    assert.equal(c.hospice_status, 'referred', 'hospitalization does not change hospice status');
    // Caregiver cannot start care for a hospitalized client.
    const now = nowUtc();
    const sh = (await admin.post('/shifts', { caregiver_id: ids.carla, client_id: ids.ben, date: now.date, sched_start: plusMinutes(now.time, 1), sched_end: plusMinutes(now.time, 30), override_reason: 'testing' })).body.id;
    const carla = await s.login('carla');
    const blocked = await carla.post(`/shifts/${sh}/start`);
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /hospitalized/);
    const alert = s.db.get(`SELECT message FROM alerts WHERE client_id = ? AND category = 'transition'`, [ids.ben]);
    assert.match(alert.message, /do not bill/);
    await nurse.post(`/clients/${ids.ben}/transitions`, { event_type: 'hospital_discharge', event_date: today, source: 'Discharge summary', follow_up_due: today });
    assert.equal((await admin.get(`/clients/${ids.ben}`)).body.status, 'hospitalized', 'discharge from hospital is not the same as returning');
    await nurse.post(`/clients/${ids.ben}/transitions`, { event_type: 'return_home', event_date: today, source: 'Family' });
    assert.equal((await admin.get(`/clients/${ids.ben}`)).body.status, 'active');
    const noProvider = await nurse.post(`/clients/${ids.ben}/transitions`, { event_type: 'hospice_admission', event_date: today, source: 'Hospice' });
    assert.equal(noProvider.status, 400);
    await nurse.post(`/clients/${ids.ben}/transitions`, { event_type: 'hospice_admission', event_date: today, source: 'Hospice intake', provider: 'Hospice Co' });
    assert.equal((await admin.get(`/clients/${ids.ben}`)).body.hospice_status, 'enrolled');
    const types = (await nurse.get('/transitions', { client_id: ids.ben })).body.map((x) => x.event_type);
    assert.deepEqual(types.sort(), ['hospice_admission', 'hospice_referral', 'hospital_admission', 'hospital_discharge', 'return_home'].sort());
  });

  await t.test('9. staff identify possible deterioration and missing records, see evidence and document follow-up', async () => {
    const p = (await nurse.get(`/clients/${ids.alice}/progress`)).body;
    assert.ok(['requires_review', 'possible_decline', 'insufficient_data', 'stable', 'improving'].includes(p.trend.indicator));
    assert.equal(p.trend.indicator, 'requires_review', 'abnormal BP + open high alert require review');
    const reason = p.trend.reasons.find((r) => /outside approved thresholds/.test(r.text));
    assert.ok(reason.evidence.length >= 1 && reason.evidence[0].type === 'measurement');
    assert.match(p.trend.disclaimer, /not a clinical assessment/);
    const rev = await nurse.post(`/clients/${ids.alice}/reviews`, { assessment: 'requires_review', summary: 'BP elevated once; recheck ordered', action_taken: 'Called Dr Test' });
    assert.equal(rev.status, 201);
    assert.equal((await nurse.patch(`/progress-reviews/${rev.body.id}`, { concern_resolved_at: today })).status, 200);

    const alerts = (await nurse.get('/alerts', { status: 'unresolved', client_id: ids.alice })).body;
    const a = alerts.find((x) => x.category === 'measurement');
    assert.equal((await nurse.post(`/alerts/${a.id}/acknowledge`)).status, 200);
    assert.equal((await nurse.post(`/alerts/${a.id}/escalate`, {})).status, 400, 'escalation requires a note');
    assert.equal((await nurse.post(`/alerts/${a.id}/escalate`, { note: 'Phoned Dr Test, recheck in 1h' })).status, 200);
    assert.equal((await nurse.post(`/alerts/${a.id}/resolve`, { note: 'Recheck 138/84' })).status, 200);
    const done = s.db.get('SELECT * FROM alerts WHERE id = ?', [a.id]);
    assert.ok(done.created_at && done.acknowledged_at && done.escalated_at && done.resolved_at);

    const ops = (await admin.get('/reports/monthly', { type: 'operations', month: today.slice(0, 7) })).body.data;
    assert.ok(Array.isArray(ops.incomplete_documentation));
    const health = (await nurse.get('/reports/monthly', { type: 'client_health', month: today.slice(0, 7), client_id: ids.ben })).body.data[0];
    assert.ok(health.missing_data.length > 0, 'missing-data warnings are reported');
  });

  await t.test('10 & 11. payroll and billing are independent and monthly reports reconcile with visits, rates and invoices', async () => {
    // Unapproved shifts are not billed.
    const pre = (await admin.get('/invoices/preview', { client_id: ids.alice, from: today, to: today })).body;
    assert.equal(pre.lines.length, 0);
    assert.ok(pre.warnings.some((w) => /awaiting approval/.test(w)));
    assert.equal((await admin.post(`/shifts/${ids.shift}/approve`)).status, 200);

    const inv = await admin.post('/invoices', { client_id: ids.alice, from: today, to: today });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    const detail = (await admin.get(`/invoices/${inv.body.id}`)).body;
    assert.equal(detail.items.length, 1);
    assert.equal(detail.items[0].quantity, 4);
    assert.equal(detail.items[0].rate_cents, 3000, 'billed at the client rate in effect on the shift date');
    assert.equal(detail.total_cents, 12000);
    // A shift cannot be billed twice.
    assert.equal((await admin.post('/invoices', { client_id: ids.alice, from: today, to: today })).status, 400);
    // Time on billed shifts is locked.
    const locked = await admin.patch(`/shifts/${ids.shift}`, { break_min: 30, reason: 'try to change' });
    assert.equal(locked.status, 400);
    assert.equal((await admin.post(`/invoices/${inv.body.id}/items`, { kind: 'credit', description: 'Goodwill', rate: 10 })).status, 201);
    assert.equal((await admin.post(`/invoices/${inv.body.id}/issue`)).status, 200);
    assert.equal((await admin.post(`/invoices/${inv.body.id}/payments`, { date: today, amount: 200 })).status, 400, 'cannot overpay');
    assert.equal((await admin.post(`/invoices/${inv.body.id}/payments`, { date: today, amount: 50 })).status, 201);
    let i2 = (await admin.get(`/invoices/${inv.body.id}`)).body;
    assert.equal(i2.total_cents, 11000);
    assert.equal(i2.status, 'partially_paid');
    assert.equal(i2.balance_cents, 6000);
    await admin.post(`/invoices/${inv.body.id}/payments`, { date: today, amount: 60 });
    i2 = (await admin.get(`/invoices/${inv.body.id}`)).body;
    assert.equal(i2.status, 'paid');

    // Payroll uses the caregiver pay rate (20/h), not the bill rate.
    const pay = (await admin.get('/payroll/preview', { from: today, to: today, approved_only: 1 })).body;
    const item = pay.items.find((x) => x.caregiver_id === ids.carla);
    assert.equal(item.regular_hours, 4);
    assert.equal(item.regular_cents, 8000);
    assert.equal(item.mileage_cents, 200);
    assert.equal(item.gross_cents, 8200);
    assert.ok(pay.estimate);

    const run = await admin.post('/payroll/runs', { from: today, to: today });
    assert.equal(run.status, 201);
    assert.equal((await admin.post(`/payroll/runs/${run.body.id}/approve`)).status, 200);
    assert.equal((await admin.post('/payroll/runs', { from: today, to: today })).status, 409, 'overlapping run blocked');

    const fin = (await admin.get('/reports/monthly', { type: 'financial', month: today.slice(0, 7) })).body.data;
    assert.equal(fin.totals.billable_cents, 12000, 'billable = approved hours × frozen bill rate');
    assert.equal(fin.totals.invoiced_cents, 11000, 'invoiced = invoice totals incl. credit');
    assert.equal(fin.totals.collected_cents, 11000);
    assert.equal(fin.totals.payroll_estimate_cents, 8200);
    assert.equal(fin.totals.regular_hours, 4);
    const cgRep = (await admin.get('/reports/monthly', { type: 'caregiver_activity', month: today.slice(0, 7), caregiver_id: ids.carla })).body.data[0];
    assert.equal(cgRep.actual_hours, 4);
    assert.equal(cgRep.approval.approved, 1);
    assert.equal(cgRep.care_tasks.completed, 1);
  });

  await t.test('12. CSV exports reflect the selected range and filters', async () => {
    const res = await admin.req('GET', `/reports/timesheet.csv?from=${today}&to=${today}&client_id=${ids.alice}`, undefined, { raw: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const lines = res.buf.toString('utf8').replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines.length, 2, 'header + one visit');
    assert.match(lines[1], /Alice Test/);
    const none = await admin.req('GET', `/reports/timesheet.csv?from=2000-01-01&to=2000-01-31`, undefined, { raw: true });
    assert.equal(none.buf.toString('utf8').trim().split('\r\n').length, 1);
    // Formula injection is neutralised.
    s.db.run(`UPDATE shifts SET notes = '=HYPERLINK("http://x")' WHERE id = ?`, [ids.shift]);
    const inj = await admin.req('GET', `/reports/timesheet.csv?from=${today}&to=${today}`, undefined, { raw: true });
    assert.match(inj.buf.toString('utf8'), /"'=HYPERLINK/);
  });

  await t.test('13. backups produce a valid database copy', async () => {
    const res = await admin.req('GET', '/backup', undefined, { raw: true });
    assert.equal(res.status, 200);
    assert.equal(res.buf.subarray(0, 15).toString(), 'SQLite format 3');
    const nurseTry = await nurse.req('GET', '/backup', undefined, { raw: true });
    assert.equal(nurseTry.status, 403);
  });

  await t.test('14. alerts and summaries never substitute for clinical judgment', async () => {
    const alerts = s.db.all('SELECT message, escalation FROM alerts');
    for (const a of alerts) assert.ok(!/diagnos(is|ed)\b/i.test(a.message), a.message);
    const measAlert = alerts.find((a) => a.escalation);
    assert.ok(measAlert);
    const dflt = require('../server/lib/alerts').DEFAULT_ESCALATION;
    assert.match(dflt, /call 911/);
  });
});
