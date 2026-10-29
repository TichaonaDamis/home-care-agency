'use strict';
// Command-line tasks: migrate, seed sample data, create an admin, back up the database.
const path = require('node:path');
const fs = require('node:fs');
const { openDb } = require('./db');
const { hashPassword } = require('./lib/auth');

function tempPassword() { return require('./routes/users').tempPassword(); }

/** Create the initial administrator if no users exist. Returns credentials once, or null. */
function ensureAdmin(db, username = process.env.ADMIN_USERNAME || 'admin') {
  if (db.get('SELECT COUNT(*) n FROM users').n > 0) return null;
  const password = process.env.ADMIN_PASSWORD || tempPassword();
  db.insert('users', { username, display_name: 'Administrator', role: 'admin', password_hash: hashPassword(password), must_change_password: 1 });
  return { username, password };
}

if (require.main === module) {
  const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'carehours.sqlite');
  const [cmd, arg] = process.argv.slice(2);
  const db = openDb(dbFile);
  switch (cmd) {
    case 'migrate':
      console.log('Database is up to date:', dbFile);
      break;
    case 'seed': {
      const { seedSample } = require('./seed');
      const out = seedSample(db);
      console.log('Sample data created. Every sample record is flagged is_sample = 1 and shown with a SAMPLE badge.');
      console.table(out.accounts);
      break;
    }
    case 'create-admin': {
      const username = arg || 'admin2';
      const password = tempPassword();
      db.insert('users', { username, display_name: username, role: 'admin', password_hash: hashPassword(password), must_change_password: 1 });
      console.log(`Created admin "${username}" with temporary password: ${password}`);
      break;
    }
    case 'backup': {
      const dir = arg || path.join(path.dirname(dbFile), 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `carehours-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      // Verify the backup opens and passes an integrity check.
      const { DatabaseSync } = require('node:sqlite');
      const check = new DatabaseSync(file, { readOnly: true }).prepare('PRAGMA integrity_check').get();
      console.log(`Backup written: ${file} (integrity: ${Object.values(check)[0]})`);
      break;
    }
    case 'export-client': {
      // Full record export for one client (e.g. a records request). Output contains PHI — handle securely.
      const id = Number(arg);
      const client = db.get('SELECT * FROM clients WHERE id = ?', [id]);
      if (!client) { console.error('Client not found.'); process.exitCode = 1; break; }
      const tables = ['client_contacts', 'client_category_links', 'client_services', 'care_plans', 'assignments', 'shifts', 'adl_logs', 'meal_logs',
        'activity_logs', 'observations', 'medications', 'medication_changes', 'med_events', 'measurements', 'client_thresholds', 'incidents', 'alerts',
        'progress_reviews', 'transitions', 'invoices'];
      const out = { exported_at: new Date().toISOString(), client };
      for (const t of tables) out[t] = db.all(`SELECT * FROM ${t} WHERE client_id = ?`, [id]);
      const file = path.join(path.dirname(dbFile), `client-${client.code}-export.json`);
      fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
      db.run(`INSERT INTO audit_log (username, action, entity, entity_id, client_id, details) VALUES ('cli', 'export', 'client_record', ?, ?, ?)`, [id, id, JSON.stringify({ note: file })]);
      console.log(`Exported to ${file} (contains protected health information — store and transmit securely).`);
      break;
    }
    case 'purge-sample': {
      // Remove all generated sample data before go-live.
      const n = db.tx(() => {
        const cl = db.all('SELECT id FROM clients WHERE is_sample = 1').map((r) => r.id);
        const cg = db.all('SELECT id FROM caregivers WHERE is_sample = 1').map((r) => r.id);
        const inList = (ids) => `(${ids.map(() => '?').join(',') || 'NULL'})`;
        const sh = db.all(`SELECT id FROM shifts WHERE client_id IN ${inList(cl)} OR caregiver_id IN ${inList(cg)}`, [...cl, ...cg]).map((r) => r.id);
        const inv = db.all(`SELECT id FROM invoices WHERE client_id IN ${inList(cl)}`, cl).map((r) => r.id);
        db.run(`DELETE FROM payments WHERE invoice_id IN ${inList(inv)}`, inv);
        db.run(`DELETE FROM invoice_items WHERE invoice_id IN ${inList(inv)} OR shift_id IN ${inList(sh)}`, [...inv, ...sh]);
        db.run(`DELETE FROM invoices WHERE id IN ${inList(inv)}`, inv);
        for (const t of ['adl_logs', 'meal_logs', 'activity_logs', 'observations', 'med_events', 'measurements', 'incidents']) {
          db.run(`DELETE FROM ${t} WHERE client_id IN ${inList(cl)} OR shift_id IN ${inList(sh)}`, [...cl, ...sh]);
        }
        db.run(`DELETE FROM payroll_items WHERE caregiver_id IN ${inList(cg)}`, cg);
        db.run(`DELETE FROM payroll_adjustments WHERE caregiver_id IN ${inList(cg)}`, cg);
        db.run(`DELETE FROM shifts WHERE id IN ${inList(sh)}`, sh);
        db.run(`DELETE FROM assignments WHERE client_id IN ${inList(cl)} OR caregiver_id IN ${inList(cg)}`, [...cl, ...cg]);
        for (const t of ['medication_changes', 'alerts', 'progress_reviews', 'transitions', 'client_thresholds', 'client_services', 'client_contacts', 'client_category_links']) {
          db.run(`DELETE FROM ${t} WHERE client_id IN ${inList(cl)}`, cl);
        }
        db.run(`DELETE FROM medications WHERE client_id IN ${inList(cl)}`, cl);
        db.run(`DELETE FROM care_plan_acks WHERE caregiver_id IN ${inList(cg)} OR care_plan_id IN (SELECT id FROM care_plans WHERE client_id IN ${inList(cl)})`, [...cg, ...cl]);
        db.run(`DELETE FROM care_plans WHERE client_id IN ${inList(cl)}`, cl);
        const users = db.all(`SELECT id FROM users WHERE caregiver_id IN ${inList(cg)} OR username LIKE 'sample.%'`, cg).map((r) => r.id);
        db.run(`DELETE FROM sessions WHERE user_id IN ${inList(users)}`, users);
        // Sample users may have authored records on real clients; disable rather than delete those.
        for (const u of users) {
          try { db.run('DELETE FROM users WHERE id = ?', [u]); } catch { db.run('UPDATE users SET active = 0, caregiver_id = NULL, role = CASE role WHEN \'caregiver\' THEN \'nurse\' ELSE role END WHERE id = ?', [u]); }
        }
        db.run(`DELETE FROM credentials WHERE caregiver_id IN ${inList(cg)}`, cg);
        db.run(`DELETE FROM caregiver_pay_rates WHERE caregiver_id IN ${inList(cg)}`, cg);
        db.run(`DELETE FROM caregivers WHERE id IN ${inList(cg)}`, cg);
        db.run(`DELETE FROM clients WHERE id IN ${inList(cl)}`, cl);
        db.run('DELETE FROM expenses WHERE description LIKE ?', ['%(sample)%']);
        db.run('DELETE FROM facilities WHERE is_sample = 1');
        return { clients: cl.length, caregivers: cg.length, shifts: sh.length };
      });
      console.log('Sample data removed:', n);
      break;
    }
    default:
      console.log('Usage: node server/cli.js <migrate|seed|create-admin [username]|backup [dir]|export-client <id>|purge-sample>');
  }
  db.close();
}

module.exports = { ensureAdmin };
