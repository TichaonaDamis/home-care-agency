// Reusable UI building blocks: formatting, forms, tables, modals, toasts, badges and SVG charts.
// All dynamic text goes through esc(). No inline style attributes (CSP style-src 'self').

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
/** Set the single delegated click handler for a container (safe to call again when a page re-renders in place). */
export function onClick(el, fn) {
  if (el._onClick) el.removeEventListener('click', el._onClick);
  el._onClick = fn;
  el.addEventListener('click', fn);
}

// ---------- formatting ----------
export const money = (cents) => (cents == null ? '—' : (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' }));
export const num = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
export const hours = (n) => num(n, 2);
export const label = (s) => String(s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export function fmtDate(s, opts = {}) {
  if (!s) return '—';
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', ...opts });
}
export function fmtTime(t) {
  if (!t) return '—';
  const hm = t.length > 5 ? t.slice(11, 16) : t;
  const [h, m] = hm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
export const fmtDT = (s) => (s ? `${fmtDate(s)} ${s.length > 10 ? fmtTime(s) : ''}` : '—');
export const fmtISO = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

// Local date helpers (YYYY-MM-DD strings)
const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
export const weekStart = (s) => { const d = parseYmd(s); return addDays(s, -((d.getDay() + 6) % 7)); };
export const monthStart = (s) => `${s.slice(0, 7)}-01`;
export const monthEnd = (s) => { const d = parseYmd(monthStart(s)); return ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)); };

// ---------- badges ----------
const BADGE = {
  ok: ['ok', 'active', 'completed', 'approved', 'paid', 'resolved', 'closed', 'cleared', 'verified', 'improving', 'stable', 'complete'],
  warn: ['warn', 'pending', 'scheduled', 'partially_paid', 'acknowledged', 'temporarily_away', 'on_leave', 'under_review', 'in_review', 'possible_decline', 'medium', 'moderate', 'open', 'referred', 'evaluating', 'draft', 'incomplete', 'partial'],
  danger: ['danger', 'missed', 'rejected', 'hospitalized', 'high', 'critical', 'escalated', 'requires_review', 'flagged', 'terminated', 'deceased', 'void', 'declined', 'not_completed', 'refused', 'discrepancy', 'expired'],
  info: ['in_progress', 'issued', 'enrolled', 'info', 'low', 'processed', 'insufficient_data'],
  muted: ['muted', 'cancelled', 'discharged', 'ended', 'superseded', 'none', 'not_applicable', 'not_started'],
};
export function badge(value, text) {
  if (value == null || value === '') return '';
  const cls = Object.entries(BADGE).find(([, vals]) => vals.includes(value))?.[0] || '';
  return `<span class="badge ${cls}">${esc(text ?? label(value))}</span>`;
}
export const sampleBadge = (row) => (row?.is_sample ? ' <span class="badge sample" title="Sample data — not a real record">SAMPLE</span>' : '');

// ---------- toasts ----------
export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}
export const showError = (e) => toast(e?.message || String(e), 'error');

// ---------- empty / loading ----------
export const empty = (msg, icon = '○') => `<div class="empty"><span class="big" aria-hidden="true">${icon}</span>${esc(msg)}</div>`;
export const loading = () => '<div class="loading" role="status">Loading…</div>';

// ---------- forms ----------
/**
 * Field def: { name, label, type, options, required, hint, full, min, max, step, placeholder, value }
 * types: text, email, tel, number, money, date, time, datetime, textarea, select, checkbox, checks, hidden, readonly
 */
export function fields(defs, values = {}) {
  return defs.map((f) => field(f, values[f.name] ?? f.value)).join('');
}
export function field(f, v) {
  const id = `f_${f.name}_${Math.random().toString(36).slice(2, 7)}`;
  const req = f.required ? ' required' : '';
  const attrs = `${f.min !== undefined ? ` min="${f.min}"` : ''}${f.max !== undefined ? ` max="${f.max}"` : ''}${f.step ? ` step="${f.step}"` : ''}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}${f.maxlength ? ` maxlength="${f.maxlength}"` : ''}`;
  const lab = `<span>${esc(f.label)}${f.required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</span>`;
  const hint = f.hint ? `<span class="hint">${esc(f.hint)}</span>` : '';
  const wrap = (inner) => `<label class="field${f.full ? ' full' : ''}" for="${id}" data-field="${f.name}">${lab}${inner}${hint}<span class="field-error"></span></label>`;
  const val = v ?? '';
  switch (f.type) {
    case 'hidden': return `<input type="hidden" name="${f.name}" value="${esc(val)}">`;
    case 'textarea': return wrap(`<textarea id="${id}" name="${f.name}" rows="${f.rows || 3}"${req}${attrs}>${esc(val)}</textarea>`);
    case 'select': {
      const opts = (f.options || []).map(([ov, ol]) => `<option value="${esc(ov)}"${String(ov) === String(val) ? ' selected' : ''}>${esc(ol)}</option>`).join('');
      return wrap(`<select id="${id}" name="${f.name}"${req}>${f.required && val !== '' ? '' : `<option value="">${esc(f.placeholder || '—')}</option>`}${opts}</select>`);
    }
    case 'checkbox':
      return `<label class="check${f.full ? ' full' : ''}" data-field="${f.name}"><input type="checkbox" name="${f.name}"${val ? ' checked' : ''}> ${esc(f.label)}${f.hint ? ` <span class="hint">${esc(f.hint)}</span>` : ''}</label>`;
    case 'checks': {
      const set = new Set((Array.isArray(val) ? val : String(val).split(',')).map(String));
      return `<fieldset class="${f.full ? 'full' : ''}" data-field="${f.name}"><legend>${esc(f.label)}</legend><div class="checks">${(f.options || []).map(([ov, ol]) =>
        `<label class="check"><input type="checkbox" name="${f.name}" value="${esc(ov)}"${set.has(String(ov)) ? ' checked' : ''}> ${esc(ol)}</label>`).join('')}</div><span class="field-error"></span></fieldset>`;
    }
    case 'money': return wrap(`<input id="${id}" type="number" name="${f.name}" step="0.01" min="${f.min ?? 0}" value="${val === '' ? '' : esc(typeof val === 'number' && f.cents ? (val / 100).toFixed(2) : val)}"${req}>`);
    case 'datetime': return wrap(`<input id="${id}" type="datetime-local" name="${f.name}" value="${esc(val)}"${req}${attrs}>`);
    case 'readonly': return wrap(`<input id="${id}" name="${f.name}" value="${esc(val)}" readonly>`);
    default: return wrap(`<input id="${id}" type="${f.type || 'text'}" name="${f.name}" value="${esc(val)}"${req}${attrs}>`);
  }
}

/** Read a form into a plain object. Checkbox → boolean; checks → array; empty → null. */
export function readForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') {
      const group = form.querySelectorAll(`input[type=checkbox][name="${el.name}"]`);
      if (group.length > 1 || el.closest('fieldset')?.dataset.field === el.name) {
        out[el.name] = [...group].filter((c) => c.checked).map((c) => c.value);
      } else out[el.name] = el.checked;
      continue;
    }
    if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; continue; }
    out[el.name] = el.value === '' ? null : el.value;
  }
  return out;
}

