-- Default configuration and reference lists. All are editable in Settings.

INSERT INTO settings (key, value) VALUES
  ('agency_name', '"CareHours"'),
  ('timezone', '"America/Los_Angeles"'),
  ('session_idle_minutes', '30'),
  ('session_max_hours', '12'),
  ('clock_in_early_minutes', '15'),
  ('clock_in_late_minutes', '120'),
  ('weekly_ot_threshold', '40'),
  ('daily_ot_threshold', '8'),
  ('credential_warning_days', '30'),
  ('invoice_due_days', '30'),
  ('trend_rules', '{"minRecords":3,"weightChangePct":5,"fluidDropPct":25,"mealIntakeDropPct":20,"painIncrease":2,"fallsIncrease":1,"missedMealsWindowDays":3,"missedMealsCount":2}'),
  ('notifications', '{"upcomingShiftHours":24,"missedVisitGraceMinutes":60,"carePlanReviewDays":14,"dischargeFollowUpDays":3}'),
  ('expense_categories', '["Supplies","Rent / mortgage","Utilities","Food","Insurance","Training","Transportation","Other"]');

INSERT INTO facilities (name, kind) VALUES ('Main Office', 'home_care');

INSERT INTO client_categories (name) VALUES
  ('Adult Family Home resident'),
  ('Home care client'),
  ('Assisted-living resident'),
  ('Short-term / respite'),
  ('Dementia / cognitive support'),
  ('Mobility assistance'),
  ('Personal-care assistance'),
  ('Hospice / end-of-life care');

INSERT INTO service_types (code, name) VALUES
  ('HYG',  'Personal hygiene & grooming'),
  ('BATH', 'Bathing & dressing assistance'),
  ('MOB',  'Mobility & transfer assistance'),
  ('MEAL', 'Meal preparation & feeding assistance'),
  ('MED',  'Medication assistance / administration'),
  ('COMP', 'Companionship & social engagement'),
  ('TRAN', 'Transportation & appointments'),
  ('HOUSE','Housekeeping & laundry'),
  ('DEM',  'Dementia-related support'),
  ('VIT',  'Vital-sign monitoring'),
  ('HOSP', 'Hospice supportive care'),
  ('RES',  'Residential care (AFH day rate)');

-- Default thresholds are placeholders for facility policy, NOT clinical guidance.
-- An authorized clinician should set individualized thresholds per client.
INSERT INTO measurement_types (code, name, unit, has_second_value, default_low, default_high, default_low2, default_high2, caregiver_may_record, expected_every_days, sort) VALUES
  ('bp',      'Blood pressure',   'mmHg',  1, 90, 160, 50, 100, 1, NULL, 1),
  ('glucose', 'Blood glucose',    'mg/dL', 0, 70, 250, NULL, NULL, 0, NULL, 2),
  ('weight',  'Weight',           'lb',    0, NULL, NULL, NULL, NULL, 1, 30, 3),
  ('temp',    'Temperature',      '°F',    0, 95, 100.4, NULL, NULL, 1, NULL, 4),
  ('pulse',   'Pulse',            'bpm',   0, 50, 110, NULL, NULL, 1, NULL, 5),
  ('resp',    'Respiratory rate', 'breaths/min', 0, 10, 24, NULL, NULL, 1, NULL, 6),
  ('spo2',    'Oxygen saturation','%',     0, 92, NULL, NULL, NULL, 1, NULL, 7),
  ('pain',    'Pain score',       '0-10',  0, NULL, 6, NULL, NULL, 1, NULL, 8);
