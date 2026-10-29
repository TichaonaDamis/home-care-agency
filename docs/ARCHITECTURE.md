# Architecture

## Overview

```
Browser (vanilla JS SPA, no build)  ──HTTPS──▶  Express API (/api/*)  ──▶  SQLite (node:sqlite, WAL)
  public/js/pages/*  role-based UI            server/routes/*  validation, RBAC, audit      server/migrations/*.sql
```

- **Why SQLite?** It is a real relational database (foreign keys, constraints, transactions) in a single file, with nothing extra to run for a single agency or facility. All SQL is standard and kept in migrations; moving to PostgreSQL later means porting the migrations and the `db.js` wrapper.
- **Why no frontend framework?** v1 was plain HTML/CSS/JS. v2 keeps that stack (no build step) but splits it into reusable modules: `ui.js` holds the components and each page is its own module.
- **Server-side calculations:** hours, overtime, payroll, invoice amounts, trend indicators, alerts and permissions are all computed on the server. The browser only displays them.

## Data model (main tables)

| Domain | Tables |
|---|---|
| Users & security | `users` (role, linked caregiver), `sessions` (hashed tokens), `audit_log` |
| Configuration | `settings`, `facilities`, `client_categories`, `service_types`, `measurement_types` |
| Clients | `clients`, `client_contacts`, `client_category_links`, `client_services` (authorization + versioned bill rate), `care_plans` (versioned), `care_plan_acks`, `client_thresholds` |
| Caregivers | `caregivers`, `caregiver_pay_rates` (versioned), `credentials` |
| Scheduling & time | `assignments` (caregiver ↔ client, dated, many-to-many), `shifts` (schedule entry **and** visit/time record, with frozen pay/bill/mileage rate snapshots and approval) |
| Daily care | `adl_logs`, `meal_logs`, `activity_logs`, `observations` (all with client, author, timestamp, shift) |
| Medications | `medications`, `medication_changes` (history, verification, review), `med_events` (administration/assistance/refusal/discrepancy) |
| Health | `measurements` (value/value2/unit, method, notified, entered-in-error) |
| Oversight | `alerts` (lifecycle timestamps), `incidents`, `progress_reviews`, `transitions` (hospital/hospice/absence events) |
| Finance | `payroll_runs`, `payroll_items`, `payroll_adjustments`, `invoices`, `invoice_items`, `payments`, `expenses`, `report_runs` |

Conventions: money is stored in **integer cents**; dates are `YYYY-MM-DD`; agency-local wall-clock times are `HH:MM` / `YYYY-MM-DDTHH:MM` (the agency time zone is a setting); audit timestamps are ISO-8601 UTC.

### Historical rates
Pay and bill rates are rows with `effective_from`/`effective_to`. A new rate closes the previous row, and back-dating a rate before the latest one is rejected. When a shift is completed or approved, the rates in effect on its date are copied onto the shift (`pay_rate_cents`, `bill_rate_cents`, `bill_method`, `mileage_rate_cents`). Past payroll and invoices therefore never change when a rate is updated.

### Overtime
`server/lib/finance.js#allocateOvertime` assigns hours per shift chronologically over full Monday–Sunday workweeks: `weekly40`, `daily8_weekly40` (daily OT first, then weekly on the remaining regular hours, so no double counting) or `none`. Thresholds are settings. Overtime premium = OT hours × shift rate × the caregiver's multiplier. Payroll is labelled an estimate.

### Trend indicator
`server/lib/trends.js` compares the last 7 days with the 30 days before, using configurable rules: meal-intake drop, fluid drop, pain increase, falls increase, weight change, out-of-threshold measurements and unresolved high alerts. Each reason carries the IDs of its supporting records. Priority: requires review › possible decline › insufficient data › improving (≥ 2 signals) › stable.

## API summary

All endpoints are under `/api`, return JSON, require a session (except `/auth/login`, `/health`) and require `X-CareHours: 1` on non-GET requests.

| Module | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password` |
| Users | `GET/POST /users`, `PATCH /users/:id`, `POST /users/:id/reset-password` |
| Settings | `GET/PUT /settings`, `POST/PATCH /facilities`, `/categories`, `/service-types`, `/measurement-types`, `GET /audit`, `GET /backup`, `POST /import/legacy` |
| Clients | `GET/POST /clients`, `GET/PATCH /clients/:id`, contacts, `POST /clients/:id/services`, `PATCH /client-services/:id`, care plans (`GET/POST /clients/:id/care-plans`, `POST /care-plans/:id/ack`), thresholds, `GET /clients/:id/progress`, reviews |
| Caregivers | `GET/POST /caregivers`, `GET/PATCH /caregivers/:id`, `POST /caregivers/:id/pay-rates`, credentials |
| Scheduling | `GET/POST /assignments`, `PATCH /assignments/:id`, `POST /assignments/:id/approve`, `POST /assignments/:id/generate`, `GET/POST /shifts`, `GET/PATCH /shifts/:id`, `POST /shifts/:id/start`, `POST /shifts/clock-in`, `GET /shifts/:id/checklist`, `POST /shifts/:id/end`, `POST /shifts/:id/complete-docs`, `POST /shifts/:id/approve`, `POST /shifts/approve-batch`, `POST /shifts/:id/reject`, `POST /shifts/:id/status`, `GET /coverage` |
| Care logs | `POST /care/adl`, `/care/meals`, `/care/activities`, `/care/observations`, `GET /care/logs` |
| Medications | `GET/POST /clients/:id/medications`, `GET /medications`, `PATCH /medications/:id`, `GET /medication-changes`, `POST /medication-changes/:id/verify`, `PATCH /medication-changes/:id`, `GET /medication-changes/:id/compare`, `POST /clients/:id/reconcile-medications`, `GET/POST /med-events` |
| Health | `GET /measurement-types`, `GET/POST /measurements`, `POST /measurements/:id/entered-in-error`, `GET /clients/:id/health-summary`, `GET /health/overdue` |
| Oversight | `GET/POST /incidents`, `PATCH /incidents/:id`, `GET /alerts`, `POST /alerts/:id/(acknowledge|escalate|resolve)`, `GET /transitions`, `POST /clients/:id/transitions`, `PATCH /transitions/:id` |
| Finance | `GET /payroll/preview`, `GET/POST /payroll/runs`, `GET /payroll/runs/:id`, `POST /payroll/runs/:id/(approve|process|void)`, adjustments, `GET /invoices`, `GET /invoices/preview`, `POST /invoices`, `GET /invoices/:id`, items, issue, void, payments, expenses, `GET /finance/summary` |
| Reports | `GET /reports/timesheet`, `GET /reports/timesheet.csv`, `GET /reports/monthly?type=client_health|caregiver_activity|financial|operations&month=YYYY-MM`, `GET /reports/runs` |
| Dashboard | `GET /dashboard`, `GET /notifications`, `GET /search`, `GET /me/dashboard`, `GET /me/timesheet` |

## Implementation roadmap status

| Phase | Scope | Status |
|---|---|---|
| 1 | Inspect v1, preserve styling, authentication & permissions | Done |
| 2 | Client & caregiver registration, assignments | Done |
| 3 | Schedules, visits, timekeeping, care logs, service authorizations | Done |
| 4 | Medications, measurements, behavior, transitions, alerts | Done |
| 5 | Payroll, billing, financial reports, monthly exports | Done |
| 6 | Trends, progress summaries, dashboards, audit, hardening, tests | Done; see SECURITY.md "Known gaps" for next steps |
