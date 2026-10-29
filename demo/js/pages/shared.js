// Form definitions and dialogs shared by staff pages and the caregiver portal.
import { api } from '../api.js';
import { esc, formModal, modal, fields, onSubmit, toast, label, opts, field } from '../ui.js';

export const CLIENT_STATUSES = ['active', 'hospitalized', 'temporarily_away', 'discharged', 'deceased', 'other'];
const o = (vals) => vals.map((v) => [v, label(v)]);

export function clientDefs(lk) {
  return [
    { name: 'legal_name', label: 'Legal name', required: true },
    { name: 'preferred_name', label: 'Preferred name' },
    { name: 'code', label: 'Client ID', hint: 'Leave blank to auto-generate. Cannot be changed later.' },
    { name: 'dob', label: 'Date of birth', type: 'date' },
    { name: 'facility_id', label: 'Facility / service location', type: 'select', options: opts(lk.facilities.filter((f) => f.active)) },
    { name: 'room', label: 'Room / unit' },
    { name: 'address', label: 'Address', full: true },
    { name: 'phone', label: 'Phone', type: 'tel' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'admission_date', label: 'Admission date', type: 'date' },
    { name: 'status', label: 'Status', type: 'select', options: o(CLIENT_STATUSES), required: true, value: 'active' },
    { name: 'pcp_name', label: 'Primary care provider' },
    { name: 'pcp_phone', label: 'Provider phone', type: 'tel' },
    { name: 'allergies', label: 'Allergies', type: 'textarea', full: true, rows: 2 },
    { name: 'alerts', label: 'Important alerts', type: 'textarea', full: true, rows: 2, hint: 'Safety information all caregivers must see (e.g. fall risk, wandering).' },
    { name: 'diet', label: 'Diet / restrictions', type: 'textarea', rows: 2 },
    { name: 'min_fluid_ml', label: 'Daily fluid goal (mL)', type: 'number', min: 0, hint: 'From the care plan; leave blank if not set.' },
    { name: 'consent_notes', label: 'Consent on file', type: 'textarea', rows: 2 },
    { name: 'contact_preferences', label: 'Contact preferences', type: 'textarea', rows: 2 },
    { name: 'category_ids', label: 'Client categories / care needs', type: 'checks', full: true, options: opts(lk.categories.filter((c) => c.active)) },
  ];
}

export function medDefs() {
  return [
    { name: 'name', label: 'Medication name', required: true },
    { name: 'strength', label: 'Strength', placeholder: 'e.g. 10 mg' },
    { name: 'form', label: 'Formulation', placeholder: 'tablet, liquid…' },
    { name: 'dose', label: 'Dose', placeholder: '1 tablet' },
    { name: 'route', label: 'Route', placeholder: 'oral' },
    { name: 'frequency', label: 'Frequency', placeholder: 'once daily' },
    { name: 'times', label: 'Scheduled times', placeholder: '08:00, 20:00', hint: '24-hour times, comma-separated. Leave blank for PRN.' },
    { name: 'prn', label: 'PRN (as needed)', type: 'checkbox' },
    { name: 'prescriber', label: 'Prescriber' },
    { name: 'pharmacy', label: 'Pharmacy' },
    { name: 'start_date', label: 'Start date', type: 'date' },
    { name: 'stop_date', label: 'Stop date', type: 'date' },
    { name: 'order_source', label: 'Source of order', placeholder: 'Signed order, pharmacy label…', full: true },
    { name: 'instructions', label: 'Instructions', type: 'textarea', full: true },
    { name: 'precautions', label: 'Precautions', type: 'textarea', full: true },
  ];
}

