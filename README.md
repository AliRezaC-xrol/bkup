<div align="center">

<img src="docs/banner.svg" alt="bkup" width="640">

**Automatic full backups of 3x-ui, HM Panel, PasarGuard and Rebecca to Telegram.**

[![Release](https://img.shields.io/github/v/release/AliRezaC-xrol/bkup?style=flat-square&label=release)](https://github.com/AliRezaC-xrol/bkup/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/AliRezaC-xrol/bkup/total?style=flat-square&label=downloads)](https://github.com/AliRezaC-xrol/bkup/releases)
[![Stars](https://img.shields.io/github/stars/AliRezaC-xrol/bkup?style=flat-square)](https://github.com/AliRezaC-xrol/bkup/stargazers)

<img src="docs/panel-8.png" alt="bkup web panel" width="820">

[Overview](#overview) · [Features](#features) · [Requirements](#requirements) · [Install](#install) · [First run](#first-run) · [Reassembly](#reassemble-backup-parts) · [Restore](#restore-to-a-server) · [Settings file](#settings-file) · [Security](#security-and-sessions) · [Updates](#updates) · [Terminal menu](#terminal-menu) · [Paths](#paths-and-environment-variables) · [Troubleshooting](#troubleshooting) · [Donate](#donate) · [مستندات فارسی](README.fa.md)

</div>

## Overview

bkup runs on your own server as a systemd service. It connects to every panel you
configure, takes one **full backup per panel** on the interval you set, and sends each
file to your Telegram chat or channel. The service is resource-capped, restarts itself
if it stops, and comes back after a reboot.

**Every panel has exactly one backup method — the panel's own complete backup, taken
byte-for-byte and never modified:**

| Panel | What is captured |
|---|---|
| **3x-ui** | the panel's own full database (`x-ui.db`), exactly as the panel serves it |
| **HM Panel** | the panel's official full archive (`backup_full_*`) |
| **PasarGuard** | a complete snapshot of every section: users, hosts, nodes, cores, groups, settings, templates |
| **Rebecca** | the panel's official full export |

bkup never repacks, filters or rewrites a backup, and it never converts one panel's
backup into another panel's format. What the panel produced is what reaches Telegram.

<div align="center">

<img src="docs/flow-en-2.svg" alt="Your panels to bkup, then Telegram" width="820">

</div>

Panels are configured independently: enable the ones you use, give each its own
credentials, and verify each connection with its own test button. The backup interval
is set in seconds, so one installation covers anything from a few backups a day to one
every few minutes.

## Features

**Backups**

- Four panel integrations in one installation — 3x-ui, HM Panel, PasarGuard, Rebecca — enabled and tested separately
- One full backup per enabled panel per cycle, byte-for-byte, unmodified
- Interval in seconds, controlled by the scheduler and preserved across reboots
- Every backup is delivered to Telegram as a file; nothing has to be downloaded by hand
- Files above the 50 MB Telegram `sendDocument` limit are split into numbered parts of the same file (see [Reassembly](#reassemble-backup-parts))
- Local retention per panel (keep the newest N files per panel; `0` = unlimited)

**Web panel**

- Dashboard: next run countdown, scheduler switch, total / successful / failed / last-24h counters, per-panel connection state
- Backups: full history with per-file download and delete, plus file-name search combined with the status filter
- Logs: live application log with level filtering
- System: installed version and latest GitHub release, check for updates, install update, reinstall, service start / stop / restart, panel port, and local disk usage
- Settings: panel connections, Telegram destination, schedule, settings file, password and sessions

**Reassembly**

- Split parts arriving from Telegram are merged back into the single original file inside the panel
- Parts can be uploaded, or picked directly from stored backups — no re-upload needed
- Parts are sorted by number, duplicates are detected before the merge, and the result is integrity-checked before it is stored
- Part sets of the same file are grouped under one header with a have / total badge and an **Add all** shortcut
- Reassembly history supports bulk selection and deletion (files and records together)

**Restore**

- Push a backup — a normal run or a reassembled file — onto another server over SSH
- The selected backup decides the panel; a panel missing on the target is installed first
- Byte-for-byte placement is verified, and the running panel is probed instead of trusted
- Certificates referenced by the restored database are rebuilt from the backup's own bytes before the panel starts
- Live step-by-step progress, cancellation at any point, and a full restore history with filters, error copy, CSV export and one-click retry

**Operations**

- Updates in place from the web panel or the terminal menu, with data preserved
- Settings export / import for moving an installation to another server
- Password change and a one-tap **Log out everywhere**
- Dark mode and an installable home-screen app (PWA)
- A terminal menu for status, password, port, logs, service control, updates and uninstall

## Requirements

| Item | Detail |
|---|---|
| Server | Debian or Ubuntu, root access (the installer creates the systemd service in `/opt`) |
| Runtime | Node.js 20 or newer — installed automatically by the installer if missing |
| Telegram | a bot token from [@BotFather](https://t.me/BotFather) and the target chat or channel ID |
| Panels | the panel URL plus its credentials, or an API token for the bearer auth mode |
| Docker (optional) | Docker Engine with Compose, if you prefer the container install |

## Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/AliRezaC-xrol/bkup/main/install.sh)
```

The installer:

1. verifies root access and installs Node.js 20 if it is missing;
2. resolves the **latest published release** from GitHub and downloads exactly that tag;
3. verifies the downloaded code matches the release tag and refuses to install on a mismatch;
4. asks for the web panel port (10000-65000, or a random one) and the panel password (or generates a strong random one);
5. builds the application and registers the `bkup` systemd service;
6. prints the panel address and password when it finishes.

Running the same command again on an existing installation refreshes the code in place
and keeps the database, backups, `.env` and secrets untouched. Installations created by
the older `autobackup-xui` service are detected and migrated.

### Docker

The repository ships a `docker-compose.yml` that runs the same application in a
container:

```bash
git clone https://github.com/AliRezaC-xrol/bkup.git
cd bkup
docker compose up -d --build      # web panel on http://SERVER_IP:3999
```

| Setting | Value |
|---|---|
| Ports | `3999:3000` — the panel listens on 3999 on the host |
| Volume | `./data:/app/data` — database, backups and retention live here |
| Database | `DATABASE_URL=file:/app/data/prod.db` |
| Backups | `BACKUP_DIR=/app/data/backups` |
| Timezone | `TZ=Asia/Tehran` |
| Health check | `GET /api/status` inside the container |

For the local 3x-ui mode, where the panel runs on the same host, uncomment the
`/etc/x-ui:/host-xui:ro` volume in the compose file to give the container read-only
access to the panel directory.

## First run

| Step | Where | What to do |
|---|---|---|
| **1** | Installer | choose a port (or a random one) and a panel password |
| **2** | Browser | open `http://<server-ip>:<port>` and sign in |
| **3** | Settings | connect 3x-ui, HM Panel, PasarGuard and Rebecca — press each test button |
| **4** | Settings | add the Telegram bot token and chat ID — press the test button |
| **5** | Settings | set the backup interval and switch **Auto backup** on |

From that point the dashboard shows the countdown to the next run, and every cycle
appears in Backups and in the live log.

## Reassemble Backup Parts

Telegram's official `sendDocument` endpoint accepts at most **50 MB** per message.
Larger backups are delivered by bkup as numbered parts of the *same* file, named
`<name>.part01of05.ext`, each with the rejoin command in its caption:

```bash
cat my-backup.part*of*.tar.gz > my-backup.tar.gz
```

The **Reassemble** section does the same thing inside the panel:

- upload the downloaded parts, or pick them directly from the **Backups** section — no re-uploading;
- parts are ordered by their numbers automatically, and duplicate part numbers are detected before the merge starts;
- the merged file is integrity-checked before it is stored, and the original parts stay where they were;
- the panel is detected for all four integrations, so a reassembled backup restores through its own panel's path;
- part sets of one file appear under a single header with the original file name and a **have / total** badge — green for a complete set, amber when parts are missing. **Add all** selects the whole set in one tap (and turns into **Remove**), while selecting a single part offers **Add missing parts** next to the warning;
- the history is a working list: each row has a checkbox, the header selects all, and **Delete selected** removes files and records together.

## Restore to a Server

The **Restore** section pushes a backup onto a target server over **SSH**.

Choose the server, the panel, the optional **Cloudflare DNS** settings and the backup,
and bkup prints a summary of the target, the backup and the panel before anything
starts.

**The selected backup decides the panel — never the other way round.** A 3x-ui backup
is restored only onto 3x-ui, an HM Panel backup only onto HM Panel, PasarGuard onto
PasarGuard and Rebecca onto Rebecca. No cross-panel migration and no rewriting of the
backup to make it fit: the exact bytes the panel produced are written back, so users,
inbounds, settings and traffic return exactly as they were.

If the panel is missing on the target server, bkup installs it first and then restores
the selected backup onto it — the same flow whether the panel came from you or from
bkup.

After the byte-for-byte placement is verified, bkup proves the panel is actually
running instead of trusting a heartbeat: for 3x-ui it checks the panel service **and**
the X-Ray core. Before the panel is started, every certificate file referenced by the
restored database is located **inside the backup's own bytes** (no `sqlite3` needed on
the target) and any that the server lacks is created at exactly the referenced path —
so an inbound whose TLS certificate existed only on the old server can no longer stop
X-Ray with `failed to parse certificate: no such file or directory`. The backup content
itself is never edited.

Every step streams live, the run can be cancelled while it is in progress, and the
result is stored in **Restore History**: filter by status (success, failed, cancelled),
expand and copy the exact error of a failed run, or export the filtered rows as CSV. A
failed or cancelled run can be retried with one click — server, port, username and
panel are pre-filled, and since passwords and keys are never stored you only re-enter
the credential before connecting.

## Settings File

Moving bkup to another server does not require retyping every connection. In
**Settings**, **Export settings** downloads all four panel connections, the Telegram
destination and the schedule as a single JSON file. Credentials are masked by default,
which makes the file safe to keep or share; **Include credentials** writes the real
values for a full migration. **Import settings** on another installation applies the
file through the same validation the settings form uses, and a masked credential simply
keeps the value already stored on that server.

## Security and Sessions

- The web panel is protected by a password set during installation and changeable from the panel or the terminal menu.
- Changing the password signs every device out.
- **Log out everywhere** invalidates all issued sessions immediately — the phone, the office browser and the tab you are using right now — without changing the password. Each device lands on the login screen and signs back in with the panel password.
- A local secret file (`.cli-secret`) lets the terminal menu talk to the panel API without exposing the password.
- Sessions and commands are logged in the application log.

## Updates

| From | How |
|---|---|
| Web panel | **System → Check for updates → Install update** |
| Web panel | **Reinstall** to redeploy the current release |
| Terminal | `bkup` → **Check for updates** (6) or **Update** (7) |
| Anywhere | re-run the install command |

```bash
bash scripts/update.sh            # update with human-readable output
bash scripts/update.sh --web      # quiet mode, used by the web panel
bash scripts/update.sh --force    # redeploy the latest release even if already current
```

Updates always resolve the newest published release, download exactly that tag, verify
the code version against it, and abort without touching the running installation if
verification fails. The database, backups, `.env` and secrets are preserved. The version
shown in the panel is resolved from the code that is actually running, so the panel
never reports a version it is not executing.

## Terminal menu

Run `bkup` on the server:

| Option | Purpose |
|---|---|
| **1** | Status overview: service state, installed version, backup statistics, update availability |
| **2** | Show the web panel URL and port |
| **3** | Change the web panel password |
| **4** | Change the web panel port |
| **5** | Follow the live service logs |
| **6** | Check for updates |
| **7** | Update from GitHub |
| **8** | Start the web panel service |
| **9** | Stop the web panel service |
| **10** | Restart the web panel service |
| **11** | Uninstall the service and the application |
| **0** | Exit |

When the command is piped and there is no terminal attached, it prints the status
instead of opening the menu, which makes it usable from scripts.

## Dark Mode and Home-Screen App

The header carries a light / dark switch next to the live indicator. By default bkup
follows the operating system appearance and the switch overrides it per device, with
the choice remembered between visits. Every screen is themed, including the log console
and the restore wizard. The dark palette is a soft graphite that avoids pure black and
pure white, so long reading sessions at night do not glare.

The panel is a **PWA**: use **Add to Home Screen** in the browser menu (or **Install**
in desktop Chrome) and bkup launches in its own window with its own icon, without an
address bar.

## Paths and Environment Variables

| Path or command | Purpose |
|---|---|
| `/opt/bkup` | application directory |
| `/opt/bkup/.env` | port, database URL, backup directory and timezone |
| `/opt/bkup/db/custom.db` | settings database |
| `/opt/bkup/backups` | local copies of the backups |
| `/opt/bkup/.cli-secret` | local secret used by the terminal menu |
| `bkup` | terminal menu command |
| `bkup.service` | systemd unit (legacy installs use `autobackup-xui.service`) |

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | location of the settings database |
| `BACKUP_DIR` | local backup directory (default `./backups`) |
| `TZ` | timezone used in the panel and in the logs (default `Asia/Tehran`) |
| `PORT` | web panel port |
| `GITHUB_TOKEN` | optional token for update checks, required for private or rate-limited repositories |

## Troubleshooting

| Symptom | What to check |
|---|---|
| Panel does not open | `bkup` option 1 for the service state, option 5 for the logs, and confirm the port is open in the firewall |
| The panel reports a version older than the release | run the installer again, or `bash scripts/update.sh --force` |
| Update check reports that GitHub is unreachable | internet access from the server, and `GITHUB_TOKEN` (or `/opt/bkup/.github-token`) if the repository is private or hit by rate limits |
| Backup never arrives in Telegram | press the Telegram test button in Settings; check the bot token, the chat ID and that the bot can post in that chat |
| A panel test fails while the panel is reachable | verify the panel URL and port, the auth mode (session or bearer token), and enable *skip TLS verify* for self-signed certificates |
| A backup arrives in several parts | reassemble it in the Reassemble section, or rejoin with `cat name.part*of*.ext > name.ext` |
| Backup files fill the disk | set **Local file retention** per panel (0 = unlimited) and review storage in the System tab |
| Password lost | `bkup` option 3 on the server resets it |
| Nothing responds after a container restart | confirm the `./data` volume is mounted and writable |

## Donate

If bkup saves you time, a star on GitHub and sharing the project are the most useful
support for continuing its development.

| Network | Address |
|---|---|
| **Tron (TRC20)** | `TQwEkXiBiFiQikD97iCk38eJJkQrirnwFS` |
| **TON (Toncoin)** | `UQDPCYKMhkA9hERfhLYNXIvl1dbV0ZKf4k7quu61iehEeMb1` |
| **Tether USD (TRC20)** | `TQwEkXiBiFiQikD97iCk38eJJkQrirnwFS` |

## License

This project is distributed under a proprietary license — see
[LICENSE](LICENSE) for the full terms.
