'use strict';
const path = require('node:path');
const express = require('express');
const { HttpError } = require('./lib/util');
const { createSettings } = require('./lib/core');
const { sessionMiddleware, csrfGuard, requireAuth } = require('./lib/auth');

/**
 * Build the Express app. `opts.secureCookies` should be true behind HTTPS (production).
 */
function createApp(db, opts = {}) {
  const settings = createSettings(db);
  const ctx = { db, settings, secureCookies: !!opts.secureCookies };
  const app = express();
  app.disable('x-powered-by');
  if (opts.trustProxy) app.set('trust proxy', opts.trustProxy);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (ctx.secureCookies) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  const api = express.Router();
  api.use(express.json({ limit: '2mb' }));
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.use(csrfGuard);
  api.use(sessionMiddleware(db, settings));

  // Public (unauthenticated) routes
  api.use(require('./routes/auth')(ctx));
  api.get('/health', (req, res) => res.json({ ok: true }));

  // Everything below requires a signed-in user; individual routes check permissions.
  api.use(requireAuth);
  for (const name of ['users', 'settings', 'clients', 'caregivers', 'schedule', 'care', 'meds', 'health', 'incidents', 'finance', 'reports', 'dashboard']) {
    api.use(require(`./routes/${name}`)(ctx));
  }
  api.use((req, res, next) => next(new HttpError(404, 'Not found.')));

  app.use('/api', api);
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: opts.staticMaxAge ?? 0 }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // Error handler: never echo internal details or request bodies (may contain PHI).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details ?? null });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request.' });
    if (/constraint failed/i.test(err.message || '')) {
      const msg = /UNIQUE/.test(err.message) ? 'That record already exists (duplicate ID or name).' : 'The request conflicts with existing data.';
      return res.status(409).json({ error: msg });
    }
    if (!opts.quiet) console.error(`[error] ${req.method} ${req.path}: ${err.stack || err.message}`);
    res.status(500).json({ error: 'Something went wrong. The error has been logged.' });
  });

  return { app, ctx };
}

module.exports = { createApp };
