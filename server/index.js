'use strict';
const path = require('node:path');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { ensureAdmin } = require('./cli');

const env = process.env;
const production = env.NODE_ENV === 'production';
const dbFile = env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'carehours.sqlite');
const port = Number(env.PORT) || 3000;

const db = openDb(dbFile);
const created = ensureAdmin(db);
if (created) {
  console.log('\n  First run: created administrator account');
  console.log(`    username: ${created.username}`);
  console.log(`    temporary password: ${created.password}`);
  console.log('  You will be asked to change it at first sign-in.\n');
}

const { app } = createApp(db, {
  secureCookies: env.COOKIE_SECURE ? env.COOKIE_SECURE === '1' : production,
  trustProxy: env.TRUST_PROXY || (production ? 1 : false),
  staticMaxAge: production ? '1h' : 0,
});

const server = app.listen(port, () => console.log(`CareHours listening on http://localhost:${port}`));
const shutdown = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
