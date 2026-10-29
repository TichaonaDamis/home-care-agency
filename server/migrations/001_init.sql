-- CareHours v2 initial schema.
-- Conventions: money in integer cents (*_cents), dates 'YYYY-MM-DD',
-- local wall-clock times 'HH:MM', local datetimes 'YYYY-MM-DDTHH:MM' (agency time zone),
-- audit timestamps ISO-8601 UTC (created_at etc.). is_sample = 1 marks generated demo data.

PRAGMA foreign_keys = ON;

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE facilities (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL DEFAULT 'afh' CHECK (kind IN ('afh','home_care','assisted_living','residential','other')),
  address    TEXT,
  phone      TEXT,
  capacity   INTEGER,
  active     INTEGER NOT NULL DEFAULT 1,
  is_sample  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------- people ----------
CREATE TABLE caregivers (
  id                     INTEGER PRIMARY KEY,
  code                   TEXT NOT NULL UNIQUE,
  full_name              TEXT NOT NULL,
  phone                  TEXT,
  email                  TEXT,
  address                TEXT,
  emergency_name         TEXT,
  emergency_phone        TEXT,
  employment_status      TEXT NOT NULL DEFAULT 'active' CHECK (employment_status IN ('applicant','active','on_leave','terminated')),
  employment_class       TEXT NOT NULL DEFAULT 'w2_hourly' CHECK (employment_class IN ('w2_hourly','w2_salaried','per_diem','contractor')),
  hire_date              TEXT,
  termination_date       TEXT,
  overtime_rule          TEXT NOT NULL DEFAULT 'weekly40' CHECK (overtime_rule IN ('weekly40','daily8_weekly40','none')),
  ot_multiplier          REAL NOT NULL DEFAULT 1.5,
  mileage_rate_cents     INTEGER NOT NULL DEFAULT 0,
  background_status      TEXT NOT NULL DEFAULT 'not_started' CHECK (background_status IN ('not_started','pending','cleared','flagged','not_required')),
  background_date        TEXT,
  med_authority          TEXT NOT NULL DEFAULT 'assist' CHECK (med_authority IN ('none','assist','administer')),
  responsibilities       TEXT,
  restrictions           TEXT,
  availability           TEXT,
  facility_id            INTEGER REFERENCES facilities(id),
  is_sample              INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT
);

-- Pay-rate history: a new row per change; prior rows get effective_to set.
CREATE TABLE caregiver_pay_rates (
  id             INTEGER PRIMARY KEY,
  caregiver_id   INTEGER NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  rate_cents     INTEGER NOT NULL CHECK (rate_cents >= 0),
  effective_from TEXT NOT NULL,
  effective_to   TEXT,
  created_by     INTEGER,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_pay_rates_cg ON caregiver_pay_rates(caregiver_id, effective_from);

CREATE TABLE credentials (
  id           INTEGER PRIMARY KEY,
  caregiver_id INTEGER NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  number       TEXT,
  issued_on    TEXT,
  expires_on   TEXT,
  verified     INTEGER NOT NULL DEFAULT 0,
  required     INTEGER NOT NULL DEFAULT 1,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_credentials_exp ON credentials(expires_on);

CREATE TABLE users (
  id                   INTEGER PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name         TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('admin','manager','nurse','caregiver')),
  caregiver_id         INTEGER UNIQUE REFERENCES caregivers(id),
  active               INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  failed_logins        INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  last_login_at        TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (role <> 'caregiver' OR caregiver_id IS NOT NULL)
);

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  ip           TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ---------- clients ----------
CREATE TABLE clients (
  id                   INTEGER PRIMARY KEY,
  code                 TEXT NOT NULL UNIQUE,
  legal_name           TEXT NOT NULL,
  preferred_name       TEXT,
  dob                  TEXT,
  address              TEXT,
  facility_id          INTEGER REFERENCES facilities(id),
  room                 TEXT,
  phone                TEXT,
  email                TEXT,
  allergies            TEXT,
  alerts               TEXT,
  diet                 TEXT,
  pcp_name             TEXT,
  pcp_phone            TEXT,
  admission_date       TEXT,
  discharge_date       TEXT,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hospitalized','temporarily_away','discharged','deceased','other')),
  hospice_status       TEXT NOT NULL DEFAULT 'none' CHECK (hospice_status IN ('none','referred','evaluating','enrolled','discharged')),
  consent_notes        TEXT,
  contact_preferences  TEXT,
  min_fluid_ml         INTEGER,
  meds_reconciled_on   TEXT,
  meds_reconciled_by   INTEGER REFERENCES users(id),
  is_sample            INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT
);
CREATE INDEX idx_clients_status ON clients(status);

CREATE TABLE client_contacts (
  id               INTEGER PRIMARY KEY,
  client_id        INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('emergency','representative','care_team','family','other')),
  name             TEXT NOT NULL,
  relationship     TEXT,
  phone            TEXT,
  email            TEXT,
  is_decision_maker INTEGER NOT NULL DEFAULT 0,
  notes            TEXT
);
CREATE INDEX idx_contacts_client ON client_contacts(client_id);

CREATE TABLE client_categories (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE client_category_links (
  client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES client_categories(id),
  PRIMARY KEY (client_id, category_id)
);

CREATE TABLE service_types (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1
);

-- Service authorization + billing rate, versioned by effective dates.
CREATE TABLE client_services (
  id              INTEGER PRIMARY KEY,
  client_id       INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service_type_id INTEGER NOT NULL REFERENCES service_types(id),
  effective_from  TEXT NOT NULL,
  effective_to    TEXT,
  frequency       TEXT,
  instructions    TEXT,
  responsible     TEXT,
  bill_method     TEXT NOT NULL DEFAULT 'hourly' CHECK (bill_method IN ('hourly','per_visit','daily','monthly','not_billed')),
  bill_rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (bill_rate_cents >= 0),
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_client_services ON client_services(client_id, service_type_id, effective_from);

-- Care plans: each edit creates a new version; older ones are 'superseded'.
CREATE TABLE care_plans (
  id             INTEGER PRIMARY KEY,
  client_id      INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
  effective_date TEXT NOT NULL,
  review_due     TEXT,
  summary        TEXT,
  goals          TEXT,
  instructions   TEXT,
  adl_tasks      TEXT,           -- newline-separated tasks caregivers must document each shift
  mobility       TEXT,
  diet           TEXT,
  behavior_support TEXT,
  requires_ack   INTEGER NOT NULL DEFAULT 1,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (client_id, version)
);
CREATE TABLE care_plan_acks (
  care_plan_id    INTEGER NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  caregiver_id    INTEGER NOT NULL REFERENCES caregivers(id),
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (care_plan_id, caregiver_id)
);

-- ---------- assignments & shifts ----------
CREATE TABLE assignments (
  id               INTEGER PRIMARY KEY,
  caregiver_id     INTEGER NOT NULL REFERENCES caregivers(id),
  client_id        INTEGER NOT NULL REFERENCES clients(id),
  facility_id      INTEGER REFERENCES facilities(id),
  service_type_id  INTEGER REFERENCES service_types(id),
  start_date       TEXT NOT NULL,
  end_date         TEXT,
  days_of_week     TEXT NOT NULL DEFAULT '1,2,3,4,5',   -- 0=Sun..6=Sat
  shift_start      TEXT NOT NULL,
  shift_end        TEXT NOT NULL,
  responsibilities TEXT,
  pay_rate_cents   INTEGER,    -- optional override of caregiver's standard rate
  bill_rate_cents  INTEGER,    -- optional override of client's service rate
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','ended','cancelled')),
  approved_by      INTEGER REFERENCES users(id),
  approved_at      TEXT,
  override_reason  TEXT,
  is_sample        INTEGER NOT NULL DEFAULT 0,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX idx_assign_cg ON assignments(caregiver_id, start_date);
CREATE INDEX idx_assign_client ON assignments(client_id, start_date);

-- A shift is both the schedule entry and (once worked) the visit/time record.
CREATE TABLE shifts (
  id                 INTEGER PRIMARY KEY,
  assignment_id      INTEGER REFERENCES assignments(id),
  caregiver_id       INTEGER REFERENCES caregivers(id),      -- NULL = unfilled/open shift
  client_id          INTEGER NOT NULL REFERENCES clients(id),
  facility_id        INTEGER REFERENCES facilities(id),
  service_type_id    INTEGER REFERENCES service_types(id),
  date               TEXT NOT NULL,
  sched_start        TEXT NOT NULL,
  sched_end          TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('open','scheduled','in_progress','completed','missed','cancelled')),
  actual_start       TEXT,
  actual_end         TEXT,
  break_min          INTEGER NOT NULL DEFAULT 0 CHECK (break_min >= 0),
  mileage            REAL NOT NULL DEFAULT 0 CHECK (mileage >= 0),
  pay_rate_cents     INTEGER,     -- snapshot of effective rate, frozen at completion
  bill_rate_cents    INTEGER,
  bill_method        TEXT,
  mileage_rate_cents INTEGER,
  notes              TEXT,
  doc_complete       INTEGER NOT NULL DEFAULT 0,
  exception_note     TEXT,
  approval_status    TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','rejected')),
  approved_by        INTEGER REFERENCES users(id),
  approved_at        TEXT,
  override_reason    TEXT,
  source             TEXT NOT NULL DEFAULT 'schedule' CHECK (source IN ('schedule','manual','clock','legacy_import')),
  is_sample          INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT
);
CREATE INDEX idx_shifts_date ON shifts(date);
CREATE INDEX idx_shifts_cg ON shifts(caregiver_id, date);
CREATE INDEX idx_shifts_client ON shifts(client_id, date);

-- ---------- daily care documentation ----------
CREATE TABLE adl_logs (
  id          INTEGER PRIMARY KEY,
  client_id   INTEGER NOT NULL REFERENCES clients(id),
  shift_id    INTEGER REFERENCES shifts(id),
  author_id   INTEGER NOT NULL REFERENCES users(id),
  recorded_at TEXT NOT NULL,
  task        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('completed','partial','declined','not_applicable','not_completed')),
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_adl_client ON adl_logs(client_id, recorded_at);

CREATE TABLE meal_logs (
  id                INTEGER PRIMARY KEY,
  client_id         INTEGER NOT NULL REFERENCES clients(id),
  shift_id          INTEGER REFERENCES shifts(id),
  author_id         INTEGER NOT NULL REFERENCES users(id),
  recorded_at       TEXT NOT NULL,
  meal              TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack','fluids_only')),
  offered           TEXT,
  percent_consumed  INTEGER CHECK (percent_consumed IS NULL OR percent_consumed BETWEEN 0 AND 100),
  fluid_ml          INTEGER CHECK (fluid_ml IS NULL OR fluid_ml >= 0),
  appetite          TEXT CHECK (appetite IS NULL OR appetite IN ('usual','increased','decreased','poor')),
  swallowing_issue  INTEGER NOT NULL DEFAULT 0,
  refused           INTEGER NOT NULL DEFAULT 0,
  assistance        TEXT CHECK (assistance IS NULL OR assistance IN ('none','setup','partial','full')),
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_meal_client ON meal_logs(client_id, recorded_at);

CREATE TABLE activity_logs (
  id            INTEGER PRIMARY KEY,
  client_id     INTEGER NOT NULL REFERENCES clients(id),
  shift_id      INTEGER REFERENCES shifts(id),
  author_id     INTEGER NOT NULL REFERENCES users(id),
  recorded_at   TEXT NOT NULL,
  activity      TEXT NOT NULL,
  minutes       INTEGER CHECK (minutes IS NULL OR minutes >= 0),
  participation TEXT CHECK (participation IS NULL OR participation IN ('active','partial','passive','declined')),
  tolerance     TEXT CHECK (tolerance IS NULL OR tolerance IN ('good','fair','poor')),
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_activity_client ON activity_logs(client_id, recorded_at);

-- Behavior / mood / general condition. Structured, descriptive — not diagnostic.
CREATE TABLE observations (
  id             INTEGER PRIMARY KEY,
  client_id      INTEGER NOT NULL REFERENCES clients(id),
  shift_id       INTEGER REFERENCES shifts(id),
  author_id      INTEGER NOT NULL REFERENCES users(id),
  recorded_at    TEXT NOT NULL,
  mood           TEXT CHECK (mood IS NULL OR mood IN ('calm','content','cheerful','withdrawn','sad','irritable','anxious','other')),
  alertness      TEXT CHECK (alertness IS NULL OR alertness IN ('alert_oriented','alert_confused','drowsy','difficult_to_rouse')),
  sleep          TEXT CHECK (sleep IS NULL OR sleep IN ('good','fair','poor','not_observed')),
  agitation      INTEGER NOT NULL DEFAULT 0,
  distress       INTEGER NOT NULL DEFAULT 0,
  pain_score     INTEGER CHECK (pain_score IS NULL OR pain_score BETWEEN 0 AND 10),
  energy         TEXT CHECK (energy IS NULL OR energy IN ('usual','increased','decreased')),
  fall_event     TEXT NOT NULL DEFAULT 'none' CHECK (fall_event IN ('none','near_fall','fall')),
  skin_change    INTEGER NOT NULL DEFAULT 0,
  other_change   TEXT,
  observation    TEXT,
  action_taken   TEXT,
  notified       TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_obs_client ON observations(client_id, recorded_at);

-- ---------- medications ----------
CREATE TABLE medications (
  id           INTEGER PRIMARY KEY,
  client_id    INTEGER NOT NULL REFERENCES clients(id),
  name         TEXT NOT NULL,
  strength     TEXT,
  form         TEXT,
  dose         TEXT,
  route        TEXT,
  frequency    TEXT,
  times        TEXT,            -- comma-separated HH:MM scheduled times
  prn          INTEGER NOT NULL DEFAULT 0,
  prescriber   TEXT,
  pharmacy     TEXT,
  start_date   TEXT,
  stop_date    TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_hold','discontinued')),
  instructions TEXT,
  precautions  TEXT,
  order_source TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT
);
CREATE INDEX idx_meds_client ON medications(client_id, status);

CREATE TABLE medication_changes (
  id             INTEGER PRIMARY KEY,
  medication_id  INTEGER NOT NULL REFERENCES medications(id),
  client_id      INTEGER NOT NULL REFERENCES clients(id),
  change_type    TEXT NOT NULL CHECK (change_type IN ('started','discontinued','dose_change','frequency_change','route_change','instructions_updated','held','resumed','other')),
  effective_date TEXT NOT NULL,
  previous_value TEXT,
  new_value      TEXT,
  details        TEXT,
  order_source   TEXT,
  documented_by  INTEGER NOT NULL REFERENCES users(id),
  verified       INTEGER NOT NULL DEFAULT 0,
  verified_by    INTEGER REFERENCES users(id),
  verified_at    TEXT,
  follow_up      TEXT,
  review_status  TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','in_review','closed')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_medchg_client ON medication_changes(client_id, effective_date);

CREATE TABLE med_events (
  id                 INTEGER PRIMARY KEY,
  medication_id      INTEGER NOT NULL REFERENCES medications(id),
  client_id          INTEGER NOT NULL REFERENCES clients(id),
  shift_id           INTEGER REFERENCES shifts(id),
  author_id          INTEGER NOT NULL REFERENCES users(id),
  scheduled_for      TEXT,     -- local datetime of the scheduled dose
  action             TEXT NOT NULL CHECK (action IN ('administered','assisted','refused','omitted','held','discrepancy')),
  actual_time        TEXT,
  dose_given         TEXT,
  notes              TEXT,
  adverse_observation TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_medevents_client ON med_events(client_id, scheduled_for);

-- ---------- health measurements ----------
CREATE TABLE measurement_types (
  code              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  unit              TEXT NOT NULL,
  has_second_value  INTEGER NOT NULL DEFAULT 0,   -- blood pressure: value = systolic, value2 = diastolic
  default_low       REAL,
  default_high      REAL,
  default_low2      REAL,
  default_high2     REAL,
  caregiver_may_record INTEGER NOT NULL DEFAULT 1,
  expected_every_days  INTEGER,                    -- for overdue detection; NULL = no schedule
  active            INTEGER NOT NULL DEFAULT 1,
  sort              INTEGER NOT NULL DEFAULT 0
);

-- Individualized thresholds set by an authorized clinician / facility policy.
CREATE TABLE client_thresholds (
  client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type_code   TEXT NOT NULL REFERENCES measurement_types(code),
  low         REAL,
  high        REAL,
  low2        REAL,
  high2       REAL,
  expected_every_days INTEGER,
  escalation  TEXT,
  approved_by TEXT,
  set_by      INTEGER REFERENCES users(id),
  set_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (client_id, type_code)
);

CREATE TABLE measurements (
  id                 INTEGER PRIMARY KEY,
  client_id          INTEGER NOT NULL REFERENCES clients(id),
  shift_id           INTEGER REFERENCES shifts(id),
  type_code          TEXT NOT NULL REFERENCES measurement_types(code),
  value              REAL NOT NULL,
  value2             REAL,
  unit               TEXT NOT NULL,
  measured_at        TEXT NOT NULL,
  method             TEXT,
  symptoms           TEXT,
  follow_up          TEXT,
  clinician_notified INTEGER NOT NULL DEFAULT 0,
  recorded_by        INTEGER NOT NULL REFERENCES users(id),
  entered_in_error   INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_meas_client ON measurements(client_id, type_code, measured_at);

-- ---------- incidents, alerts, reviews ----------
CREATE TABLE incidents (
  id               INTEGER PRIMARY KEY,
  client_id        INTEGER REFERENCES clients(id),
  shift_id         INTEGER REFERENCES shifts(id),
  reported_by      INTEGER NOT NULL REFERENCES users(id),
  occurred_at      TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('fall','injury','medication_discrepancy','missed_task','sudden_change','behavior','elopement','property','other')),
  severity         TEXT NOT NULL CHECK (severity IN ('low','moderate','high','critical')),
  description      TEXT NOT NULL,
  immediate_action TEXT,
  notified         TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','closed')),
  follow_up        TEXT,
  reviewed_by      INTEGER REFERENCES users(id),
  closed_at        TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_incidents_client ON incidents(client_id, occurred_at);

CREATE TABLE alerts (
  id              INTEGER PRIMARY KEY,
  client_id       INTEGER REFERENCES clients(id),
  category        TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('info','low','medium','high')),
  message         TEXT NOT NULL,
  escalation      TEXT,
  source_type     TEXT,
  source_id       INTEGER,
  dedupe_key      TEXT UNIQUE,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','escalated','resolved')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  acknowledged_by INTEGER REFERENCES users(id),
  acknowledged_at TEXT,
  escalated_by    INTEGER REFERENCES users(id),
  escalated_at    TEXT,
  escalation_note TEXT,
  resolved_by     INTEGER REFERENCES users(id),
  resolved_at     TEXT,
  resolution      TEXT
);
CREATE INDEX idx_alerts_status ON alerts(status, created_at);

CREATE TABLE progress_reviews (
  id           INTEGER PRIMARY KEY,
  client_id    INTEGER NOT NULL REFERENCES clients(id),
  author_id    INTEGER NOT NULL REFERENCES users(id),
  period_from  TEXT,
  period_to    TEXT,
  assessment   TEXT NOT NULL CHECK (assessment IN ('improving','stable','possible_decline','requires_review')),
  summary      TEXT NOT NULL,
  action_taken TEXT,
  concern_resolved_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------- care transitions ----------
CREATE TABLE transitions (
  id              INTEGER PRIMARY KEY,
  client_id       INTEGER NOT NULL REFERENCES clients(id),
  event_type      TEXT NOT NULL CHECK (event_type IN ('ed_visit','hospital_admission','hospital_discharge','return_home','temporary_absence','hospice_referral','hospice_evaluation','hospice_admission','hospice_discharge','facility_discharge','deceased','care_plan_change')),
  event_date      TEXT NOT NULL,
  status          TEXT,
  location        TEXT,
  provider        TEXT,
  contact         TEXT,
  source          TEXT,
  notes           TEXT,
  service_impact  TEXT,
  follow_up_due   TEXT,
  follow_up_done  TEXT,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_transitions_client ON transitions(client_id, event_date);

-- ---------- finance ----------
CREATE TABLE payroll_adjustments (
  id           INTEGER PRIMARY KEY,
  caregiver_id INTEGER NOT NULL REFERENCES caregivers(id),
  date         TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE payroll_runs (
  id            INTEGER PRIMARY KEY,
  period_from   TEXT NOT NULL,
  period_to     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','processed','void')),
  total_cents   INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_by   INTEGER REFERENCES users(id),
  approved_at   TEXT,
  processed_at  TEXT,
  notes         TEXT
);
CREATE TABLE payroll_items (
  id                 INTEGER PRIMARY KEY,
  run_id             INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  caregiver_id       INTEGER NOT NULL REFERENCES caregivers(id),
  regular_hours      REAL NOT NULL,
  overtime_hours     REAL NOT NULL,
  regular_cents      INTEGER NOT NULL,
  overtime_cents     INTEGER NOT NULL,
  miles              REAL NOT NULL,
  mileage_cents      INTEGER NOT NULL,
  adjustments_cents  INTEGER NOT NULL,
  gross_cents        INTEGER NOT NULL,
  shift_ids          TEXT NOT NULL
);

CREATE TABLE invoices (
  id           INTEGER PRIMARY KEY,
  number       TEXT NOT NULL UNIQUE,
  client_id    INTEGER NOT NULL REFERENCES clients(id),
  period_from  TEXT NOT NULL,
  period_to    TEXT NOT NULL,
  issue_date   TEXT,
  due_date     TEXT,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','partially_paid','paid','void')),
  total_cents  INTEGER NOT NULL DEFAULT 0,
  notes        TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_invoices_client ON invoices(client_id, period_from);

CREATE TABLE invoice_items (
  id              INTEGER PRIMARY KEY,
  invoice_id      INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('service','mileage','fee','credit')),
  shift_id        INTEGER REFERENCES shifts(id),
  service_type_id INTEGER REFERENCES service_types(id),
  date            TEXT,
  description     TEXT NOT NULL,
  quantity        REAL NOT NULL,
  unit            TEXT NOT NULL,
  rate_cents      INTEGER NOT NULL,
  amount_cents    INTEGER NOT NULL
);
-- A shift may be billed on at most one non-void invoice (enforced in code; index speeds the check).
CREATE INDEX idx_invoice_items_shift ON invoice_items(shift_id);

CREATE TABLE payments (
  id           INTEGER PRIMARY KEY,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id),
  date         TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method       TEXT,
  reference    TEXT,
  recorded_by  INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE expenses (
  id           INTEGER PRIMARY KEY,
  date         TEXT NOT NULL,
  category     TEXT NOT NULL,
  description  TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  facility_id  INTEGER REFERENCES facilities(id),
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE report_runs (
  id           INTEGER PRIMARY KEY,
  report_type  TEXT NOT NULL,
  params       TEXT NOT NULL,
  generated_by INTEGER REFERENCES users(id),
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------- audit ----------
CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY,
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id   INTEGER,
  username  TEXT,
  action    TEXT NOT NULL,       -- create / update / delete / view / login / login_failed / approve / export ...
  entity    TEXT NOT NULL,
  entity_id INTEGER,
  client_id INTEGER,
  details   TEXT,                -- JSON of changed field names / before-after for financial fields
  ip        TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
