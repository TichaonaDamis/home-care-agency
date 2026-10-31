# Deploying CareHours: DigitalOcean or Google Cloud

Both options use the same setup: one small Ubuntu server, **Caddy** for automatic HTTPS, CareHours as a background service, a firewall, and nightly backups. The script in `deploy/` does nearly all of it.

| | DigitalOcean (pilot / sample data) | Google Cloud (real client data) |
|---|---|---|
| Server | Basic Droplet, ~$6/mo | Compute Engine e2-small, ~$12–15/mo |
| HIPAA agreement (BAA) | Request from DigitalOcean sales; confirm in writing whether a paid support plan is required | Accept in the console, no extra cost; confirm Compute Engine is on Google's HIPAA covered-products list |
| Server backups | "Backups" checkbox (+20–30% of server price) | Snapshot schedule (pay for storage used) |

> **Do not put real client information on any server until the BAA is in place** and you have worked through `docs/SECURITY.md`.

## What you need first
1. **A domain name.** You can use one you already own (e.g. at Bluehost), such as `care.youragency.com`. HTTPS requires a domain.
2. **An SSH key** on your computer (the cloud consoles also offer browser-based SSH, which works too).
3. About 30 minutes.

---

## Option A: DigitalOcean

1. **Create the server.** Sign in at cloud.digitalocean.com → **Create → Droplets**.
   - Region: the one closest to your agency.
   - Image: **Ubuntu 24.04 (LTS) x64**.
   - Size: **Basic → Regular → $6/mo (1 GB / 1 CPU)**.
   - Authentication: **SSH key** (recommended) or password.
   - Tick **Enable automated backups** (weekly is fine for a pilot; daily for real data).
   - Hostname: `carehours`. Click **Create Droplet** and copy its **IPv4 address**.
2. **Point your domain at it.** At your domain provider (e.g. Bluehost → Domains → DNS), add an **A record**: host `care` (or whatever subdomain you chose) → the Droplet IP. Wait until `ping care.youragency.com` shows that IP (usually minutes, sometimes up to an hour).
3. **Install CareHours.** In the Droplet page click **Console** (or `ssh root@YOUR_IP`) and run:
   ```bash
   curl -fsSLO https://raw.githubusercontent.com/TichaonaDamis/home-care-agency/main/deploy/setup-ubuntu.sh
   sudo bash setup-ubuntu.sh care.youragency.com
   ```
   At the end it prints the **first administrator username and temporary password**.
4. **Sign in** at `https://care.youragency.com`, change the password, then go to **Settings** and set your agency name and time zone.
5. **(Optional) DigitalOcean Cloud Firewall:** Networking → Firewalls → allow inbound 22, 80, 443 only, and apply it to the Droplet. The server's own firewall (ufw) is already on.
6. **For real client data:** contact DigitalOcean sales to execute the BAA *before* adding real clients, and confirm whether a Standard/Premium support plan is required.

## Option B: Google Cloud

1. **Create a project and billing.** console.cloud.google.com → project picker → **New project** (e.g. `carehours`). Attach a billing account.
2. **Accept the HIPAA BAA** (before any real client data): in the console search bar type **"Privacy & Security"**, open it, and review and accept the Google Cloud Business Associate Agreement. Check that **Compute Engine** is on Google's list of HIPAA-covered products.
3. **Create the server.** **Compute Engine → VM instances → Create instance** (enable the Compute Engine API if asked).
   - Name `carehours`; Region: a US region near you (e.g. `us-central1`).
   - Machine type: **e2-small** (an **e2-micro** works for a tiny pilot and may fall under the free tier in some US regions).
   - Boot disk: **Ubuntu 24.04 LTS**, **Balanced persistent disk, 20 GB**.
   - Firewall: tick **Allow HTTP traffic** and **Allow HTTPS traffic**.
   - Click **Create**.
4. **Give it a fixed address.** **VPC network → IP addresses** → find the VM's external IP → **Promote to static**. Copy it.
5. **Point your domain at it:** add an **A record** at your domain provider (same as DigitalOcean step 2).
6. **Install CareHours.** On the VM list click **SSH** and run:
   ```bash
   curl -fsSLO https://raw.githubusercontent.com/TichaonaDamis/home-care-agency/main/deploy/setup-ubuntu.sh
   sudo bash setup-ubuntu.sh care.youragency.com
   ```
   Note the administrator password it prints, then sign in at `https://care.youragency.com`.
7. **Disk snapshots:** **Compute Engine → Snapshots → Create snapshot schedule** (daily, keep 14 days), then open the VM's boot disk → **Edit** → attach the schedule.
8. **(Recommended) Off-site backup copies:** create a Cloud Storage bucket in the same region (uniform access, no public access). Give the VM's service account the **Storage Object Creator** role on the bucket, then on the server:
   ```bash
   echo 'OFFSITE="gs://YOUR-BUCKET/carehours"' | sudo tee /etc/default/carehours-backup
   sudo systemctl start carehours-backup   # test it now
   ```
   If the copy fails with a permission error, stop the VM, open **Edit → API and identity management**, set **Storage** access to *Read Write*, and start it again.

---

## After installing (both options)

| Task | Command |
|---|---|
| Check the app is running | `systemctl status carehours` |
| View recent logs | `journalctl -u carehours -n 100` |
| Run a backup now | `sudo systemctl start carehours-backup` then `ls /var/backups/carehours` |
| See the backup schedule | `systemctl list-timers carehours-backup.timer` (runs nightly at 02:30) |
| Update to the latest version | `sudo bash /opt/carehours/deploy/update.sh` (backs up first) |
| Load demo data (testing only) | `cd /opt/carehours && sudo -u carehours env DATABASE_FILE=/var/lib/carehours/carehours.sqlite node --disable-warning=ExperimentalWarning server/cli.js seed` |
| Remove demo data before go-live | same command with `purge-sample` instead of `seed` |

**Restoring a backup:** `sudo systemctl stop carehours`, copy the chosen file over `/var/lib/carehours/carehours.sqlite` (owned by `carehours`, mode 600), delete any `carehours.sqlite-wal` / `-shm` files next to it, then `sudo systemctl start carehours`. Practise this once before go-live and record the result.

## Phones
Caregivers use the same address in their phone browser: `https://care.youragency.com`. (An installable "Add to Home Screen" version can be added next.)

## Costs at a glance (approximate; check current pricing)
- **DigitalOcean pilot:** ~$6 Droplet + ~$1–2 backups ≈ **$8/month**.
- **Google Cloud for real data:** ~$12–15 e2-small + ~$2 disk + a few cents–$1 snapshots/storage ≈ **$15–20/month**.
- Domain: whatever you already pay your registrar.