export function showFieldErrors(form, err) {
  $$('.field.invalid', form).forEach((f) => f.classList.remove('invalid'));
  $$('.field-error', form).forEach((e) => { e.textContent = ''; });
  const details = err?.details;
  if (!details || typeof details !== 'object') return;
  let first = null;
  for (const [name, msg] of Object.entries(details)) {
    const wrap = form.querySelector(`[data-field="${name}"]`);
    if (!wrap || typeof msg !== 'string') continue;
    wrap.classList.add('invalid');
    const fe = wrap.querySelector('.field-error');
    if (fe) fe.textContent = msg;
    first ||= wrap.querySelector('input,select,textarea');
  }
  first?.focus();
}

/** Wire a form: on submit, read values, call handler, show errors. Returns nothing. */
export function onSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    if (btn) btn.disabled = true;
    try {
      showFieldErrors(form, null);
      await handler(readForm(form), form);
    } catch (err) {
      showFieldErrors(form, err);
      showError(err);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

// ---------- tables ----------
/**
 * cols: [{ key, label, num, render(row), cls, total: 'sum'|fn }]
 * opts: { rowLink(row) → hash, empty, footer, id }
 */
export function table(cols, rows, opts = {}) {
  if (!rows?.length) return empty(opts.empty || 'No records found.');
  const head = `<thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${c.html ? c.label : esc(c.label)}</th>`).join('')}</tr></thead>`;
  const body = rows.map((r) => {
    const link = opts.rowLink?.(r);
    return `<tr${link ? ` class="clickable" data-href="${esc(link)}" tabindex="0"` : ''}>${cols.map((c) => {
      const v = c.render ? c.render(r) : esc(r[c.key]);
      return `<td class="${[c.num ? 'num' : '', c.cls || ''].join(' ')}">${v ?? ''}</td>`;
    }).join('')}</tr>`;
  }).join('');
  let foot = '';
  if (cols.some((c) => c.total)) {
    foot = `<tfoot><tr>${cols.map((c, i) => {
      if (i === 0 && !c.total) return '<td>Total</td>';
      if (!c.total) return '<td></td>';
      const v = typeof c.total === 'function' ? c.total(rows) : rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0);
      return `<td class="num">${c.fmt ? c.fmt(v) : esc(v)}</td>`;
    }).join('')}</tr></tfoot>`;
  }
  return `<div class="table-wrap"><table${opts.id ? ` id="${opts.id}"` : ''}>${head}<tbody>${body}</tbody>${foot}</table></div>`;
}
/** Make clickable rows navigate (delegated). */
export function wireRowLinks(root) {
  root.addEventListener('click', (e) => {
    if (e.target.closest('button, a, input, select')) return;
    const tr = e.target.closest('tr[data-href]');
    if (tr) location.hash = tr.dataset.href;
  });
  root.addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr[data-href]');
    if (tr && e.key === 'Enter') location.hash = tr.dataset.href;
  });
}

// ---------- CSV ----------
export function downloadCsv(filename, header, rows) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  downloadBlob(filename, new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
}
export function downloadBlob(filename, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- modal ----------
/**
 * Open a modal. `body` is HTML. `onMount(el, close)` wires behaviour.
 * Returns a promise resolved with the value passed to close().
 */
export function modal({ title, body, wide = false, onMount, footer = '' }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="mtitle">
      <header><h2 id="mtitle">${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></header>
      <div class="body">${body}</div>${footer ? `<footer>${footer}</footer>` : ''}</div>`;
    const prev = document.activeElement;
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) close(null); });
    document.addEventListener('keydown', onKey);
    document.body.append(back);
    onMount?.(back.querySelector('.modal'), close);
    (back.querySelector('input:not([type=hidden]),select,textarea') || back.querySelector('button'))?.focus();
  });
}