/** Record measurements (one or several together). Returns raised alerts with escalation text. */
export async function measurementDialog({ clientId, shiftId = null, types }) {
  const rows = types.map((t) => `<div class="form-grid" data-type="${esc(t.code)}">
      <label class="field"><span>${esc(t.name)} (${esc(t.unit)})</span><input type="number" step="any" name="v_${esc(t.code)}" aria-label="${esc(t.name)}${t.has_second_value ? ' systolic' : ''}" placeholder="${t.has_second_value ? 'Systolic' : 'Value'}"></label>
      ${t.has_second_value ? `<label class="field"><span>Diastolic</span><input type="number" step="any" name="v2_${esc(t.code)}"></label>` : ''}</div>`).join('');
  return modal({
    title: 'Record measurements',
    body: `<form class="form"><p class="hint">Enter only the values you measured. Leave others blank — missing values are never estimated.</p>
      ${rows}
      <div class="form-grid">${fields([
    { name: 'measured_at', label: 'Measured at', type: 'datetime', hint: 'Defaults to now' },
    { name: 'method', label: 'Method / context', placeholder: 'Seated, left arm; fasting…' },
    { name: 'symptoms', label: 'Symptoms or observations', type: 'textarea', full: true, rows: 2 },
    { name: 'follow_up', label: 'Follow-up action', type: 'textarea', full: true, rows: 2 },
    { name: 'clinician_notified', label: 'Supervisor / clinician notified', type: 'checkbox' },
  ])}</div>
      <div class="actions"><button class="btn primary" type="submit">Save</button><button class="btn ghost" type="button" data-close>Cancel</button></div></form>`,
    onMount: (el, close) => onSubmit(el.querySelector('form'), async (v) => {
      const items = types.map((t) => ({ type_code: t.code, value: v[`v_${t.code}`], value2: v[`v2_${t.code}`] })).filter((i) => i.value != null);
      if (!items.length) throw new Error('Enter at least one value.');
      const r = await api.post('/measurements', { client_id: clientId, shift_id: shiftId, measured_at: v.measured_at, method: v.method, symptoms: v.symptoms, follow_up: v.follow_up, clinician_notified: v.clinician_notified, items });
      close(r);
      // Shown after the form closes so the instructions are the only thing on screen.
      if (r.alerts.length) escalationDialog(r.alerts);
      else toast('Measurements saved.', 'ok');
    }),
  });
}

export function escalationDialog(alerts) {
  return modal({
    title: 'Follow approved escalation instructions',
    body: `${alerts.map((a) => `<div class="notice danger"><strong>${esc(a.message)}</strong>${esc(a.escalation || '')}</div>`).join('<br>')}
      <p class="disclaimer">CareHours is a documentation aid. It does not diagnose and does not replace clinical judgment or emergency procedures.</p>
      <div class="actions"><button class="btn primary" data-close>I understand</button></div>`,
  });
}

export const ADL_STATUSES = [['completed', 'Completed'], ['partial', 'Partially completed'], ['declined', 'Declined by client'], ['not_applicable', 'Not applicable'], ['not_completed', 'Not completed']];
export const DEFAULT_ADL = ['Bathing / personal hygiene', 'Dressing & grooming', 'Oral care', 'Mobility / transfers', 'Toileting / continence', 'Skin care'];

