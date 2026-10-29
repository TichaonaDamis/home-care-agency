'use strict';
// Rule-based alerts. Every alert describes the documented facts that triggered it and points
// staff to the approved escalation instructions. Alerts never state a diagnosis or cause.
const { addDays } = require('./util');

const DEFAULT_ESCALATION = 'Re-check the reading and follow your facility escalation policy. Notify the supervisor or responsible clinician. If the client shows signs of an emergency, call 911.';

function createAlert(db, a) {
  const r = db.run(`INSERT OR IGNORE INTO alerts (client_id, category, severity, message, escalation, source_type, source_id, dedupe_key)
    VALUES (?,?,?,?,?,?,?,?)`, [a.client_id ?? null, a.category, a.severity, a.message, a.escalation ?? null,
    a.source_type ?? null, a.source_id ?? null, a.dedupe_key ?? null]);
  return r.changes ? r.id : null;
}

/** Thresholds for a client/measurement: individualized values override facility defaults. */
function thresholdsFor(db, clientId, typeCode) {
  const t = db.get('SELECT * FROM measurement_types WHERE code = ?', [typeCode]);
  const c = db.get('SELECT * FROM client_thresholds WHERE client_id = ? AND type_code = ?', [clientId, typeCode]);
  return {
    type: t,
    low: c?.low ?? t.default_low, high: c?.high ?? t.default_high,
    low2: c?.low2 ?? t.default_low2, high2: c?.high2 ?? t.default_high2,
    escalation: c?.escalation || null,
    individualized: !!c,
    expected_every_days: c?.expected_every_days ?? t.expected_every_days,
  };
}

function outOfRange(th, value, value2) {
  const out = [];
  if (th.low != null && value < th.low) out.push(`below ${th.low}`);
  if (th.high != null && value > th.high) out.push(`above ${th.high}`);
  if (value2 != null) {
    if (th.low2 != null && value2 < th.low2) out.push(`second value below ${th.low2}`);
    if (th.high2 != null && value2 > th.high2) out.push(`second value above ${th.high2}`);
  }
  return out;
}

function onMeasurement(db, m) {
  const th = thresholdsFor(db, m.client_id, m.type_code);
  const issues = outOfRange(th, m.value, m.value2);
  if (!issues.length) return null;
  const shown = m.value2 != null ? `${m.value}/${m.value2}` : `${m.value}`;
  return createAlert(db, {
    client_id: m.client_id, category: 'measurement', severity: 'high', source_type: 'measurement', source_id: m.id,
    dedupe_key: `meas:${m.id}`,
    message: `${th.type.name} recorded ${shown} ${m.unit} (${issues.join(', ')}; ${th.individualized ? 'client-specific' : 'facility default'} threshold). A single reading does not establish health status — verify and follow up.`,
    escalation: th.escalation || DEFAULT_ESCALATION,
  });
}

function onMealLog(db, settings, meal) {
  const rules = settings.get('trend_rules');
  const day = meal.recorded_at.slice(0, 10);
  const from = addDays(day, -(rules.missedMealsWindowDays - 1));
  const row = db.get(`SELECT COUNT(*) n FROM meal_logs WHERE client_id = ? AND meal <> 'fluids_only'
      AND substr(recorded_at,1,10) BETWEEN ? AND ? AND (refused = 1 OR percent_consumed <= 25)`, [meal.client_id, from, day]);
  if (row.n >= rules.missedMealsCount) {
    createAlert(db, {
      client_id: meal.client_id, category: 'nutrition', severity: 'medium', source_type: 'meal_log', source_id: meal.id,
      dedupe_key: `meals:${meal.client_id}:${day}`,
      message: `${row.n} meals refused or ≤25% eaten between ${from} and ${day}. Review intake records and notify the supervisor.`,
    });
  }
  if (meal.swallowing_issue) {
    createAlert(db, {
      client_id: meal.client_id, category: 'nutrition', severity: 'high', source_type: 'meal_log', source_id: meal.id,
      dedupe_key: `swallow:${meal.id}`,
      message: 'Difficulty chewing or swallowing documented. Follow the care plan and notify the supervisor or clinician.',
      escalation: 'If the client is choking or struggling to breathe, call 911 immediately.',
    });
  }
}