/** Modal with a form. `submit(values)` may throw ApiError to show field errors; resolves with its return. */
export function formModal({ title, defs, values = {}, submitLabel = 'Save', submit, intro = '', wide = false, extra = '' }) {
  return modal({
    title, wide,
    body: `${intro}<form class="form"><div class="form-grid">${fields(defs, values)}</div>${extra}
      <div class="actions"><button class="btn primary" type="submit">${esc(submitLabel)}</button><button class="btn ghost" type="button" data-close>Cancel</button></div></form>`,
    onMount: (el, close) => onSubmit(el.querySelector('form'), async (v, form) => close(await submit(v, form))),
  });
}

export async function confirmDialog(message, { okLabel = 'Confirm', danger = false, reason = false, reasonLabel = 'Reason' } = {}) {
  return modal({
    title: 'Please confirm',
    body: `<form class="form"><p>${esc(message)}</p>${reason ? field({ name: 'reason', label: reasonLabel, type: 'textarea', required: true, full: true }) : ''}
      <div class="actions"><button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${esc(okLabel)}</button><button class="btn ghost" type="button" data-close>Cancel</button></div></form>`,
    onMount: (el, close) => el.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const r = el.querySelector('[name=reason]')?.value?.trim();
      if (reason && !r) return;
      close(reason ? r : true);
    }),
  });
}

