// Minimal node:crypto for the in-browser demo. scrypt cost is reduced so the demo stays fast.
import { scrypt } from '@noble/hashes/scrypt';
import { sha256 } from '@noble/hashes/sha256';
import { Buffer } from 'buffer';
// The buffer polyfill lacks 'base64url', which session tokens use.
function withBase64url(b) {
  const orig = b.toString.bind(b);
  b.toString = (enc, ...rest) => (enc === 'base64url' ? orig('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : orig(enc, ...rest));
  return b;
}
export function randomBytes(n) { return withBase64url(Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n)))); }
export function randomInt(a, b) { if (b === undefined) { b = a; a = 0; } return a + Math.floor(Math.random() * (b - a)); }
export function scryptSync(pw, salt, len, o = {}) { return Buffer.from(scrypt(pw, salt, { N: Math.min(o.N || 1024, 1024), r: o.r || 8, p: o.p || 1, dkLen: len })); }
export function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }
export function createHash() {
  let data = '';
  const h = { update(s) { data += s; return h; }, digest(enc) { return Buffer.from(sha256(new TextEncoder().encode(data))).toString(enc); } };
  return h;
}
export default { randomBytes, randomInt, scryptSync, timingSafeEqual, createHash };
