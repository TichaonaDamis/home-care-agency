'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const nul = (v) => (v === undefined ? null : v);

/** Thin wrapper over node:sqlite with statement caching and nested transactions. */
class Db {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;');
    this.cache = new Map();
    this.depth = 0;
  }
  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) { s = this.raw.prepare(sql); this.cache.set(sql, s); }
    return s;
  }
  // node:sqlite cannot bind `undefined`; treat it as NULL.
  all(sql, params = []) { return this.stmt(sql).all(...params.map(nul)); }
  get(sql, params = []) { return this.stmt(sql).get(...params.map(nul)); }
  run(sql, params = []) {
    const r = this.stmt(sql).run(...params.map(nul));
    return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
  }
  exec(sql) { this.raw.exec(sql); }
  tx(fn) {
    const sp = `sp${this.depth}`;
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (e) {
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }
  /** Insert a row from a plain object; returns new id. Column names come from code, never user input. */
  insert(table, row) {
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    return this.run(sql, cols.map((c) => row[c])).id;
  }
  update(table, id, row) {
    const cols = Object.keys(row);
    if (!cols.length) return 0;
    const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
    return this.run(sql, [...cols.map((c) => row[c]), id]).changes;
  }
  migrate() {
    this.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const done = new Set(this.all('SELECT name FROM schema_migrations').map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const applied = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      this.tx(() => {
        this.exec(sql);
        this.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [f, new Date().toISOString()]);
      });
      applied.push(f);
    }
    return applied;
  }
  close() { this.raw.close(); }
}

function openDb(file) {
  const db = new Db(file);
  db.migrate();
  return db;
}

module.exports = { openDb, Db };
