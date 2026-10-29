'use strict';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const pad = (n) => String(n).padStart(2, '0');

/** Current wall-clock time in the agency time zone as 'YYYY-MM-DDTHH:MM'. */
function nowLocal(tz, at = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
const todayLocal = (tz) => nowLocal(tz).slice(0, 10);

// Date arithmetic on 'YYYY-MM-DD' strings, done in UTC to avoid DST drift.
const toDate = (ymd) => new Date(`${ymd}T00:00:00Z`);
const fromDate = (d) => d.toISOString().slice(0, 10);
const addDays = (ymd, n) => { const d = toDate(ymd); d.setUTCDate(d.getUTCDate() + n); return fromDate(d); };
const dayOfWeek = (ymd) => toDate(ymd).getUTCDay();
const weekStart = (ymd) => addDays(ymd, -((dayOfWeek(ymd) + 6) % 7)); // Monday
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 864e5);
function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(last)}`];
}

/** Minutes between two local datetimes 'YYYY-MM-DDTHH:MM'. */
function minutesBetween(a, b) {
  return Math.round((new Date(`${b}:00Z`) - new Date(`${a}:00Z`)) / 60000);
}
/** Scheduled minutes for HH:MM → HH:MM, crossing midnight if needed. */
function schedMinutes(start, end) {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let m = (eh * 60 + em) - (sh * 60 + sm);
  if (m <= 0) m += 1440;
  return m;
}
/** Worked hours on a shift (actual times, less breaks). 0 if not clocked out. */
function workedHours(s) {
  if (!s.actual_start || !s.actual_end) return 0;
  return Math.max(0, minutesBetween(s.actual_start, s.actual_end) - (s.break_min || 0)) / 60;
}
const schedHours = (s) => schedMinutes(s.sched_start, s.sched_end) / 60;

/** Interval [start,end) of a scheduled shift in absolute minutes, for overlap checks. */
function shiftInterval(date, start, end) {
  const base = toDate(date).getTime() / 60000;
  const [sh, sm] = start.split(':').map(Number);
  const s = base + sh * 60 + sm;
  return [s, s + schedMinutes(start, end)];
}
const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];

const round2 = (n) => Math.round(n * 100) / 100;
const centsFor = (hours, rateCents) => Math.round(hours * rateCents);

function parseJson(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }

module.exports = {
  HttpError, pad, nowLocal, todayLocal, addDays, dayOfWeek, weekStart, daysBetween, monthRange,
  minutesBetween, schedMinutes, workedHours, schedHours, shiftInterval, overlaps, round2, centsFor, parseJson,
};
