// node:sqlite DatabaseSync API on top of sql.js (SQLite compiled to WebAssembly).
let SQL = null;
export function setSqlJs(s) { SQL = s; }
export class DatabaseSync {
  constructor() { this.db = new SQL.Database(); }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) {
    const db = this.db;
    const withStmt = (params, fn) => {
      const st = db.prepare(sql);
      try { if (params.length) st.bind(params); return fn(st); } finally { st.free(); }
    };
    return {
      all: (...p) => withStmt(p, (st) => { const rows = []; while (st.step()) rows.push(st.getAsObject()); return rows; }),
      get: (...p) => withStmt(p, (st) => (st.step() ? st.getAsObject() : undefined)),
      run: (...p) => {
        withStmt(p, (st) => { st.step(); });
        const changes = db.getRowsModified();
        const id = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
        return { changes, lastInsertRowid: id };
      },
    };
  }
  export() { return this.db.export(); }
  load(bytes) { this.db.close(); this.db = new SQL.Database(bytes); }
  close() {}
}
