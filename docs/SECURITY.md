# Security, privacy & compliance

CareHours handles sensitive personal, employment and health information. This document lists the controls built into the software and the **operational work that software cannot do for you**.

> **CareHours is not "HIPAA-compliant software".** No software is compliant on its own. HIPAA compliance is a property of an organisation's policies, agreements, risk management, workforce training and technical environment. The controls below are designed to support those obligations.

## Controls implemented in the application

| Requirement | Implementation |
|---|---|
| Authentication | Username + password. scrypt hashing (N=16384, r=8, p=1, 16-byte salt). Minimum 10 characters with letters plus digits/symbols, must not contain the username. Temporary passwords must be changed at first sign-in. |
| Account protection | Lockout for 15 minutes after 5 failed attempts; per-IP sign-in throttle; identical error for unknown user and wrong password; failed attempts are audited. |
| Sessions | 256-bit random token in an `HttpOnly`, `SameSite=Strict`, `Secure` (production) cookie. Only the SHA-256 hash is stored server-side. Idle timeout (default 30 min) and absolute lifetime (default 12 h), both enforced by the server. A client-side warning appears before idle sign-out. Password change ends other sessions; disabling a user or changing their role ends all of that user's sessions. |
| Authorization | Role → permission map enforced by middleware on every API route. Caregiver access to a client requires an active, approved assignment covering today (or a shift today). Caregivers only see their own shifts, timesheets, documentation and incidents; billing rates are stripped from caregiver responses; employment data is hidden from non-managers. |
| CSRF | All state-changing requests require the `X-CareHours` header (blocked cross-origin by CORS preflight) plus `SameSite=Strict` cookies. |
| Transport | HSTS in production; set `COOKIE_SECURE=1` and terminate TLS at the proxy or host. |
| Browser hardening | `Content-Security-Policy: default-src 'self'` (no inline script or style), `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`. API responses are `Cache-Control: no-store`. |
| Input validation | Every endpoint validates and coerces input against a schema (types, lengths, enums, dates/times, money). All SQL uses bound parameters. CSV exports neutralise spreadsheet formula injection. |
| Error handling | Generic error responses; server logs record method, path and stack only, never request bodies, so PHI is not written to logs. |
| URLs | Record links use numeric IDs only. Names, DOB and other PHI never appear in URLs. |
| Audit trail | `audit_log` records sign-ins (success/failure), record views (client, caregiver), creates, updates, deletes, approvals, exports, backups, imports, alert actions and time corrections with user, time, IP and record. Financial and time fields store before/after values; clinical values are **not** copied into the audit log (field names only). |
| Data integrity | Foreign keys, CHECK constraints and indexes; versioned rates, care plans and medication history; approved/paid/invoiced records are locked against silent edits; corrections require a reason. |
| Backups | `GET /api/backup` (admin) and `npm run backup` produce a consistent `VACUUM INTO` copy; the CLI runs an integrity check on every backup. |
| Data export / deletion | `export-client <id>` for records requests (file created with `0600` permissions and audited). `purge-sample` removes demo data. Clinical records are intentionally not deletable through the UI; corrections use "entered in error", new versions or documented reasons. |
| Notifications | In-app only. No PHI is sent by email or SMS. |

## Before go-live: operational checklist

These cannot be completed by the software and must be verified by the organisation.

### Legal & regulatory
- [ ] Determine whether the organisation is a HIPAA **covered entity** or **business associate**, and which **state** rules apply (AFH/boarding home licensing, home care agency rules, record retention periods, incident/abuse reporting, medication delegation, nurse delegation, wage & hour law).
- [ ] Sign a **Business Associate Agreement** with the hosting provider and any other vendor that stores or can access PHI (backups, email, monitoring).
- [ ] Complete and document a HIPAA **security risk assessment**, and repeat it periodically.
- [ ] Adopt written policies: access management, minimum necessary, workforce sanctions, incident response and breach notification, contingency/disaster recovery, device and media handling, retention and disposal.
- [ ] Have your clinical lead approve the default measurement thresholds, trend rules and escalation instructions, and set individualized thresholds for each client.
- [ ] Have payroll and legal advisers confirm overtime rules, employee classifications and mileage reimbursement for your jurisdiction.

### Hosting & infrastructure
- [ ] Serve only over **HTTPS**; set `NODE_ENV=production` (secure cookies + HSTS).
- [ ] Store the database on **encrypted, persistent** storage (encrypted volume/disk). The SQLite file itself is not encrypted by the application.
- [ ] Restrict server/SSH/console access to named administrators with MFA at the hosting provider.
- [ ] Schedule automated backups (`npm run backup`) to **encrypted, off-site** storage; keep multiple generations; **test restores** regularly and record the results.
- [ ] Keep Node.js and dependencies patched (`npm audit`); monitor uptime and disk space.
- [ ] Decide log retention for the server and proxy logs; ensure they do not capture request bodies.

### Application setup
- [ ] Change the first administrator password; create named accounts for every user (no shared logins).
- [ ] Give each person the least-privileged role. Use the Nurse role for clinical staff who should not see payroll or billing.
- [ ] Set each caregiver's **medication authority** to match their training and delegation.
- [ ] Set the agency **time zone**, session timeouts and clock-in window.
- [ ] Remove sample data: `npm run purge-sample`.
- [ ] Review the audit log regularly and when staff leave; disable departed users immediately (terminating a caregiver disables their login automatically).

### Known gaps / future work
- Multi-factor authentication for staff sign-in (recommended for administrators).
- Application-level field encryption (currently relies on encrypted storage).
- Secure file attachments (care plans, orders, signed consents). Today these are recorded as text and source references.
- Family / legal-representative portal (the data model supports adding a limited role later).
- Server-side PDF generation (currently browser "Save as PDF").
- Automated scheduled backups inside the app (use the CLI with cron or your host's scheduler).
