'use strict';
// Client timeline and period summaries built only from documented records.
const { round2 } = require('./util');

const label = (s) => String(s || '').replace(/_/g, ' ');

function timeline(db, clientId, from, to, { limit = 500 } = {}) {
  const p = [clientId, from, to];
  const day = (col) => `substr(${col},1,10) BETWEEN ? AND ?`;
  const ev = [];
  for (const m of db.all(`SELECT m.*, t.name FROM measurements m JOIN measurement_types t ON t.code = m.type_code
      WHERE m.client_id = ? AND m.entered_in_error = 0 AND ${day('m.measured_at')}`, p)) {
    ev.push({ at: m.measured_at, kind: 'measurement', title: `${m.name}: ${m.value2 != null ? `${m.value}/${m.value2}` : m.value} ${m.unit}`, detail: m.symptoms || m.follow_up || '', ref: { type: 'measurement', id: m.id } });
  }
  for (const r of db.all(`SELECT substr(recorded_at,1,10) d, COUNT(*) n, AVG(percent_consumed) pct, SUM(fluid_ml) ml, SUM(refused) refused
      FROM meal_logs WHERE client_id = ? AND ${day('recorded_at')} GROUP BY d`, p)) {
    ev.push({ at: `${r.d}T23:59`, kind: 'intake', title: `Intake: ${r.n} entr${r.n === 1 ? 'y' : 'ies'}${r.pct != null ? `, avg ${Math.round(r.pct)}% eaten` : ''}${r.ml != null ? `, ${r.ml} mL fluids` : ''}`, detail: r.refused ? `${r.refused} refused` : '', ref: { type: 'meal_day', id: null } });
  }
  for (const o of db.all(`SELECT * FROM observations WHERE client_id = ? AND ${day('recorded_at')}`, p)) {
    const bits = [o.mood && `mood ${label(o.mood)}`, o.alertness && label(o.alertness), o.sleep && `sleep ${o.sleep}`,
      o.pain_score != null && `pain ${o.pain_score}/10`, o.agitation && 'agitation', o.distress && 'distress', o.fall_event !== 'none' && label(o.fall_event), o.skin_change && 'skin change'].filter(Boolean);
    ev.push({ at: o.recorded_at, kind: 'observation', title: `Observation: ${bits.join(', ') || 'recorded'}`, detail: o.observation || '', ref: { type: 'observation', id: o.id } });
  }
  for (const a of db.all(`SELECT * FROM activity_logs WHERE client_id = ? AND ${day('recorded_at')}`, p)) {
    ev.push({ at: a.recorded_at, kind: 'activity', title: `Activity: ${a.activity}${a.minutes ? ` (${a.minutes} min)` : ''}${a.participation ? `, ${a.participation}` : ''}`, detail: a.notes || '', ref: { type: 'activity', id: a.id } });
  }
  for (const c of db.all(`SELECT mc.*, m.name FROM medication_changes mc JOIN medications m ON m.id = mc.medication_id
      WHERE mc.client_id = ? AND mc.effective_date BETWEEN ? AND ?`, p)) {
    ev.push({ at: `${c.effective_date}T00:00`, kind: 'med_change', title: `Medication ${label(c.change_type)}: ${c.name}`, detail: [c.previous_value && `from ${c.previous_value}`, c.new_value && `to ${c.new_value}`, c.verified ? 'verified' : 'NOT verified'].filter(Boolean).join(' · '), ref: { type: 'medication_change', id: c.id } });
  }
  for (const i of db.all(`SELECT * FROM incidents WHERE client_id = ? AND ${day('occurred_at')}`, p)) {
    ev.push({ at: i.occurred_at, kind: 'incident', title: `Incident: ${label(i.type)} (${i.severity})`, detail: `${i.status}`, ref: { type: 'incident', id: i.id } });
  }
  for (const t of db.all('SELECT * FROM transitions WHERE client_id = ? AND event_date BETWEEN ? AND ?', p)) {
    ev.push({ at: `${t.event_date}T00:00`, kind: 'transition', title: `Care transition: ${label(t.event_type)}`, detail: [t.location, t.provider, t.notes].filter(Boolean).join(' · '), ref: { type: 'transition', id: t.id } });
  }
  for (const c of db.all('SELECT * FROM care_plans WHERE client_id = ? AND effective_date BETWEEN ? AND ?', p)) {
    ev.push({ at: `${c.effective_date}T00:00`, kind: 'care_plan', title: `Care plan version ${c.version} effective`, detail: c.summary || '', ref: { type: 'care_plan', id: c.id } });
  }
  for (const r of db.all(`SELECT * FROM progress_reviews WHERE client_id = ? AND ${day('created_at')}`, p)) {
    ev.push({ at: r.created_at.slice(0, 16), kind: 'review', title: `Staff review: ${label(r.assessment)}`, detail: r.summary, ref: { type: 'review', id: r.id } });
  }
  ev.sort((a, b) => b.at.localeCompare(a.at));
  return ev.slice(0, limit);
}

