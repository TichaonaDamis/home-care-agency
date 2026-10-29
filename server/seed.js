'use strict';
// Realistic SAMPLE data for development and demos. Every row is flagged is_sample = 1 where the
// table supports it, codes start with "SAMPLE-", and names end in "(Sample)" so sample records
// can never be mistaken for real clients or staff.
const crypto = require('node:crypto');
const { hashPassword } = require('./lib/auth');
const { createSettings, rateSnapshot } = require('./lib/core');
const { addDays, dayOfWeek, nowLocal } = require('./lib/util');
const alerts = require('./lib/alerts');

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function seedSample(db, { password = process.env.SEED_PASSWORD || null, days = 35 } = {}) {
  if (db.get(`SELECT 1 FROM clients WHERE code LIKE 'SAMPLE-%'`)) throw new Error('Sample data already exists.');
  const settings = createSettings(db);
  const tz = settings.get('timezone');
  const today = settings.today();
  const rand = rng(42);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const pw = password || `Sample-${crypto.randomBytes(3).toString('hex')}-2026`;
  const accounts = [];

  return db.tx(() => {
    const facility = db.insert('facilities', { name: 'Maple Grove AFH (Sample)', kind: 'afh', address: '100 Sample Way', capacity: 6, is_sample: 1 });
    const homeCare = db.get(`SELECT id FROM facilities WHERE name = 'Main Office'`)?.id ?? null;
    const svc = Object.fromEntries(db.all('SELECT id, code FROM service_types').map((s) => [s.code, s.id]));
    const cat = Object.fromEntries(db.all('SELECT id, name FROM client_categories').map((c) => [c.name, c.id]));

    const user = (username, display, role, caregiverId = null) => {
      const id = db.insert('users', { username, display_name: display, role, caregiver_id: caregiverId, password_hash: hashPassword(pw), must_change_password: 0 });
      accounts.push({ username, role, password: pw });
      return id;
    };
    const adminId = db.get(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`)?.id ?? user('sample.admin', 'Sample Admin', 'admin');
    user('sample.manager', 'Sam Rivera (Sample)', 'manager');
    const nurseId = user('sample.nurse', 'Nina Okafor RN (Sample)', 'nurse');

    // ----- caregivers -----
    const cgDefs = [
      { name: 'Maria Lopez (Sample)', rate: 2100, mileage: 67, med: 'administer', rule: 'weekly40', user: 'maria.sample' },
      { name: 'James Carter (Sample)', rate: 1950, mileage: 67, med: 'assist', rule: 'daily8_weekly40', user: 'james.sample' },
      { name: 'Aisha Bello (Sample)', rate: 2250, mileage: 50, med: 'assist', rule: 'weekly40', user: 'aisha.sample' },
    ];
    const cgs = cgDefs.map((d, i) => {
      const id = db.insert('caregivers', {
        code: `SAMPLE-CG-${i + 1}`, full_name: d.name, phone: `555-010${i}`, email: `${d.user}@example.com`, employment_status: 'active',
        employment_class: 'w2_hourly', hire_date: addDays(today, -400 + i * 60), overtime_rule: d.rule, mileage_rate_cents: d.mileage,
        background_status: 'cleared', background_date: addDays(today, -420), med_authority: d.med, facility_id: i === 1 ? homeCare : facility,
        responsibilities: 'Personal care, meals, companionship', availability: 'Weekdays', is_sample: 1, emergency_name: 'Sample Contact', emergency_phone: '555-0199',
      });
      // Rate history: an older rate, then the current one (demonstrates historical rates).
      db.insert('caregiver_pay_rates', { caregiver_id: id, rate_cents: d.rate - 100, effective_from: addDays(today, -400), effective_to: addDays(today, -21), created_by: adminId });
      db.insert('caregiver_pay_rates', { caregiver_id: id, rate_cents: d.rate, effective_from: addDays(today, -20), created_by: adminId });
      db.insert('credentials', { caregiver_id: id, name: 'CPR / First Aid', expires_on: addDays(today, i === 0 ? 18 : 300), verified: 1 });
      db.insert('credentials', { caregiver_id: id, name: 'Home Care Aide certification', expires_on: addDays(today, 500), verified: i !== 2 ? 1 : 0 });
      const userId = user(d.user, d.name, 'caregiver', id);
      return { id, userId, ...d };
    });

    // ----- clients -----
    const clDefs = [
      { name: 'Dorothy Evans (Sample)', pref: 'Dot', fac: facility, room: '1', cats: ['Adult Family Home resident', 'Mobility assistance'], svc: 'RES', method: 'daily', rate: 26500, fluid: 1200 },
      { name: 'Harold Kim (Sample)', pref: null, fac: facility, room: '2', cats: ['Adult Family Home resident', 'Dementia / cognitive support'], svc: 'DEM', method: 'hourly', rate: 3800, fluid: 1200 },
      { name: 'Ruth Thompson (Sample)', pref: null, fac: homeCare, room: null, cats: ['Home care client', 'Personal-care assistance'], svc: 'HYG', method: 'hourly', rate: 3400, fluid: null },
      { name: 'George Patel (Sample)', pref: null, fac: homeCare, room: null, cats: ['Home care client', 'Short-term / respite'], svc: 'COMP', method: 'per_visit', rate: 9500, fluid: null },
    ];
    const clients = clDefs.map((d, i) => {
      const id = db.insert('clients', {
        code: `SAMPLE-CL-${i + 1}`, legal_name: d.name, preferred_name: d.pref, dob: `19${38 + i * 3}-0${i + 3}-1${i}`, facility_id: d.fac, room: d.room,
        address: d.room ? '100 Sample Way' : `${20 + i} Sample Street`, allergies: i === 0 ? 'Penicillin' : 'No known allergies',
        alerts: i === 1 ? 'Wanders in the evening — door alarm on' : null, diet: i === 0 ? 'Low sodium' : 'Regular', pcp_name: 'Dr. Sample Provider', pcp_phone: '555-0150',
        admission_date: addDays(today, -200 + i * 20), status: 'active', consent_notes: 'Consent to care on file (sample)', min_fluid_ml: d.fluid, is_sample: 1,
      });
      for (const c of d.cats) db.run('INSERT INTO client_category_links (client_id, category_id) VALUES (?, ?)', [id, cat[c]]);
      db.insert('client_contacts', { client_id: id, kind: 'emergency', name: `Family Member ${i + 1} (Sample)`, relationship: 'Daughter', phone: `555-02${i}0` });
      db.insert('client_contacts', { client_id: id, kind: 'representative', name: `Representative ${i + 1} (Sample)`, relationship: 'POA', phone: `555-03${i}0`, is_decision_maker: 1 });
      // Billing rate history: older rate then current rate.
      db.insert('client_services', { client_id: id, service_type_id: svc[d.svc], effective_from: addDays(today, -200), effective_to: addDays(today, -16), bill_method: d.method, bill_rate_cents: d.rate - 200, frequency: 'Per schedule', created_by: adminId });
      db.insert('client_services', { client_id: id, service_type_id: svc[d.svc], effective_from: addDays(today, -15), bill_method: d.method, bill_rate_cents: d.rate, frequency: 'Per schedule', instructions: 'Follow care plan', created_by: adminId });
      db.insert('client_services', { client_id: id, service_type_id: svc.MED, effective_from: addDays(today, -200), bill_method: 'not_billed', bill_rate_cents: 0, frequency: 'Per medication schedule', created_by: adminId });
      db.insert('care_plans', {
        client_id: id, version: 1, status: 'active', effective_date: addDays(today, -60), review_due: addDays(today, i === 2 ? -3 : 60),
        summary: 'Sample care plan. Support independence and safety.', goals: 'Maintain mobility and nutrition.',
        instructions: 'Encourage fluids. Use gait belt for transfers. Report changes to supervisor.',
        adl_tasks: i === 3 ? 'Companionship' : 'Bathing / personal hygiene\nDressing & grooming\nMobility / transfers', mobility: 'Walker; standby assist',
        diet: d.pref ? 'Low sodium' : 'Regular', requires_ack: 1, created_by: nurseId,
      });
      return { id, ...d };
    });
    const plans = Object.fromEntries(db.all(`SELECT id, client_id FROM care_plans WHERE status = 'active'`).map((p) => [p.client_id, p.id]));

    // Thresholds and medications
    db.run(`INSERT INTO client_thresholds (client_id, type_code, low, high, low2, high2, escalation, approved_by, set_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      [clients[0].id, 'bp', 95, 150, 55, 95, 'Re-check after 5 minutes seated. If still above 150/95, call Dr. Sample Provider. If chest pain or confusion, call 911.', 'Dr. Sample Provider (sample order)', nurseId]);
    db.run(`INSERT INTO client_thresholds (client_id, type_code, expected_every_days, approved_by, set_by) VALUES (?,?,?,?,?)`, [clients[1].id, 'weight', 7, 'Facility policy (sample)', nurseId]);
    const meds = {};
    const addMed = (clientIdx, m) => {
      const id = db.insert('medications', { client_id: clients[clientIdx].id, status: 'active', prn: 0, prescriber: 'Dr. Sample Provider', pharmacy: 'Sample Pharmacy', order_source: 'Signed order (sample)', created_by: nurseId, ...m });
      db.insert('medication_changes', { medication_id: id, client_id: clients[clientIdx].id, change_type: 'started', effective_date: m.start_date, new_value: `${m.strength} ${m.dose} ${m.route} ${m.frequency}`, documented_by: nurseId, verified: 1, verified_by: nurseId, verified_at: new Date().toISOString(), review_status: 'closed' });
      (meds[clientIdx] ||= []).push({ id, ...m });
      return id;
    };
    addMed(0, { name: 'Lisinopril (sample)', strength: '10 mg', form: 'tablet', dose: '1 tablet', route: 'oral', frequency: 'once daily', times: '09:00', start_date: addDays(today, -180) });
    const sertraline = addMed(1, { name: 'Sertraline (sample)', strength: '25 mg', form: 'tablet', dose: '1 tablet', route: 'oral', frequency: 'once daily', times: '09:00', start_date: addDays(today, -120) });
    addMed(1, { name: 'Acetaminophen (sample)', strength: '500 mg', form: 'tablet', dose: '1 tablet', route: 'oral', frequency: 'every 6 h as needed', times: null, prn: 1, start_date: addDays(today, -90) });
    addMed(2, { name: 'Metformin (sample)', strength: '500 mg', form: 'tablet', dose: '1 tablet', route: 'oral', frequency: 'with breakfast', times: '08:30', start_date: addDays(today, -300) });
    // A documented dose change two weeks ago (for the before/after review screen).
    const changeDate = addDays(today, -14);
    db.update('medications', sertraline, { strength: '50 mg' });
    db.insert('medication_changes', { medication_id: sertraline, client_id: clients[1].id, change_type: 'dose_change', effective_date: changeDate, previous_value: 'strength: 25 mg', new_value: 'strength: 50 mg', details: 'Dose increased per provider order (sample).', order_source: 'Signed order (sample)', documented_by: nurseId, verified: 1, verified_by: nurseId, verified_at: new Date().toISOString(), follow_up: 'Monitor sleep, appetite and mood for 2 weeks', review_status: 'in_review' });
    meds[1][0].strength = '50 mg';

    // ----- assignments: one caregiver serves several clients; clients have several caregivers -----
    const asg = [
      { cg: 0, cl: 0, days: '1,2,3,4,5', s: '07:00', e: '11:00', svc: 'RES' },
      { cg: 0, cl: 1, days: '1,2,3,4,5', s: '11:30', e: '15:30', svc: 'DEM' },
      { cg: 1, cl: 2, days: '1,3,5', s: '09:00', e: '13:00', svc: 'HYG' },
      { cg: 1, cl: 3, days: '2,4', s: '10:00', e: '12:00', svc: 'COMP' },
      { cg: 2, cl: 0, days: '0,6', s: '08:00', e: '16:00', svc: 'RES' },
      { cg: 2, cl: 1, days: '0,6', s: '16:30', e: '20:30', svc: 'DEM' },
    ].map((a) => ({
      ...a,
      id: db.insert('assignments', {
        caregiver_id: cgs[a.cg].id, client_id: clients[a.cl].id, facility_id: clients[a.cl].fac, service_type_id: svc[a.svc],
        start_date: addDays(today, -days - 5), days_of_week: a.days, shift_start: a.s, shift_end: a.e, status: 'active',
        approved_by: adminId, approved_at: new Date().toISOString(), created_by: adminId, is_sample: 1, responsibilities: 'Per care plan',
      }),
    }));
    for (const a of asg) db.run('INSERT OR IGNORE INTO care_plan_acks (care_plan_id, caregiver_id, acknowledged_at) VALUES (?,?,?)', [plans[clients[a.cl].id], cgs[a.cg].id, new Date().toISOString()]);

    // ----- shifts with documentation -----
    const hhmm = (t, delta) => { const [h, m] = t.split(':').map(Number); const x = h * 60 + m + delta; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
    const now = nowLocal(tz);
    const hospital = { from: addDays(today, -10), to: addDays(today, -6) }; // George hospitalized
    for (let back = days; back >= -14; back--) {
      const d = addDays(today, -back);
      for (const a of asg) {
        if (!a.days.split(',').map(Number).includes(dayOfWeek(d))) continue;
        const client = clients[a.cl];
        const cg = cgs[a.cg];
        const base = { assignment_id: a.id, caregiver_id: cg.id, client_id: client.id, facility_id: client.fac, service_type_id: svc[a.svc], date: d, sched_start: a.s, sched_end: a.e, is_sample: 1, source: 'schedule' };
        const inHospital = a.cl === 3 && d >= hospital.from && d < hospital.to;
        const past = `${d}T${a.e}` < now;
        if (!past) { db.insert('shifts', { ...base, ...rateSnapshot(db, base), status: inHospital ? 'cancelled' : 'scheduled' }); continue; }
        if (inHospital) { db.insert('shifts', { ...base, status: 'cancelled', override_reason: 'Client hospitalized (sample)' }); continue; }
        if (rand() < 0.03) { db.insert('shifts', { ...base, status: 'missed', override_reason: 'Caregiver illness (sample)' }); continue; }
        const st = hhmm(a.s, Math.floor(rand() * 11) - 5);
        const en = hhmm(a.e, Math.floor(rand() * 16) - 5);
        const id = db.insert('shifts', {
          ...base, ...rateSnapshot(db, base), status: 'completed', actual_start: `${d}T${st}`, actual_end: `${d}T${en}`,
          break_min: schedLen(a) >= 6 ? 30 : 0, mileage: client.fac === facility ? 0 : Math.round((3 + rand() * 9) * 10) / 10,
          doc_complete: 1, approval_status: back > 7 ? 'approved' : 'pending', approved_by: back > 7 ? adminId : null, approved_at: back > 7 ? new Date().toISOString() : null,
          notes: rand() < 0.2 ? 'Good visit (sample note).' : null,
        });
        const at = `${d}T${hhmm(a.s, 30)}`;
        const author = cg.userId;
        // ADL tasks from the care plan
        const tasks = a.cl === 3 ? ['Companionship'] : ['Bathing / personal hygiene', 'Dressing & grooming', 'Mobility / transfers'];
        for (const t of tasks) {
          const declined = rand() < 0.07;
          db.insert('adl_logs', { client_id: client.id, shift_id: id, author_id: author, recorded_at: at, task: t, status: declined ? 'declined' : 'completed', notes: declined ? 'Client declined; offered again later (sample).' : null });
        }
        // Harold (cl 1) shows lower intake and poorer sleep after the medication change — a temporal pattern for review, not a conclusion.
        const afterChange = a.cl === 1 && d >= changeDate;
        const pct = Math.max(10, Math.min(100, Math.round((afterChange ? 55 : 80) + (rand() - 0.5) * 30)));
        db.insert('meal_logs', { client_id: client.id, shift_id: id, author_id: author, recorded_at: `${d}T${hhmm(a.s, 60)}`, meal: Number(a.s.slice(0, 2)) < 11 ? 'breakfast' : Number(a.s.slice(0, 2)) < 16 ? 'lunch' : 'dinner', offered: 'Regular meal', percent_consumed: pct, fluid_ml: Math.round((afterChange ? 450 : 650) + rand() * 200), appetite: pct < 50 ? 'decreased' : 'usual', assistance: 'setup', refused: pct < 20 ? 1 : 0 });
        // Additional drinks through the visit (AFH residents' care-plan fluid goals are tracked per day).
        for (let k = 0; k < (client.fac === facility ? 3 : 1); k++) {
          db.insert('meal_logs', { client_id: client.id, shift_id: id, author_id: author, recorded_at: `${d}T${hhmm(a.s, 100 + k * 50)}`, meal: 'fluids_only', offered: pick(['Water', 'Juice', 'Tea']), fluid_ml: Math.round((afterChange ? 160 : 260) + rand() * 80) });
        }
        if (rand() < 0.5) db.insert('activity_logs', { client_id: client.id, shift_id: id, author_id: author, recorded_at: `${d}T${hhmm(a.s, 90)}`, activity: pick(['Walk in hallway', 'Music', 'Card game', 'Reading together', 'Outdoor sitting']), minutes: 15 + Math.floor(rand() * 30), participation: pick(['active', 'active', 'partial', 'declined']), tolerance: 'good' });
        db.insert('observations', {
          client_id: client.id, shift_id: id, author_id: author, recorded_at: `${d}T${hhmm(a.e, -15)}`,
          mood: afterChange ? pick(['withdrawn', 'calm', 'irritable']) : pick(['calm', 'content', 'cheerful']), alertness: a.cl === 1 ? 'alert_confused' : 'alert_oriented',
          sleep: afterChange ? pick(['poor', 'fair']) : pick(['good', 'good', 'fair']), pain_score: Math.floor(rand() * 3), energy: afterChange ? 'decreased' : 'usual',
          observation: 'Client in usual condition (sample).',
        });
        // Measurements on some days
        if (a.cl === 0 && rand() < 0.6) db.insert('measurements', { client_id: client.id, shift_id: id, type_code: 'bp', value: 118 + Math.round(rand() * 30), value2: 70 + Math.round(rand() * 15), unit: 'mmHg', measured_at: `${d}T${hhmm(a.s, 20)}`, method: 'Seated, left arm', recorded_by: author });
        if (a.cl === 2 && rand() < 0.7) db.insert('measurements', { client_id: client.id, type_code: 'glucose', value: 95 + Math.round(rand() * 70), unit: 'mg/dL', measured_at: `${d}T${hhmm(a.s, 10)}`, method: 'Fingerstick, fasting', recorded_by: nurseId });
        if (a.cl === 1 && dayOfWeek(d) === 1) db.insert('measurements', { client_id: client.id, shift_id: id, type_code: 'weight', value: 168 - (afterChange ? (back < 7 ? 6 : 3) : 0) + Math.round(rand() * 10) / 10, unit: 'lb', measured_at: `${d}T${hhmm(a.s, 15)}`, method: 'Standing scale', recorded_by: author });
        // Medication events for scheduled doses inside the visit
        for (const m of meds[a.cl] || []) {
          if (m.prn || !m.times) continue;
          for (const t of m.times.split(',')) {
            if (t < st || t > en) continue;
            const refused = rand() < 0.04;
            db.insert('med_events', { medication_id: m.id, client_id: client.id, shift_id: id, author_id: author, scheduled_for: `${d}T${t}`, action: refused ? 'refused' : cg.med === 'administer' ? 'administered' : 'assisted', actual_time: refused ? null : `${d}T${t}`, dose_given: refused ? null : m.dose, notes: refused ? 'Client refused; supervisor informed (sample).' : null });
          }
        }
      }
    }

    // ----- events -----
    const geo = clients[3].id;
    const tr = (row) => db.insert('transitions', { client_id: geo, created_by: nurseId, source: 'Hospital discharge summary (sample)', ...row });
    tr({ event_type: 'ed_visit', event_date: hospital.from, location: 'Sample General Hospital', notes: 'Shortness of breath (sample)' });
    tr({ event_type: 'hospital_admission', event_date: hospital.from, location: 'Sample General Hospital' });
    tr({ event_type: 'hospital_discharge', event_date: hospital.to, location: 'Sample General Hospital', follow_up_due: addDays(hospital.to, 7), notes: 'Follow up with PCP within 7 days' });
    tr({ event_type: 'return_home', event_date: hospital.to });
    db.insert('transitions', { client_id: clients[2].id, event_type: 'hospice_referral', event_date: addDays(today, -4), provider: 'Sample Hospice Agency', contact: '555-0177', source: 'PCP referral (sample)', created_by: nurseId, notes: 'Referral only — not enrolled.' });
    db.update('clients', clients[2].id, { hospice_status: 'referred' });

    const fallAt = `${addDays(today, -5)}T14:10`;
    const shiftForFall = db.get(`SELECT id FROM shifts WHERE client_id = ? AND date = ? AND status = 'completed'`, [clients[1].id, addDays(today, -5)]);
    const inc = db.insert('incidents', { client_id: clients[1].id, shift_id: shiftForFall?.id ?? null, reported_by: cgs[0].userId, occurred_at: fallAt, type: 'fall', severity: 'moderate', description: 'Found seated on floor beside bed; no visible injury (sample).', immediate_action: 'Assisted up with two-person assist, checked for injury.', notified: 'Supervisor, family', status: 'under_review' });
    alerts.onIncident(db, { id: inc, client_id: clients[1].id, type: 'fall', severity: 'moderate' });

    db.insert('expenses', { date: addDays(today, -12), category: 'Supplies', description: 'Gloves and wipes (sample)', amount_cents: 18450, facility_id: facility, created_by: adminId });
    db.insert('expenses', { date: addDays(today, -3), category: 'Food', description: 'Groceries (sample)', amount_cents: 32010, facility_id: facility, created_by: adminId });

    alerts.sweep(db, settings, { force: true });
    return { accounts };
  });
}

function schedLen(a) {
  const [sh] = a.s.split(':').map(Number);
  const [eh] = a.e.split(':').map(Number);
  return eh - sh;
}

module.exports = { seedSample };