function onObservation(db, o) {
  if (o.fall_event === 'fall' || o.fall_event === 'near_fall') {
    createAlert(db, {
      client_id: o.client_id, category: 'fall', severity: o.fall_event === 'fall' ? 'high' : 'medium',
      source_type: 'observation', source_id: o.id, dedupe_key: `obsfall:${o.id}`,
      message: `${o.fall_event === 'fall' ? 'Fall' : 'Near-fall'} documented on ${o.recorded_at.replace('T', ' ')}. Complete an incident report if not already done.`,
    });
  }
  if (o.alertness === 'difficult_to_rouse') {
    createAlert(db, {
      client_id: o.client_id, category: 'condition_change', severity: 'high', source_type: 'observation', source_id: o.id,
      dedupe_key: `obsalert:${o.id}`, message: 'Client documented as difficult to rouse.',
      escalation: 'This may be an emergency. Follow emergency procedures and call 911 if indicated.',
    });
  }
  if (o.pain_score != null && o.pain_score >= 7) {
    createAlert(db, {
      client_id: o.client_id, category: 'pain', severity: 'medium', source_type: 'observation', source_id: o.id,
      dedupe_key: `obspain:${o.id}`, message: `Pain score ${o.pain_score}/10 documented. Notify the supervisor per care plan.`,
    });
  }
}

function onMedEvent(db, e, medName) {
  if (!['refused', 'omitted', 'discrepancy'].includes(e.action) && !e.adverse_observation) return;
  createAlert(db, {
    client_id: e.client_id, category: 'medication', severity: e.action === 'discrepancy' || e.adverse_observation ? 'high' : 'medium',
    source_type: 'med_event', source_id: e.id, dedupe_key: `medevt:${e.id}`,
    message: `Medication ${e.action}${e.adverse_observation ? ' with documented observation' : ''}: ${medName}. Supervisor review required.`,
  });
}

function onIncident(db, i) {
  const sev = { low: 'low', moderate: 'medium', high: 'high', critical: 'high' }[i.severity];
  createAlert(db, {
    client_id: i.client_id, category: 'incident', severity: sev, source_type: 'incident', source_id: i.id,
    dedupe_key: `incident:${i.id}`, message: `Incident reported (${i.type.replace(/_/g, ' ')}, ${i.severity}). Review and document follow-up.`,
  });
}

function onTransition(db, t, upcomingShifts) {
  if (['hospital_admission', 'temporary_absence', 'ed_visit', 'deceased', 'facility_discharge'].includes(t.event_type)) {
    createAlert(db, {
      client_id: t.client_id, category: 'transition', severity: 'medium', source_type: 'transition', source_id: t.id,
      dedupe_key: `transition:${t.id}`,
      message: `${t.event_type.replace(/_/g, ' ')} on ${t.event_date}. ${upcomingShifts} scheduled shift(s) on or after this date should be reviewed; do not bill services that were not delivered.`,
    });
  }
  if (t.event_type === 'hospital_discharge' && t.follow_up_due) {
    createAlert(db, {
      client_id: t.client_id, category: 'transition', severity: 'medium', source_type: 'transition', source_id: t.id,
      dedupe_key: `dcfollow:${t.id}`, message: `Hospital discharge ${t.event_date}: post-discharge follow-up due ${t.follow_up_due}. Review care plan and medication list.`,
    });
  }
}

const lastSweep = new WeakMap();

/**
 * Sweep for conditions that depend on a full day of data. Idempotent via dedupe keys and
 * throttled to once every 5 minutes per database unless `force` is set.
 */
function sweep(db, settings, { force = false } = {}) {
  if (!force && Date.now() - (lastSweep.get(db) || 0) < 5 * 60e3) return;
  lastSweep.set(db, Date.now());
  const today = settings.today();
  const yesterday = addDays(today, -1);
  for (const c of db.all(`SELECT id, min_fluid_ml FROM clients WHERE status = 'active' AND min_fluid_ml IS NOT NULL`)) {
    const r = db.get(`SELECT COUNT(*) n, SUM(fluid_ml) total FROM meal_logs WHERE client_id = ? AND substr(recorded_at,1,10) = ? AND fluid_ml IS NOT NULL`, [c.id, yesterday]);
    if (r.n > 0 && r.total < c.min_fluid_ml) {
      createAlert(db, {
        client_id: c.id, category: 'hydration', severity: 'medium', dedupe_key: `fluid:${c.id}:${yesterday}`,
        message: `Documented fluid intake on ${yesterday} was ${r.total} mL, below the care-plan minimum of ${c.min_fluid_ml} mL. Intake may be under-documented — review records.`,
      });
    }
  }
  const { computeTrend } = require('./trends');
  for (const c of db.all(`SELECT id FROM clients WHERE status IN ('active','temporarily_away')`)) {
    const t = computeTrend(db, settings, c.id, today);
    if (t.indicator === 'possible_decline' || t.indicator === 'requires_review') {
      createAlert(db, {
        client_id: c.id, category: 'trend', severity: 'medium', dedupe_key: `trend:${c.id}:${today}`,
        message: `Automated indicator: ${t.indicator.replace(/_/g, ' ')} — ${t.reasons.map((r) => r.text).join('; ')}. Staff review needed; this is not a clinical conclusion.`,
      });
    }
  }
}

module.exports = { createAlert, thresholdsFor, outOfRange, onMeasurement, onMealLog, onObservation, onMedEvent, onIncident, onTransition, sweep, DEFAULT_ESCALATION };