/** ADL checklist: tasks from the care plan plus optional others. */
export function adlDialog({ clientId, shiftId, tasks }) {
  const list = tasks.length ? tasks : DEFAULT_ADL;
  return modal({
    title: 'Activities of daily living',
    wide: true,
    body: `<form class="form"><p class="hint">Record each task. Add a note for anything partial, declined or not completed.</p>
      ${list.map((t, i) => `<div class="adl-row"><strong>${esc(t)}</strong>
        <select name="s_${i}" aria-label="${esc(t)} status"><option value="">— not recorded —</option>${ADL_STATUSES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <input name="n_${i}" placeholder="Note" aria-label="${esc(t)} note"></div>`).join('')}
      <div class="adl-row"><input name="extra_task" placeholder="Other authorized task" aria-label="Other task">
        <select name="extra_status" aria-label="Other task status"><option value="">—</option>${ADL_STATUSES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <input name="extra_note" placeholder="Note" aria-label="Other task note"></div>
      <div class="actions"><button class="btn primary" type="submit">Save tasks</button><button class="btn ghost" type="button" data-close>Cancel</button></div></form>`,
    onMount: (el, close) => onSubmit(el.querySelector('form'), async (v) => {
      const items = list.map((t, i) => ({ task: t, status: v[`s_${i}`], notes: v[`n_${i}`] })).filter((x) => x.status);
      if (v.extra_task && v.extra_status) items.push({ task: v.extra_task, status: v.extra_status, notes: v.extra_note });
      if (!items.length) throw new Error('Record at least one task.');
      await api.post('/care/adl', { client_id: clientId, shift_id: shiftId, items });
      toast('Care tasks saved.', 'ok');
      close(true);
    }),
  });
}

export function mealDialog({ clientId, shiftId }) {
  return formModal({
    title: 'Meal / fluid intake',
    intro: '<p class="hint">Only the meal is required. Fill in what applies.</p>',
    defs: [
      { name: 'meal', label: 'Meal', type: 'select', required: true, options: o(['breakfast', 'lunch', 'dinner', 'snack', 'fluids_only']) },
      { name: 'recorded_at', label: 'Time', type: 'datetime', hint: 'Defaults to now' },
      { name: 'offered', label: 'Food / drink offered', full: true },
      { name: 'percent_consumed', label: 'Amount eaten (%)', type: 'select', options: [[100, '100% (all)'], [75, '75%'], [50, '50%'], [25, '25%'], [0, 'None']] },
      { name: 'fluid_ml', label: 'Fluids (mL)', type: 'number', min: 0, step: 10, hint: '1 cup ≈ 240 mL' },
      { name: 'appetite', label: 'Appetite', type: 'select', options: o(['usual', 'increased', 'decreased', 'poor']) },
      { name: 'assistance', label: 'Feeding assistance', type: 'select', options: o(['none', 'setup', 'partial', 'full']) },
      { name: 'refused', label: 'Refused food/fluids', type: 'checkbox' },
      { name: 'swallowing_issue', label: 'Difficulty chewing or swallowing', type: 'checkbox' },
      { name: 'notes', label: 'Observations & actions taken', type: 'textarea', full: true },
    ],
    submit: async (v) => { await api.post('/care/meals', { ...v, client_id: clientId, shift_id: shiftId }); toast('Intake saved.', 'ok'); return true; },
  });
}

export function activityDialog({ clientId, shiftId }) {
  return formModal({
    title: 'Activity / engagement',
    defs: [
      { name: 'activity', label: 'Activity', required: true, placeholder: 'Walk, music, cards, outing…' },
      { name: 'recorded_at', label: 'Time', type: 'datetime', hint: 'Defaults to now' },
      { name: 'minutes', label: 'Duration (min)', type: 'number', min: 0 },
      { name: 'participation', label: 'Participation', type: 'select', options: o(['active', 'partial', 'passive', 'declined']) },
      { name: 'tolerance', label: 'Tolerance', type: 'select', options: o(['good', 'fair', 'poor']) },
      { name: 'notes', label: 'Observations', type: 'textarea', full: true },
    ],
    submit: async (v) => { await api.post('/care/activities', { ...v, client_id: clientId, shift_id: shiftId }); toast('Activity saved.', 'ok'); return true; },
  });
}

export function observationDialog({ clientId, shiftId }) {
  return formModal({
    title: 'Condition, mood & behavior',
    wide: true,
    intro: '<p class="hint">Describe what you see and hear objectively. Do not label behaviors as diagnoses.</p>',
    defs: [
      { name: 'mood', label: 'Mood / emotional state', type: 'select', options: o(['calm', 'content', 'cheerful', 'withdrawn', 'sad', 'irritable', 'anxious', 'other']) },
      { name: 'alertness', label: 'Alertness / orientation', type: 'select', options: [['alert_oriented', 'Alert & oriented'], ['alert_confused', 'Alert, confused'], ['drowsy', 'Drowsy'], ['difficult_to_rouse', 'Difficult to rouse']] },
      { name: 'sleep', label: 'Sleep / rest', type: 'select', options: o(['good', 'fair', 'poor', 'not_observed']) },
      { name: 'energy', label: 'Energy', type: 'select', options: o(['usual', 'increased', 'decreased']) },
      { name: 'pain_score', label: 'Pain (0–10, reported or observed)', type: 'number', min: 0, max: 10 },
      { name: 'fall_event', label: 'Falls', type: 'select', required: true, value: 'none', options: [['none', 'None'], ['near_fall', 'Near-fall'], ['fall', 'Fall']] },
      { name: 'agitation', label: 'Agitation or unusual behavior', type: 'checkbox' },
      { name: 'distress', label: 'Anxiety or distress', type: 'checkbox' },
      { name: 'skin_change', label: 'Skin change / visible injury', type: 'checkbox' },
      { name: 'other_change', label: 'Other change from usual condition', type: 'textarea', full: true, rows: 2 },
      { name: 'observation', label: 'Objective observation', type: 'textarea', full: true },
      { name: 'action_taken', label: 'Action taken', type: 'textarea', rows: 2 },
      { name: 'notified', label: 'Person notified' },
    ],
    submit: async (v) => {
      await api.post('/care/observations', { ...v, client_id: clientId, shift_id: shiftId });
      toast('Observation saved.', 'ok');
      if (v.fall_event === 'fall') toast('Please also complete an incident report for the fall.');
      return true;
    },
  });
}

export const INCIDENT_TYPES = ['fall', 'injury', 'medication_discrepancy', 'missed_task', 'sudden_change', 'behavior', 'elopement', 'property', 'other'];
export function incidentDefs(clients, { clientId = null } = {}) {
  return [
    ...(clientId ? [{ name: 'client_id', type: 'hidden', value: clientId }] : [{ name: 'client_id', label: 'Client involved', type: 'select', options: opts(clients, 'legal_name') }]),
    { name: 'occurred_at', label: 'When it happened', type: 'datetime', required: true },
    { name: 'type', label: 'Type', type: 'select', required: true, options: o(INCIDENT_TYPES) },
    { name: 'severity', label: 'Severity', type: 'select', required: true, options: o(['low', 'moderate', 'high', 'critical']) },
    { name: 'description', label: 'What happened (facts only)', type: 'textarea', required: true, full: true },
    { name: 'immediate_action', label: 'Immediate action taken', type: 'textarea', full: true },
    { name: 'notified', label: 'Who was notified', full: true },
  ];
}
export async function incidentDialog({ clients = [], clientId = null, shiftId = null, now }) {
  return formModal({
    title: 'Report an incident',
    intro: '<div class="notice danger">If anyone is in immediate danger, call 911 first and follow emergency procedures.</div><br>',
    defs: incidentDefs(clients, { clientId }),
    values: { occurred_at: now },
    submitLabel: 'Submit report',
    submit: async (v) => {
      const r = await api.post('/incidents', { ...v, shift_id: shiftId });
      toast('Incident reported. Your supervisor has been alerted.', 'ok');
      return r;
    },
  });
}

export const TRANSITION_TYPES = [
  ['ed_visit', 'Emergency department visit'], ['hospital_admission', 'Hospital admission'], ['hospital_discharge', 'Hospital discharge'],
  ['return_home', 'Returned to facility / home'], ['temporary_absence', 'Temporary absence'], ['hospice_referral', 'Hospice referral'],
  ['hospice_evaluation', 'Hospice evaluation'], ['hospice_admission', 'Hospice enrollment / admission'], ['hospice_discharge', 'Hospice discharge / end of services'],
  ['facility_discharge', 'Discharged from our care'], ['deceased', 'Deceased'], ['care_plan_change', 'Care plan / service change'],
];
export function transitionDialog(clientId) {
  return formModal({
    title: 'Record care transition',
    intro: `<p class="hint">Hospitalization and hospice are tracked separately. A hospice <em>referral</em> does not mark the client as enrolled — record an enrollment only when the hospice confirms admission.</p>`,
    defs: [
      { name: 'event_type', label: 'Event', type: 'select', required: true, options: TRANSITION_TYPES },
      { name: 'event_date', label: 'Date', type: 'date', required: true },
      { name: 'location', label: 'Hospital / location' },
      { name: 'provider', label: 'Provider (e.g. hospice agency)' },
      { name: 'contact', label: 'Authorized contact' },
      { name: 'source', label: 'Source of information', required: true, placeholder: 'Discharge summary, phone call from…' },
      { name: 'status', label: 'Status' },
      { name: 'follow_up_due', label: 'Follow-up due', type: 'date' },
      { name: 'service_impact', label: 'Effect on schedule, services, billing', type: 'textarea', full: true, rows: 2 },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
      { name: 'cancel_shifts', label: 'Cancel scheduled shifts from this date (admission, absence, discharge, death)', type: 'checkbox', full: true },
    ],
    submit: async (v) => {
      const r = await api.post(`/clients/${clientId}/transitions`, v);
      toast(`Transition recorded.${r.upcoming_shifts ? ` ${r.upcoming_shifts} upcoming shift(s) affected${r.cancelled_shifts ? `, ${r.cancelled_shifts} cancelled` : ' — review the schedule'}.` : ''}`, 'ok');
      return r;
    },
  });
}

export { field };
