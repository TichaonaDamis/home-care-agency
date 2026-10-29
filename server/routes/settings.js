'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { HttpError } = require('../lib/util');
const { validate, idParam } = require('../lib/validate');
const { requirePerm } = require('../lib/auth');
const { audit } = require('../lib/core');
const { importLegacy } = require('../lib/legacy');

const EDITABLE = {
  agency_name: { type: 'string', max: 120 },
  timezone: { type: 'string', max: 60 },
  session_idle_minutes: { type: 'int', min: 5, max: 240 },
  session_max_hours: { type: 'int', min: 1, max: 24 },
  clock_in_early_minutes: { type: 'int', min: 0, max: 240 },
  clock_in_late_minutes: { type: 'int', min: 0, max: 720 },
  weekly_ot_threshold: { type: 'number', min: 0, max: 168 },
  daily_ot_threshold: { type: 'number', min: 0, max: 24 },
  credential_warning_days: { type: 'int', min: 0, max: 365 },
  invoice_due_days: { type: 'int', min: 0, max: 365 },
};

module.exports = ({ db, settings }) => {
  const r = express.Router();
  const admin = requirePerm('settings.manage');

  r.get('/settings', (req, res) => {
    const all = settings.all();
    res.json({
      ...all,
      facilities: db.all('SELECT * FROM facilities ORDER BY name'),
      categories: db.all('SELECT * FROM client_categories ORDER BY name'),
      service_types: db.all('SELECT * FROM service_types ORDER BY name'),
      measurement_types: db.all('SELECT * FROM measurement_types ORDER BY sort'),
    });
  });

  r.put('/settings', admin, (req, res) => {
    const v = validate(EDITABLE, req.body, { partial: true });
    if (v.timezone) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: v.timezone }); } catch { throw new HttpError(400, 'Unknown time zone.', { timezone: 'Use an IANA name such as America/Chicago' }); }
    }
    const before = settings.all();
    for (const [k, val] of Object.entries(v)) if (val !== null) settings.set(k, val);
    for (const key of ['trend_rules', 'notifications']) {
      if (req.body[key] && typeof req.body[key] === 'object') {
        const merged = { ...settings.get(key) };
        for (const [k, val] of Object.entries(req.body[key])) {
          if (!(k in merged)) continue;
          const n = Number(val);
          if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `Invalid value for ${k}.`);
          merged[k] = n;
        }
        settings.set(key, merged);
      }
    }
    if (Array.isArray(req.body.expense_categories)) {
      settings.set('expense_categories', req.body.expense_categories.map((s) => String(s).trim().slice(0, 60)).filter(Boolean));
    }
    audit(db, req, 'update', 'settings', null, { before, after: settings.all() });
    res.json({ ok: true });
  });

  // ----- reference lists -----
  const list = (table, schema, entity) => {
    r.post(`/${entity}`, admin, (req, res) => {
      const id = db.insert(table, validate(schema, req.body));
      audit(db, req, 'create', table, id);
      res.status(201).json({ id });
    });
    r.patch(`/${entity}/:id`, admin, (req, res) => {
      const id = idParam(req.params.id);
      const v = validate(schema, req.body, { partial: true });
      if (!db.update(table, id, v)) throw new HttpError(404, 'Not found.');
      audit(db, req, 'update', table, id, { after: v });
      res.json({ ok: true });
    });
  };
  list('facilities', {
    name: { type: 'string', required: true, max: 120 },
    kind: { type: 'enum', values: ['afh', 'home_care', 'assisted_living', 'residential', 'other'], default: 'afh' },
    address: { type: 'string', max: 300 }, phone: { type: 'string', max: 40 }, capacity: { type: 'int', min: 0, max: 10000 },
    active: { type: 'bool', default: 1 },
  }, 'facilities');
  list('client_categories', { name: { type: 'string', required: true, max: 80 }, active: { type: 'bool', default: 1 } }, 'categories');
  list('service_types', {
    code: { type: 'string', required: true, max: 10 }, name: { type: 'string', required: true, max: 100 }, active: { type: 'bool', default: 1 },
  }, 'service-types');

  r.patch('/measurement-types/:code', admin, (req, res) => {
    const v = validate({
      name: { type: 'string', max: 80 }, unit: { type: 'string', max: 20 },
      default_low: { type: 'number' }, default_high: { type: 'number' }, default_low2: { type: 'number' }, default_high2: { type: 'number' },
      caregiver_may_record: { type: 'bool' }, expected_every_days: { type: 'int', min: 1, max: 365 }, active: { type: 'bool' },
    }, req.body, { partial: true });
    const cols = Object.keys(v);
    if (!cols.length) return res.json({ ok: true });
    const n = db.run(`UPDATE measurement_types SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE code = ?`, [...cols.map((c) => v[c]), req.params.code]).changes;
    if (!n) throw new HttpError(404, 'Not found.');
    audit(db, req, 'update', 'measurement_type', null, { after: v, note: req.params.code });
    res.json({ ok: true });
  });
  r.post('/measurement-types', admin, (req, res) => {
    const v = validate({
      code: { type: 'string', required: true, max: 20 }, name: { type: 'string', required: true, max: 80 }, unit: { type: 'string', required: true, max: 20 },
      default_low: { type: 'number' }, default_high: { type: 'number' }, caregiver_may_record: { type: 'bool', default: 0 },
      expected_every_days: { type: 'int', min: 1, max: 365 },
    }, req.body);
    if (!/^[a-z0-9_]+$/.test(v.code)) throw new HttpError(400, 'Code must be lowercase letters, digits or underscore.');
    db.insert('measurement_types', { ...v, sort: 100 });
    audit(db, req, 'create', 'measurement_type', null, { note: v.code });
    res.status(201).json({ code: v.code });
  });

  // ----- audit log -----
  r.get('/audit', requirePerm('audit.view'), (req, res) => {
    const where = [];
    const p = [];
    if (req.query.entity) { where.push('entity = ?'); p.push(String(req.query.entity)); }
    if (req.query.user) { where.push('username = ?'); p.push(String(req.query.user)); }
    if (req.query.action) { where.push('action = ?'); p.push(String(req.query.action)); }
    if (req.query.client_id) { where.push('client_id = ?'); p.push(idParam(req.query.client_id)); }
    if (req.query.from) { where.push('at >= ?'); p.push(String(req.query.from)); }
    if (req.query.to) { where.push('at < ?'); p.push(`${req.query.to}T23:59:59.999Z`); }
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    res.json(db.all(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`, p));
  });

  // ----- backup & legacy import -----
  r.get('/backup', admin, (req, res) => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'carehours-')), 'backup.sqlite');
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    audit(db, req, 'export', 'database_backup');
    res.download(tmp, `carehours-backup-${settings.today()}.sqlite`, () => fs.rm(path.dirname(tmp), { recursive: true, force: true }, () => {}));
  });

  r.post('/import/legacy', admin, (req, res) => {
    const result = db.tx(() => importLegacy(db, settings, req.body, req.user.id));
    audit(db, req, 'import', 'legacy_backup', null, { note: JSON.stringify(result) });
    res.json(result);
  });

  return r;
};
