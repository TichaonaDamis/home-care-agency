'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { allocateOvertime } = require('../server/lib/finance');
const { validate } = require('../server/lib/validate');
const { minutesBetween, schedMinutes, workedHours, weekStart, monthRange } = require('../server/lib/util');
const { passwordProblem } = require('../server/lib/auth');
const { dosesInWindow } = require('../server/lib/shiftdocs');
const { importLegacy } = require('../server/lib/legacy');
const { openDb } = require('../server/db');
const { createSettings } = require('../server/lib/core');

const shift = (id, date, start, end) => ({ id, date, actual_start: `${date}T${start}`, actual_end: `${date}T${end}`, break_min: 0 });

test('overtime: weekly 40 hours', () => {
  // Mon–Fri 9 h/day = 45 h → 5 h OT on Friday.
  const s = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map((d, i) => shift(i + 1, d, '08:00', '17:00'));
  const a = allocateOvertime(s, 'weekly40');
  assert.equal(a.get(4).overtime, 0);
  assert.equal(a.get(5).regular, 4);
  assert.equal(a.get(5).overtime, 5);
});

test('overtime: daily 8 + weekly 40 does not double count', () => {
  const s = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map((d, i) => shift(i + 1, d, '08:00', '18:00')); // 10 h/day
  const a = allocateOvertime(s, 'daily8_weekly40');
  const tot = [...a.values()].reduce((t, x) => ({ r: t.r + x.regular, o: t.o + x.overtime }), { r: 0, o: 0 });
  assert.equal(tot.r + tot.o, 50);
  assert.equal(tot.r, 40);
  assert.equal(tot.o, 10);
});

test('overtime: weeks reset on Monday and exempt workers get none', () => {
  const s = [shift(1, '2026-10-04', '00:00', '23:00'), shift(2, '2026-10-04', '23:00', '23:59'), shift(3, '2026-10-05', '00:00', '20:00'), shift(4, '2026-10-06', '00:00', '22:00')];
  const a = allocateOvertime(s, 'weekly40');
  assert.equal(a.get(3).overtime, 0, 'Sunday hours belong to the previous week');
  assert.equal(a.get(4).overtime, 2);
  assert.ok([...allocateOvertime(s, 'none').values()].every((x) => x.overtime === 0));
});

test('time helpers handle overnight shifts and breaks', () => {
  assert.equal(minutesBetween('2026-10-05T22:00', '2026-10-06T06:00'), 480);
  assert.equal(schedMinutes('22:00', '06:00'), 480);
  assert.equal(workedHours({ actual_start: '2026-10-05T22:00', actual_end: '2026-10-06T06:00', break_min: 30 }), 7.5);
  assert.equal(workedHours({ actual_start: '2026-10-05T22:00', actual_end: null }), 0);
  assert.equal(weekStart('2026-10-11'), '2026-10-05');
  assert.deepEqual(monthRange('2026-02'), ['2026-02-01', '2026-02-28']);
});

test('validation coerces types and reports field errors', () => {
  const v = validate({ a: { type: 'money' }, b: { type: 'int', min: 0 }, c: { type: 'bool' }, d: { type: 'enum', values: ['x'] } }, { a: '12.345', b: '3', c: 'on', d: 'x' });
  assert.deepEqual(v, { a: 1235, b: 3, c: 1, d: 'x' });
  assert.throws(() => validate({ b: { type: 'int', min: 0 } }, { b: -1 }), (e) => e.status === 400 && !!e.details.b);
  assert.throws(() => validate({ t: { type: 'time' } }, { t: '25:00' }), (e) => e.details.t === 'Invalid time');
  assert.throws(() => validate({ s: { type: 'string', max: 3 } }, { s: 'abcd' }));
});

test('password policy', () => {
  assert.ok(passwordProblem('short1'));
  assert.ok(passwordProblem('allletterslong'));
  assert.ok(passwordProblem('maria-2026-pass', 'maria'));
  assert.equal(passwordProblem('Fine-Password-77', 'maria'), null);
});

test('scheduled doses inside a shift window', () => {
  const med = { prn: 0, times: '08:00,20:00', start_date: '2026-01-01', stop_date: null };
  assert.deepEqual(dosesInWindow(med, '2026-10-05T07:00', '2026-10-05T12:00'), ['2026-10-05T08:00']);
  assert.deepEqual(dosesInWindow(med, '2026-10-05T19:00', '2026-10-06T09:00'), ['2026-10-05T20:00', '2026-10-06T08:00']);
  assert.deepEqual(dosesInWindow({ ...med, prn: 1 }, '2026-10-05T07:00', '2026-10-05T12:00'), []);
});

test('legacy v1 backup import preserves visits and is idempotent', () => {
  const db = openDb(':memory:');
  const settings = createSettings(db);
  const uid = db.insert('users', { username: 'a', display_name: 'a', role: 'admin', password_hash: 'x' });
  const data = {
    caregivers: [{ id: 'c1', name: 'Maria', pin: '1111', rate: 19, active: true }],
    clients: [{ id: 'k1', name: 'Dot', addr: '1 St', active: true }],
    entries: [{ id: 'e1', cgId: 'c1', clientId: 'k1', date: '2026-01-05', start: '22:00', end: '06:00', breakMin: 30, miles: 3, tasks: ['Meal preparation'], notes: 'ok' },
      { id: 'e2', cgId: 'zz', clientId: 'k1', date: '2026-01-06', start: '08:00', end: '09:00' }],
  };
  const r = importLegacy(db, settings, data, uid);
  assert.deepEqual(r, { caregivers: 1, clients: 1, visits: 1, skipped: 1 });
  const s = db.get('SELECT * FROM shifts');
  assert.equal(s.actual_end, '2026-01-06T06:00', 'overnight visit ends next day');
  assert.equal(workedHours(s), 7.5);
  assert.equal(s.pay_rate_cents, 1900);
  assert.equal(db.get('SELECT COUNT(*) n FROM users').n, 1, 'PINs are not turned into accounts');
  const again = importLegacy(db, settings, data, uid);
  assert.equal(again.visits, 0);
  db.close();
});
