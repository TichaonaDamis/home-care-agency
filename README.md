# CareHours – Home Care Agency Timesheets

A simple website where caregivers log the hours they work and the office runs reports on them.

**Live site:** https://tichaonadamis.github.io/home-care-agency/

## Features

**Caregivers**
- Sign in with name + PIN
- One-tap **Clock in / Clock out**, with a live shift timer
- Log or edit visits by hand: client, date, start/end, break, mileage
- Overnight shifts handled (e.g. 10 PM – 6 AM)
- Checklist of care provided (bathing, meals, medication reminders, …) plus visit notes
- Weekly timesheet with totals and overtime

**Administrator**
- Reports for any date range, filtered by caregiver or client
- Hours by caregiver (visits, hours, weekly overtime over 40 h, mileage, estimated pay at 1.5× for OT)
- Hours by client
- Full visit list, with edit and delete
- Export to CSV (Excel / payroll) and print-friendly layout
- Manage caregivers (PIN, hourly rate, active/inactive) and clients
- Agency name, admin PIN, and care-task list are all configurable
- Backup / restore to a JSON file; demo data loader

## Getting started

1. Open the site and sign in as **Administrator** with PIN **`0000`**.
2. Go to **Settings** and change the admin PIN right away.
3. Add your caregivers and clients under **Caregivers & Clients**.
4. Caregivers sign in on the same device and start logging hours.

Click **Load demo data** in Settings to try it out (demo PINs: Maria 1111, James 2222, Aisha 3333).

## Important: where the data is stored

This version is a static site (no server), so it can be hosted free on GitHub Pages.
All data is saved in the **browser's local storage on the device you use**:

- Caregivers and admin must use the **same device/browser** (e.g. an office tablet), or
  move data between devices with **Backup** / **Restore**.
- Clearing browser data erases it, so **download backups regularly**.
- PINs keep honest people out of each other's timesheets but are **not real security**.
  Don't store protected health information (diagnoses, medications) in the notes.

To let caregivers log from their own phones into one shared database, the next step is
a hosted backend (e.g. Firebase or Supabase) with real logins.

## Running locally

No build step. Open `index.html` in a browser, or:

```bash
python3 -m http.server 8000
```

## Files

- `index.html` – page layout
- `styles.css` – styling (light/dark mode, mobile friendly, print styles)
- `app.js` – all app logic and storage