function periodSummary(db, clientId, from, to) {
  const p = [clientId, from, to];
  const day = (col) => `substr(${col},1,10) BETWEEN ? AND ?`;
  const meals = db.get(`SELECT COUNT(*) n, AVG(percent_consumed) pct, SUM(refused) refused, SUM(swallowing_issue) swallow,
      SUM(CASE WHEN appetite IN ('decreased','poor') THEN 1 ELSE 0 END) low_appetite
      FROM meal_logs WHERE client_id = ? AND meal <> 'fluids_only' AND ${day('recorded_at')}`, p);
  const fl = db.all(`SELECT substr(recorded_at,1,10) d, SUM(fluid_ml) ml FROM meal_logs WHERE client_id = ? AND fluid_ml IS NOT NULL AND ${day('recorded_at')} GROUP BY d`, p);
  const act = db.get(`SELECT COUNT(*) n, SUM(minutes) minutes, SUM(CASE WHEN participation = 'declined' THEN 1 ELSE 0 END) declined FROM activity_logs WHERE client_id = ? AND ${day('recorded_at')}`, p);
  const adl = db.all(`SELECT status, COUNT(*) n FROM adl_logs WHERE client_id = ? AND ${day('recorded_at')} GROUP BY status`, p);
  const obs = db.get(`SELECT COUNT(*) n, AVG(pain_score) pain, SUM(agitation) agitation, SUM(distress) distress,
      SUM(CASE WHEN sleep = 'poor' THEN 1 ELSE 0 END) poor_sleep, SUM(CASE WHEN fall_event = 'fall' THEN 1 ELSE 0 END) falls,
      SUM(CASE WHEN fall_event = 'near_fall' THEN 1 ELSE 0 END) near_falls, SUM(skin_change) skin,
      SUM(CASE WHEN alertness IN ('alert_confused','drowsy','difficult_to_rouse') THEN 1 ELSE 0 END) reduced_alertness
      FROM observations WHERE client_id = ? AND ${day('recorded_at')}`, p);
  const moods = db.all(`SELECT mood, COUNT(*) n FROM observations WHERE client_id = ? AND mood IS NOT NULL AND ${day('recorded_at')} GROUP BY mood ORDER BY n DESC`, p);
  const measurements = {};
  for (const t of db.all('SELECT code, name, unit FROM measurement_types ORDER BY sort')) {
    const rows = db.all(`SELECT id, value, value2, measured_at FROM measurements WHERE client_id = ? AND type_code = ? AND entered_in_error = 0
      AND ${day('measured_at')} ORDER BY measured_at`, [clientId, t.code, from, to]);
    if (!rows.length) continue;
    const vals = rows.map((r) => r.value);
    measurements[t.code] = {
      name: t.name, unit: t.unit, count: rows.length, first: rows[0], last: rows[rows.length - 1],
      min: Math.min(...vals), max: Math.max(...vals), avg: round2(vals.reduce((a, b) => a + b, 0) / vals.length),
      series: rows.map((r) => ({ at: r.measured_at, v: r.value, v2: r.value2 })),
    };
  }
  const count = (sql) => db.get(sql, p).n;
  return {
    period: { from, to },
    meals: { entries: meals.n, avg_pct_consumed: meals.pct != null ? Math.round(meals.pct) : null, refused: meals.refused || 0, swallowing_issues: meals.swallow || 0, low_appetite: meals.low_appetite || 0 },
    fluids: { days_recorded: fl.length, avg_ml_per_recorded_day: fl.length ? Math.round(fl.reduce((a, b) => a + b.ml, 0) / fl.length) : null },
    activities: { entries: act.n, minutes: act.minutes || 0, declined: act.declined || 0 },
    adl: Object.fromEntries(adl.map((r) => [r.status, r.n])),
    observations: {
      entries: obs.n, pain_avg: obs.pain != null ? round2(obs.pain) : null, agitation: obs.agitation || 0, distress: obs.distress || 0,
      poor_sleep: obs.poor_sleep || 0, falls: obs.falls || 0, near_falls: obs.near_falls || 0, skin_changes: obs.skin || 0,
      reduced_alertness: obs.reduced_alertness || 0, moods,
    },
    measurements,
    incidents: count(`SELECT COUNT(*) n FROM incidents WHERE client_id = ? AND ${day('occurred_at')}`),
    med_changes: count('SELECT COUNT(*) n FROM medication_changes WHERE client_id = ? AND effective_date BETWEEN ? AND ?'),
    transitions: count('SELECT COUNT(*) n FROM transitions WHERE client_id = ? AND event_date BETWEEN ? AND ?'),
  };
}

module.exports = { timeline, periodSummary };