// ---------- tabs ----------
export function tabs(items, current, { attr = 'data-tab' } = {}) {
  return `<div class="tabs" role="tablist">${items.map(([k, l]) => `<button type="button" role="tab" ${attr}="${k}" class="${k === current ? 'on' : ''}" aria-selected="${k === current}">${esc(l)}</button>`).join('')}</div>`;
}

// ---------- charts (inline SVG, no external libs) ----------
const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];

/** Horizontal bars for ranked values: [{label, value}] */
export function hbars(data, { fmt = (v) => num(v, 1), max = 12, emptyMsg = 'No data for this period.' } = {}) {
  const rows = (data || []).filter((d) => d.value > 0).slice(0, max);
  if (!rows.length) return empty(emptyMsg, '▁');
  const top = Math.max(...rows.map((d) => d.value));
  return `<div role="list">${rows.map((d) => `<div class="hbar" role="listitem"><span class="lbl" title="${esc(d.label)}">${esc(d.label)}</span>
    <span class="track"><span class="fill" data-w="${(d.value / top) * 100}"></span></span><span class="num">${esc(fmt(d.value))}</span></div>`).join('')}</div>`;
}
/** Apply widths set via data-w (CSP-safe: CSSOM, not inline style attributes). */
export function applyBarWidths(root) { $$('.fill[data-w]', root).forEach((el) => { el.style.width = `${el.dataset.w}%`; }); }

/**
 * Vertical grouped bar chart. labels: [..]; series: [{name, values:[..]}]
 */
