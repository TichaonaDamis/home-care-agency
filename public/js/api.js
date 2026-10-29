// Small fetch wrapper. All mutating requests carry the X-CareHours header (CSRF defence).
export class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

let onAuthLost = () => {};
export const setAuthHandler = (fn) => { onAuthLost = fn; };

async function request(method, path, body, { raw = false } = {}) {
  const opts = { method, headers: { 'X-CareHours': '1' }, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(`/api${path}`, opts); } catch { throw new ApiError(0, 'Cannot reach the server. Check your connection.'); }
  if (raw && res.ok) return res;
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.details);
    if (res.status === 401 && !path.startsWith('/auth/login')) onAuthLost(err);
    if (res.status === 403 && data?.details?.code === 'PASSWORD_CHANGE_REQUIRED') onAuthLost(err);
    throw err;
  }
  return data;
}

const qs = (params = {}) => {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? `?${new URLSearchParams(p)}` : '';
};

export const api = {
  get: (path, params) => request('GET', path + qs(params)),
  post: (path, body = {}) => request('POST', path, body),
  patch: (path, body = {}) => request('PATCH', path, body),
  put: (path, body = {}) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
  raw: (path, params) => request('GET', path + qs(params), undefined, { raw: true }),
  qs,
};
