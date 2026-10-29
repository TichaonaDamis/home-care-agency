# CareHours — Adult Family Home & Home Care Management

CareHours is a web application for Adult Family Homes (AFHs), residential care, assisted-living settings and home care agencies. It brings scheduling, timekeeping, daily care documentation, medications, health monitoring, incidents, care transitions, payroll, billing and reporting into one system with role-based access.

> **Status:** version 2 is a full-stack application (Node.js + SQLite) that replaces the original browser-only timesheet (v1). v1 had no server, so its data was stored per browser with plain-text PINs. That cannot provide secure, shared, persistent records, so v2 adds a real backend. v1 remains available under [`legacy/`](legacy/) so existing data can be exported and imported.

**Live demo:** https://tichaonadamis.github.io/home-care-agency/demo/ runs the full app in your browser with fictional sample data (sign in as `admin`, `sample.nurse` or `maria.sample`, password `Demo-Pass-2026`). It is built with `npm run build:demo`, which bundles the real server code with SQLite compiled to WebAssembly. Demo data stays in your browser; never enter real client information there.

---

## What's included

| Area | Highlights |
|---|---|
| **Roles & security** | Administrator, Facility Manager, Nurse/Clinical, Caregiver. Server-side permission checks on every route. Caregivers only reach clients they are actively assigned to. scrypt password hashing, HttpOnly/SameSite=Strict session cookies, idle and absolute session timeouts, account lockout, CSRF header check, strict CSP, audit log. |
| **Dashboard** | Active clients/caregivers, scheduled vs completed visits, care hours, overtime, payroll estimate, billable revenue, outstanding invoices, clients requiring review, incidents, hospitalized and hospice clients; charts for hours, revenue vs payroll, visits, services, admissions/discharges and trend indicators. No invented data: empty states are shown instead. |
| **Clients** | Registration with unique ID, legal/preferred name, DOB, facility/room, contacts, emergency contacts, decision-makers, care team, allergies, alerts, admission/status, consent and contact preferences. Configurable categories (multiple per client). Services with effective dates, frequency, instructions, responsible staff and **versioned billing rates** (hourly / per visit / daily / monthly). **Versioned care plans** with required ADL tasks and caregiver acknowledgement. |
| **Caregivers** | Profiles with employment status/class, hire/termination dates, credentials with expiry warnings, background check, medication authority, responsibilities/restrictions, availability, **pay-rate history**, overtime rule & multiplier, mileage rate. Sensitive employment data is restricted to managers. |
| **Assignments & scheduling** | Many-to-many caregiver ↔ client assignments with days, times, service, optional pay/bill rate overrides, supervisor approval. Day/week/month calendar, shift generation, open (unfilled) shifts, coverage-gap report. Overlaps, unapproved overtime, expired credentials and inactive clients are blocked unless a documented override reason is entered. |
| **Timekeeping** | Clock in/out with a configurable early/late window (exceptions documented), unscheduled visits, breaks, mileage, supervisor approval/rejection, audited time corrections. Rates are **frozen on each shift** so later rate changes never rewrite history. Paid or invoiced shifts are locked. |
| **Daily care logs** | ADLs (completed / partial / declined / N/A / not completed, with notes), meals & fluids (all optional except meal type), activities & engagement, mood/behavior/condition observations (objective, non-diagnostic). Every entry has timestamp, author, client and shift. Shifts cannot be completed with outstanding required documentation unless the caregiver files an exception report. |
| **Medications** | Orders (strength, form, dose, route, frequency, times, PRN, prescriber, pharmacy, dates, instructions, precautions, source), reconciliation date, **automatic change history** (started, discontinued, dose/frequency/route/instruction changes, held/resumed) with verification and follow-up. Administration/assistance records limited by each caregiver's authority. **Before/after review** of documented observations around a change, explicitly labelled as temporal association only. |
| **Health monitoring** | BP, glucose, weight, temperature, pulse, respiration, SpO₂, pain and custom measurements; single or batch entry; client-specific thresholds approved by a clinician, with escalation instructions shown immediately; latest/previous/change; trend charts; overdue/missing checks; entered-in-error handling. Missing values are never estimated. |
| **Progress & alerts** | Transparent, configurable trend indicator (Improving / Stable / Possible decline / Requires staff review / Insufficient data) with reasons and linked evidence; 7-day, 30-day and custom comparisons; timeline; staff reviews with resolution. Alerts for abnormal readings, missed meals, low fluids, falls, pain, medication refusals/discrepancies, incidents and transitions, tracked from creation → acknowledgement → escalation → resolution. |
| **Care transitions** | ED visits, hospital admission/discharge, return, temporary absence, hospice referral/evaluation/admission/discharge, discharge, death. Hospitalization and hospice status are tracked separately. Shifts can be cancelled, staff are alerted, and billing warns about services dated during an absence. |
| **Payroll & billing** | Payroll per caregiver from approved shifts: regular/OT hours under each caregiver's rule (weekly 40, daily 8 + weekly 40, or exempt), OT premium, mileage, adjustments, gross, all clearly labelled as estimates; payroll runs with approve/process/void. Client invoices from approved shifts at frozen bill rates (no double billing), fees, credits, payments, balances, status. Expenses. Financial summary by client, caregiver, service, facility and month, with margin estimate when cost data exists. |
| **Reports** | Hours & visits (the v1 report, extended) with CSV export and print; Monthly reports **A** client health & progress, **B** caregiver activity, **C** financial, **D** facility operations, each with print/PDF (browser "Save as PDF") and CSV, and recorded/calculated/estimate/missing labels. |
| **Search & notifications** | Global search; filters throughout. In-app notifications for upcoming shifts, missed visits, missing documentation, expiring credentials, unverified medication changes, discrepancies, condition alerts, care-plan reviews, discharge follow-ups and past-due invoices. No medical details are sent by email or SMS. |
| **Settings** | Agency, time zone, session limits, clock-in window, OT thresholds, trend and notification rules, facilities, categories, service types, measurement types and default thresholds, users and roles, audit log viewer, database backup, v1 import. |