export function barChart(labels, series, { height = 220, fmt = (v) => num(v, 0), emptyMsg = 'No data for this period.' } = {}) {
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!labels.length || !all.some((v) => v > 0)) return empty(emptyMsg, '▁');
  const W = Math.max(320, labels.length * (series.length * 14 + 18) + 50);
  const H = height;
  const pl = 44, pb = 28, pt = 10;
  const max = niceMax(Math.max(...all));
  const gw = (W - pl - 10) / labels.length;
  const bw = Math.max(4, Math.min(26, (gw - 8) / series.length));
  const y = (v) => pt + (H - pt - pb) * (1 - v / max);
  let svg = '';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    svg += `<line class="grid-line" x1="${pl}" x2="${W - 5}" y1="${y(v)}" y2="${y(v)}"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text>`;
  }
  labels.forEach((l, i) => {
    const gx = pl + i * gw + (gw - bw * series.length) / 2;
    series.forEach((s, j) => {
      const v = s.values[i] || 0;
      svg += `<rect x="${gx + j * bw}" y="${y(v)}" width="${bw - 2}" height="${Math.max(0, H - pb - y(v))}" rx="2" fill="${COLORS[j % 6]}"><title>${esc(`${s.name} · ${l}: ${fmt(v)}`)}</title></rect>`;
    });
    svg += `<text x="${pl + i * gw + gw / 2}" y="${H - 9}" text-anchor="middle">${esc(shortLabel(l))}</text>`;
  });
  const legend = series.length > 1 ? `<div class="legend">${series.map((s, j) => `<span><i class="sw-${(j % 6) + 1}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(', '))} chart">${svg}</svg>${legend}`;
}

/** Line chart over time. series: [{name, points:[{x:'YYYY-MM-DD…', y}]}], bands: [{lo, hi}] optional threshold lines */
export function lineChart(series, { height = 220, fmt = (v) => num(v, 0), thresholds = [], emptyMsg = 'No measurements recorded in this period.' } = {}) {
  const pts = series.flatMap((s) => s.points);
  if (!pts.length) return empty(emptyMsg, '〰');
  const W = 640, H = height, pl = 44, pr = 12, pt = 10, pb = 28;
  const xs = pts.map((p) => Date.parse(p.x.length === 10 ? `${p.x}T12:00` : p.x));
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  if (x0 === x1) { x0 -= 864e5; x1 += 864e5; }
  const ys = [...pts.map((p) => p.y), ...thresholds.map((t) => t.value)].filter((v) => v != null);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const padY = (y1 - y0) * 0.12 || Math.abs(y1) * 0.1 || 1;
  y0 -= padY; y1 += padY;
  const X = (t) => pl + ((t - x0) / (x1 - x0)) * (W - pl - pr);
  const Y = (v) => pt + (1 - (v - y0) / (y1 - y0)) * (H - pt - pb);
  let svg = '';
  for (let i = 0; i <= 4; i++) {
    const v = y0 + ((y1 - y0) / 4) * i;
    svg += `<line class="grid-line" x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${pl - 6}" y="${Y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text>`;
  }
  for (const t of thresholds) {
    if (t.value == null) continue;
    svg += `<line x1="${pl}" x2="${W - pr}" y1="${Y(t.value)}" y2="${Y(t.value)}" stroke="var(--danger)" stroke-dasharray="4 4"/><text x="${W - pr}" y="${Y(t.value) - 3}" text-anchor="end">${esc(t.label)}</text>`;
  }
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const t = x0 + ((x1 - x0) / ticks) * i;
    const d = new Date(t);
    svg += `<text x="${X(t)}" y="${H - 9}" text-anchor="middle">${esc(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</text>`;
  }
  series.forEach((s, j) => {
    const sorted = [...s.points].sort((a, b) => a.x.localeCompare(b.x));
    const path = sorted.map((p, i) => `${i ? 'L' : 'M'}${X(Date.parse(p.x.length === 10 ? `${p.x}T12:00` : p.x)).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    svg += `<path d="${path}" fill="none" stroke="${COLORS[j % 6]}" stroke-width="2"/>`;
    for (const p of sorted) {
      svg += `<circle cx="${X(Date.parse(p.x.length === 10 ? `${p.x}T12:00` : p.x)).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3" fill="${COLORS[j % 6]}"><title>${esc(`${s.name}: ${fmt(p.y)} — ${p.x.replace('T', ' ')}`)}</title></circle>`;
    }
  });
  const legend = series.length > 1 ? `<div class="legend">${series.map((s, j) => `<span><i class="sw-${(j % 6) + 1}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Trend chart">${svg}</svg>${legend}`;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}
const shortLabel = (l) => (/^\d{4}-\d{2}$/.test(l) ? new Date(`${l}-01T12:00`).toLocaleDateString(undefined, { month: 'short' })
  : /^\d{4}-\d{2}-\d{2}$/.test(l) ? new Date(`${l}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : String(l).slice(0, 10));

// ---------- stat cards ----------
export function stat(lbl, value, { tone = '', sub = '', href = '' } = {}) {
  const tag = href ? 'a' : 'div';
  return `<${tag} class="stat ${tone}"${href ? ` href="${esc(href)}"` : ''}><div class="v">${value}</div><div class="l">${esc(lbl)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</${tag}>`;
}

export function kv(pairs) {
  return `<dl class="kv">${pairs.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v ?? '—'}</dd>`).join('')}</dl>`;
}

/** Options helper: [{id, name}] → [[id, name]] */
export const opts = (rows, key = 'name', id = 'id') => rows.map((r) => [r[id], r[key]]);
