'use strict';
const { HttpError } = require('./util');

const RE = {
  date: /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
  time: /^([01]\d|2[0-3]):[0-5]\d$/,
  datetime: /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
};

/**
 * Validate `input` against `schema` and return a clean object containing only schema fields.
 * Field spec: { type, required, max, min, values, default }
 * types: string, text, int, number, bool, date, time, datetime, email, enum, money (dollars → cents), id, list
 * With { partial: true } missing fields are skipped (for PATCH-style updates).
 */
function validate(schema, input, { partial = false } = {}) {
  const out = {};
  const errors = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const [key, spec] of Object.entries(schema)) {
    let v = src[key];
    const missing = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (missing) {
      if (partial && v === undefined) continue;
      if (spec.required) { errors[key] = 'Required'; continue; }
      if (spec.default !== undefined) { out[key] = spec.default; continue; }
      out[key] = spec.type === 'bool' ? 0 : null;
      continue;
    }
    try {
      out[key] = coerce(spec, v);
    } catch (e) {
      errors[key] = e.message;
    }
  }
  if (Object.keys(errors).length) throw new HttpError(400, 'Please correct the highlighted fields.', errors);
  return out;
}

function coerce(spec, v) {
  switch (spec.type) {
    case 'string': case 'text': {
      const s = String(v).trim();
      const max = spec.max ?? (spec.type === 'text' ? 5000 : 200);
      if (s.length > max) throw new Error(`Must be ${max} characters or fewer`);
      return s;
    }
    case 'email': {
      const s = String(v).trim();
      if (!RE.email.test(s) || s.length > 200) throw new Error('Invalid email');
      return s;
    }
    case 'int': case 'id': {
      const n = Number(v);
      if (!Number.isInteger(n)) throw new Error('Must be a whole number');
      if (spec.type === 'id' && n <= 0) throw new Error('Invalid selection');
      checkRange(spec, n);
      return n;
    }
    case 'number': {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error('Must be a number');
      checkRange(spec, n);
      return n;
    }
    case 'money': {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error('Must be an amount');
      if (spec.min !== undefined && n < spec.min) throw new Error(`Must be at least ${spec.min}`);
      if (Math.abs(n) > 1e7) throw new Error('Amount too large');
      return Math.round(n * 100);
    }
    case 'bool': return v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 1 : 0;
    case 'date': case 'time': case 'datetime': {
      const s = String(v).trim().slice(0, spec.type === 'datetime' ? 16 : 10);
      if (!RE[spec.type].test(s)) throw new Error(`Invalid ${spec.type}`);
      return s;
    }
    case 'enum': {
      if (!spec.values.includes(v)) throw new Error('Invalid choice');
      return v;
    }
    case 'list': {
      const arr = Array.isArray(v) ? v : String(v).split(',');
      return arr.map((x) => coerce(spec.of, x));
    }
    default: throw new Error(`Unknown type ${spec.type}`);
  }
}
function checkRange(spec, n) {
  if (spec.min !== undefined && n < spec.min) throw new Error(`Must be at least ${spec.min}`);
  if (spec.max !== undefined && n > spec.max) throw new Error(`Must be at most ${spec.max}`);
}

const idParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id');
  return n;
};

module.exports = { validate, idParam, RE };