## Quick start (local)

Requires **Node.js 22.13 or newer** (uses the built-in `node:sqlite`).

```bash
npm install
npm run seed      # optional: loads clearly-marked SAMPLE data and prints demo logins
npm start         # http://localhost:3000
```

On first start an `admin` account is created and its temporary password is printed to the console (or set `ADMIN_PASSWORD` beforehand). You must change it at first sign-in.

Sample data: every sample record has `is_sample = 1`, codes starting `SAMPLE-` and names ending “(Sample)”, and shows a **SAMPLE** badge. Remove it before go-live with `npm run purge-sample`.

## Commands

| Command | Purpose |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run with auto-reload |
| `npm test` | Automated tests (security, permissions, workflows, all 14 acceptance scenarios) |
| `npm run migrate` | Apply database migrations (also runs automatically on start) |
| `npm run seed` | Add sample data (`SEED_PASSWORD` sets the demo password) |
| `npm run purge-sample` | Delete all sample data |
| `npm run backup -- /path/to/dir` | Consistent, integrity-checked database backup |
| `node server/cli.js export-client <id>` | Export one client's full record (e.g. records request) |
| `node server/cli.js create-admin <username>` | Create another administrator |

## Configuration (environment variables)

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `DATABASE_FILE` | `./data/carehours.sqlite` | Put this on persistent, encrypted storage |
| `NODE_ENV` | — | `production` enables Secure cookies, HSTS and proxy trust |
| `COOKIE_SECURE` | `1` in production | Must be `1` behind HTTPS |
| `TRUST_PROXY` | `1` in production | Hops of reverse proxy in front of the app |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / random | First-run administrator only |

No secrets are stored in the repository. Session tokens are random and only their SHA-256 hashes are stored.

## Deployment

**GitHub Pages cannot run this application.** It only serves static files, and CareHours needs a server and a database. The repository's Pages site now shows an information page plus the legacy v1 app.

Host the server anywhere that runs Node 22 or Docker **with a persistent disk**:

- **Render**: `render.yaml` is included (web service + persistent disk). Persistent disks require a paid instance; free instances lose data on restart.
- **Docker** (Fly.io, Railway, a VPS, etc.): `docker build -t carehours . && docker run -p 3000:3000 -v carehours-data:/data -e NODE_ENV=production carehours`
- Always serve over **HTTPS** and schedule `npm run backup` to off-site, encrypted storage.

If you store protected health information, choose a host that will sign a **Business Associate Agreement** and complete the steps in [docs/SECURITY.md](docs/SECURITY.md).

## Moving from v1

1. Open the old app at `/legacy/` (on GitHub Pages: `https://tichaonadamis.github.io/home-care-agency/legacy/`) in the **same browser** that holds your data, sign in as Administrator, and choose **Download backup (JSON)**.
2. In v2, go to **Settings → Backup & import → Import from CareHours v1**.
3. Caregivers, clients and visits are imported. Old PINs are **not** imported; create user accounts for caregivers. Imported visits arrive as "pending approval".

## Project structure

```
server/
  index.js            entry point            app.js        Express app, security headers, errors
  db.js               SQLite + migrations    cli.js        backup, seed, export, purge
  migrations/         SQL schema & reference data
  lib/                auth, validation, rates, payroll/billing, trends, alerts, timeline, shift rules
  routes/             REST API by module
public/               single-page frontend (vanilla JS modules, no build step)
  js/ui.js            reusable components: forms, tables, modals, charts
  js/pages/           one module per page; portal.js is the caregiver interface
test/                 node:test suites
legacy/               CareHours v1 (static)
docs/                 architecture, security & compliance
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data model and API, and [docs/SECURITY.md](docs/SECURITY.md) for security controls and the deployment checklist.

## Important limitations

- CareHours is a **documentation and monitoring aid**. It does not diagnose, and its alerts, trend indicators and before/after views do not replace clinical judgment or emergency procedures.
- Payroll figures are **estimates** until reconciled with your payroll provider. Overtime rules are configurable per caregiver; confirm them against federal and state law.
- Implementing security controls does **not** make an organisation HIPAA-compliant. See [docs/SECURITY.md](docs/SECURITY.md).
- PDF output uses the browser's "Print → Save as PDF".
