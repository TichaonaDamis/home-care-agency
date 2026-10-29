'use strict';
// Transparent, configurable trend indicator. Compares the most recent 7 days with the
// 30-day baseline before it, using only documented records. Every reason lists its evidence.
// Output is an aid for staff review — never a clinical conclusion.
const { addDays, round2 } = require('./util');
const { thresholdsFor, outOfRange } = require('./alerts');

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function computeTrend(db, settings, clientId, endDate) {
  const rules = settings.get('trend_rules');
  const recentFrom = addDays(endDate, -6);
  const baseFrom = addDays(endDate, -36);
  const baseTo = addDays(endDate, -7);
  const inRange = (from, to) => [clientId, from, to];
  const day = 'substr(recorded_at,1,10) BETWEEN ? AND ?';

  const q = (sql, from, to) => db.all(sql, inRange(from, to));
  const meals = (f, t) => q(`SELECT id, recorded_at, percent_consumed, fluid_ml, refused FROM meal_logs WHERE client_id = ? AND ${day}`, f, t);
  const obs = (f, t) => q(`SELECT id, recorded_at, pain_score, fall_event FROM observations WHERE client_id = ? AND ${day}`, f, t);
  const falls = (f, t) => q(`SELECT id, occurred_at AS recorded_at FROM incidents WHERE client_id = ? AND type = 'fall' AND substr(occurred_at,1,10) BETWEEN ? AND ?`, f, t);
  const meas = (f, t) => q(`SELECT id, type_code, value, value2, unit, measured_at AS recorded_at FROM measurements WHERE client_id = ? AND entered_in_error = 0 AND substr(measured_at,1,10) BETWEEN ? AND ?`, f, t);

  const R = { meals: meals(recentFrom, endDate), obs: obs(recentFrom, endDate), falls: falls(recentFrom, endDate), meas: meas(recentFrom, endDate) };
  const B = { meals: meals(baseFrom, baseTo), obs: obs(baseFrom, baseTo), falls: falls(baseFrom, baseTo), meas: meas(baseFrom, baseTo) };

  const reasons = [];
  const ev = (type, rows) => rows.slice(0, 20).map((r) => ({ type, id: r.id, at: r.recorded_at }));
  const add = (kind, text, evidence) => reasons.push({ kind, text, evidence });
  const metrics = {};

  // Meal intake (% consumed)
  const mR = avg(R.meals.filter((m) => m.percent_consumed != null).map((m) => m.percent_consumed));
  const mB = avg(B.meals.filter((m) => m.percent_consumed != null).map((m) => m.percent_consumed));
  metrics.meal_intake_pct = { recent: mR && round2(mR), baseline: mB && round2(mB) };
  if (mR != null && mB != null && mB > 0) {
    const drop = ((mB - mR) / mB) * 100;
    if (drop >= rules.mealIntakeDropPct) add('decline', `Average meal intake fell from ${Math.round(mB)}% to ${Math.round(mR)}%`, ev('meal_log', R.meals));
    else if (-drop >= rules.mealIntakeDropPct) add('improve', `Average meal intake rose from ${Math.round(mB)}% to ${Math.round(mR)}%`, ev('meal_log', R.meals));
  }

  // Fluid intake (average documented mL per day with records)
  const perDay = (rows) => {
    const d = {};
    for (const r of rows) if (r.fluid_ml != null) d[r.recorded_at.slice(0, 10)] = (d[r.recorded_at.slice(0, 10)] || 0) + r.fluid_ml;
    return avg(Object.values(d));
  };
  const fR = perDay(R.meals), fB = perDay(B.meals);
  metrics.fluid_ml_per_day = { recent: fR && Math.round(fR), baseline: fB && Math.round(fB) };
  if (fR != null && fB != null && fB > 0) {
    const drop = ((fB - fR) / fB) * 100;
    if (drop >= rules.fluidDropPct) add('decline', `Documented fluid intake fell from ~${Math.round(fB)} to ~${Math.round(fR)} mL/day`, ev('meal_log', R.meals.filter((m) => m.fluid_ml != null)));
    else if (-drop >= rules.fluidDropPct) add('improve', `Documented fluid intake rose from ~${Math.round(fB)} to ~${Math.round(fR)} mL/day`, ev('meal_log', R.meals));
  }

  // Pain (observation scores + pain measurements)
  const pains = (S) => [...S.obs.filter((o) => o.pain_score != null).map((o) => o.pain_score), ...S.meas.filter((m) => m.type_code === 'pain').map((m) => m.value)];
  const pR = avg(pains(R)), pB = avg(pains(B));
  metrics.pain_avg = { recent: pR && round2(pR), baseline: pB && round2(pB) };
  if (pR != null && pB != null) {
    if (pR - pB >= rules.painIncrease) add('decline', `Average documented pain rose from ${round2(pB)} to ${round2(pR)}`, ev('observation', R.obs.filter((o) => o.pain_score != null)));
    else if (pB - pR >= rules.painIncrease) add('improve', `Average documented pain fell from ${round2(pB)} to ${round2(pR)}`, ev('observation', R.obs));
  }

  // Falls (observations + incident reports), baseline normalised to 7 days
  const fallRowsR = [...R.obs.filter((o) => o.fall_event === 'fall'), ...R.falls];
  const fallsR = fallRowsR.length;
  const fallsB7 = ([...B.obs.filter((o) => o.fall_event === 'fall'), ...B.falls].length / 30) * 7;
  metrics.falls = { recent: fallsR, baseline_per_7d: round2(fallsB7) };
  if (fallsR > 0 && fallsR - fallsB7 >= rules.fallsIncrease) {
    add('decline', `${fallsR} fall(s) documented in the last 7 days (baseline ~${round2(fallsB7)} per 7 days)`, [...ev('observation', R.obs.filter((o) => o.fall_event === 'fall')), ...ev('incident', R.falls)]);
  }

  // Weight change: latest recent vs baseline average
  const wR = R.meas.filter((m) => m.type_code === 'weight').sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const wB = avg(B.meas.filter((m) => m.type_code === 'weight').map((m) => m.value));
  if (wR.length && wB) {
    const latest = wR[wR.length - 1];
    const pct = ((latest.value - wB) / wB) * 100;
    metrics.weight_change_pct = round2(pct);
    if (Math.abs(pct) >= rules.weightChangePct) {
      add(pct < 0 ? 'decline' : 'review', `Weight ${pct < 0 ? 'decreased' : 'increased'} ${Math.abs(round2(pct))}% vs. 30-day baseline (${round2(wB)} → ${latest.value} ${latest.unit})`, ev('measurement', [latest]));
    }
  }

  // Measurements outside approved thresholds in the recent window
  const abnormal = R.meas.filter((m) => outOfRange(thresholdsFor(db, clientId, m.type_code), m.value, m.value2).length);
  if (abnormal.length) add('review', `${abnormal.length} measurement(s) outside approved thresholds in the last 7 days`, ev('measurement', abnormal));

  // Unresolved high-severity alerts or open incidents
  const openHigh = db.all(`SELECT id, created_at AS recorded_at FROM alerts WHERE client_id = ? AND severity = 'high' AND status <> 'resolved'`, [clientId]);
  if (openHigh.length) add('review', `${openHigh.length} unresolved high-severity alert(s)`, ev('alert', openHigh));

  const recordCount = R.meals.length + R.obs.length + R.meas.length;
  metrics.recent_records = recordCount;
  metrics.baseline_records = B.meals.length + B.obs.length + B.meas.length;

  let indicator;
  const has = (k) => reasons.some((r) => r.kind === k);
  if (has('review')) indicator = 'requires_review';
  else if (has('decline')) indicator = 'possible_decline';
  else if (recordCount < rules.minRecords || metrics.baseline_records < rules.minRecords) indicator = 'insufficient_data';
  else if (reasons.filter((r) => r.kind === 'improve').length >= 2) indicator = 'improving';
  else indicator = 'stable';
  if (indicator === 'stable' && !reasons.length) reasons.push({ kind: 'stable', text: 'No configured change thresholds were met', evidence: [] });
  if (indicator === 'insufficient_data') reasons.push({ kind: 'info', text: `Only ${recordCount} recent and ${metrics.baseline_records} baseline records (minimum ${rules.minRecords} each)`, evidence: [] });

  return {
    indicator, reasons, metrics,
    windows: { recent: [recentFrom, endDate], baseline: [baseFrom, baseTo] },
    disclaimer: 'Automated indicator based on documented records and configurable rules. It is not a clinical assessment and does not replace professional judgment.',
  };
}

module.exports = { computeTrend };
