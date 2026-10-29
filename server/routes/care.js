'use strict';
const express = require('express');
const { HttpError, nowLocal } = require('../lib/util');
const { validate, idParam } = require('../lib/validate');
const { requirePerm, can } = require('../lib/auth');
const { audit, assertClientAccess, assertShiftForCaregiver } = require('../lib/core');
const alerts = require('../lib/alerts');

const ADL_STATUS = ['completed', 'partial', 'declined', 'not_applicable', 'not_completed'];
const BASE = { client_id: { type: 'id', required: true }, shift_id: { type: 'id' }, recorded_at: { type: 'datetime' } };

const SCHEMAS = {
  meals: {
    table: 'meal_logs', entity: 'meal_log',
    schema: {
      ...BASE, meal: { type: 'enum', values: ['breakfast', 'lunch', 'dinner', 'snack', 'fluids_only'], required: true },
      offered: { type: 'string', max: 300 }, percent_consumed: { type: 'int', min: 0, max: 100 }, fluid_ml: { type: 'int', min: 0, max: 5000 },
      appetite: { type: 'enum', values: ['usual', 'increased', 'decreased', 'poor'] }, swallowing_issue: { type: 'bool' }, refused: { type: 'bool' },
      assistance: { type: 'enum', values: ['none', 'setup', 'partial', 'full'] }, notes: { type: 'text', max: 2000 },
    },
  },
  activities: {
    table: 'activity_logs', entity: 'activity_log',
    schema: {
      ...BASE, activity: { type: 'string', required: true, max: 120 }, minutes: { type: 'int', min: 0, max: 1440 },
      participation: { type: 'enum', values: ['active', 'partial', 'passive', 'declined'] }, tolerance: { type: 'enum', values: ['good', 'fair', 'poor'] },
      notes: { type: 'text', max: 2000 },
    },
  },
  observations: {
    table: 'observations', entity: 'observation',
    schema: {
      ...BASE,
      mood: { type: 'enum', values: ['calm', 'content', 'cheerful', 'withdrawn', 'sad', 'irritable', 'anxious', 'other'] },
      alertness: { type: 'enum', values: ['alert_oriented', 'alert_confused', 'drowsy', 'difficult_to_rouse'] },
      sleep: { type: 'enum', values: ['good', 'fair', 'poor', 'not_observed'] },
      agitation: { type: 'bool' }, distress: { type: 'bool' }, pain_score: { type: 'int', min: 0, max: 10 },
      energy: { type: 'enum', values: ['usual', 'increased', 'decreased'] },
      fall_event: { type: 'enum', values: ['none', 'near_fall', 'fall'], default: 'none' }, skin_change: { type: 'bool' },
      other_change: { type: 'text', max: 1000 }, observation: { type: 'text', max: 4000 }, action_taken: { type: 'text', max: 2000 }, notified: { type: 'string', max: 200 },
    },
  },
};

module.exports = ({ db, settings }) => {
  const r = express.Router();
  const doc = requirePerm('care.document');
  const now = () => nowLocal(settings.get('timezone'));

  /** Shared checks for every documentation entry. */
  function prepare(req, v) {
    assertClientAccess(db, settings, req, v.client_id);
    assertShiftForCaregiver(db, req, v.shift_id, v.client_id);
    if (v.shift_id && req.user.role !== 'caregiver') {
      const s = db.get('SELECT client_id FROM shifts WHERE id = ?', [v.shift_id]);
      if (!s || s.client_id !== v.client_id) throw new HttpError(400, 'Shift does not belong to this client.');
    }
    const t = now();
    v.recorded_at = v.recorded_at || t;
    if (v.recorded_at > t) throw new HttpError(400, 'Time cannot be in the future.', { recorded_at: 'In the future' });
    return { ...v, author_id: req.user.id };
  }

  // ADL tasks: accepts several tasks at once.
  r.post('/care/adl', doc, (req, res) => {
    const v = validate(BASE, req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) throw new HttpError(400, 'Add at least one task.');
    const base = prepare(req, v);
    const ids = db.tx(() => items.map((it) => {
      const x = validate({ task: { type: 'string', required: true, max: 120 }, status: { type: 'enum', values: ADL_STATUS, required: true }, notes: { type: 'text', max: 1000 } }, it);
      if (['declined', 'not_completed', 'partial'].includes(x.status) && !x.notes) throw new HttpError(400, `Add a note explaining why "${x.task}" was ${x.status.replace('_', ' ')}.`);
      // Replace an earlier entry for the same task on the same shift (corrections).
      if (base.shift_id) db.run('DELETE FROM adl_logs WHERE shift_id = ? AND lower(task) = lower(?) AND author_id = ?', [base.shift_id, x.task, req.user.id]);
      return db.insert('adl_logs', { ...base, ...x });
    }));
    audit(db, req, 'create', 'adl_log', null, { clientId: v.client_id, note: `${ids.length} task(s)` });
    res.status(201).json({ ids });
  });

  for (const [path, def] of Object.entries(SCHEMAS)) {
    r.post(`/care/${path}`, doc, (req, res) => {
      const row = prepare(req, validate(def.schema, req.body));
      if (path === 'observations' && (row.fall_event !== 'none' || row.agitation || row.distress || row.skin_change) && !row.observation) {
        throw new HttpError(400, 'Describe what you observed (objective description).', { observation: 'Required for this entry' });
      }
      const id = db.insert(def.table, row);
      const saved = { ...row, id };
      if (path === 'meals') alerts.onMealLog(db, settings, saved);
      if (path === 'observations') alerts.onObservation(db, saved);
      audit(db, req, 'create', def.entity, id, { clientId: row.client_id });
      res.status(201).json({ id });
    });
  }

  /**
   * Unified log listing. Staff with care.view see all; caregivers see only entries they authored.
   */
  r.get('/care/logs', (req, res) => {
    const isCg = req.user.role === 'caregiver';
    if (!isCg && !can(req.user, 'care.view')) throw new HttpError(403, 'You do not have permission to do that.');
    const types = String(req.query.types || 'adl,meals,activities,observations').split(',');
    const from = req.query.from || '0000-01-01';
    const to = req.query.to || '9999-12-31';
    const out = [];
    const tables = { adl: 'adl_logs', meals: 'meal_logs', activities: 'activity_logs', observations: 'observations' };
    for (const t of types) {
      const table = tables[t];
      if (!table) continue;
      const where = ['substr(l.recorded_at,1,10) BETWEEN ? AND ?'];
      const p = [from, to];
      if (req.query.client_id) { where.push('l.client_id = ?'); p.push(idParam(req.query.client_id)); }
      if (req.query.shift_id) { where.push('l.shift_id = ?'); p.push(idParam(req.query.shift_id)); }
      if (isCg) { where.push('l.author_id = ?'); p.push(req.user.id); }
      if (req.query.caregiver_id && !isCg) { where.push('s.caregiver_id = ?'); p.push(idParam(req.query.caregiver_id)); }
      for (const row of db.all(`SELECT l.*, c.legal_name AS client_name, u.display_name AS author FROM ${table} l
          JOIN clients c ON c.id = l.client_id JOIN users u ON u.id = l.author_id LEFT JOIN shifts s ON s.id = l.shift_id
          WHERE ${where.join(' AND ')} ORDER BY l.recorded_at DESC LIMIT 1000`, p)) out.push({ type: t, ...row });
    }
    out.sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
    res.json(out.slice(0, 2000));
  });

  return r;
};
