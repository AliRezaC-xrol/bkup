<div align="center">

<img src="docs/banner.svg" alt="bkup" width="640">

**Auto backup & restore 3x-ui, HM Panel, PasarGuard, Rebecca.**

[![Release](https://img.shields.io/github/v/release/AliRezaC-xrol/bkup?style=flat-square&label=release)](https://github.com/AliRezaC-xrol/bkup/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/AliRezaC-xrol/bkup/total?style=flat-square&label=downloads)](https://github.com/AliRezaC-xrol/bkup/releases)
[![Stars](https://img.shields.io/github/stars/AliRezaC-xrol/bkup?style=flat-square)](https://github.com/AliRezaC-xrol/bkup/stargazers)

<img src="docs/panel-8.png" alt="bkup web panel" width="820">

[Install](#install) · [First run](#first-run) · [Features](#features) · [Reassemble](#reassemble-backup-parts) · [Restore](#restore-Backup-to-a-server) · [Update](#update) · [Terminal menu](#terminal-menu) · [Donate](#donate) · [مستندات فارسی](README.fa.md)

</div>

## What it does

`bkup` connects to every panel you configure, takes a **full backup** of each one
on the schedule you set, and sends it to your **Telegram** chat or channel as a
file. It runs as a systemd service on your own server — CPU and RAM capped,
restarted automatically if it stops, back on after a reboot.

<div align="center">

<img src="docs/flow-en-2.svg" alt="Your panels to bkup, then Telegram" width="820">

</div>

Each panel is configured separately: enable the ones you use and test every
connection with one click. The backup interval is set in **seconds**, so the
same install covers anything from a few backups a day to one every few minutes.

## Features

- **3x-ui, HM Panel, PasarGuard and Rebecca in one place** — each panel enabled independently, each with its own connection test
- **Telegram delivery** — every backup arrives as a file in your chat or channel; nothing to download by hand
- **Your schedule** — interval in seconds, kept across reboots by the systemd service
- **Web panel** — dashboard, live logs, backup history with per-backup download and delete, plus a file-name search that combines with the status and panel filters
- **Reassemble split backups** — parts delivered to Telegram are merged back into the one complete file right in the web panel, with a downloadable history; you can also pick the parts straight from your stored backups instead of uploading them — part sets of the same file are grouped under one header, so the whole set is one tap away
- **Restore to any server** — push a backup (a normal run or a reassembled file) back onto a server over SSH; the panel is installed automatically if it is missing, every step streams live, and the run can be cancelled
- **Disk cleanup on demand** — System → Storage previews orphan files left by crashed runs and backups beyond the retention limit, then removes them with one click
- **Settings file** — export every panel, Telegram and schedule setting as JSON and import it on another server; hidden credentials keep their current values, a full export moves them too
- **Dark mode and installable app** — the panel follows the system theme (or the switch in the header) and can be added to the phone's home screen like a native app
- **Terminal menu** — `bkup` handles status, panel URL, password, port, logs, update and uninstall without opening the web panel

## Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/AliRezaC-xrol/bkup/main/install.sh)
```

The command installs Node.js 20 if it is missing, downloads the **latest
release**, verifies it, builds the app and registers the service — then prints
the panel address and password. Run it again on the same server and it updates
in place, keeping every setting and backup.

## First run

| Step | Where | What to do |
|---|---|---|
| **1** | Installer | pick a port (or a random one) and a panel password |
| **2** | Browser | open `http://<server-ip>:<port>` and log in |
| **3** | **Settings** | connect 3x-ui, HM Panel, PasarGuard, Rebecca — press the test button |
| **4** | **Settings** | add your Telegram bot token and chat ID — press the test button |
| **5** | **Settings** | set the backup interval and turn **Auto backup** on |

## Update

| From | How |
|---|---|
| Web panel | **System → Check for updates → Update** |
| Terminal | `bkup` → **Update** |
| Anywhere | re-run the install command |

The version shown in the panel comes from the code at build time, so after an
update it always matches what is actually running.


## Reassemble Backup Parts

Backups larger than **50 MB** are split into multiple numbered parts before being sent to Telegram.

In the **Reassemble** section, you can upload these parts and convert them back into the original backup file. The parts are automatically sorted by their numbers and merged byte-by-byte, while the original files remain untouched.

You can also reassemble parts that are already stored in the **Backups** section. Simply select the parts you need; they are automatically arranged in the correct order, and duplicate part numbers are detected before the merge begins.

Part sets of the same file are recognized on sight: every group gets its own header with the original file name and a **have/total** badge — green when the whole set is visible, amber when parts are missing. The **Add all** button on the header picks every visible part of that file in one tap (and turns into **Remove** to undo), so assembling a split backup no longer means ticking each part by hand. Picking a single part still flags the missing siblings with an **Add missing parts** shortcut right where the warning appears.

## Restore Backup to a Server

The **Restore** section lets you restore a backup directly to a server over **SSH**.

Select the target server, panel, optional **Cloudflare DNS** settings, and the backup you want to restore. Before starting, **bkup** displays a summary of the target server, selected backup, and panel.

During the restore, every step is displayed in real time. You can cancel the restore while it is running, and the result of every restore is recorded in **History**.

If the selected panel is not installed on the target server, **bkup** installs the panel first and then restores the selected backup.

Every past run is kept in **Restore History** — filter it by **panel** or **status** (success, failed, cancelled), expand the exact error behind a failed run and copy it, or export the filtered rows as **CSV**. A failed or cancelled run can be retried with one click: the server address, port, username, and panel are pre-filled, and since passwords and keys are never stored, you only re-enter the credential before connecting.

## Donate

If `bkup` has been useful to you, even a single **STAR** on **GitHub** can be the greatest support for continuing the development of the project.

| Network | Address |
|---|---|
| **Tron (TRC20)** | `TQwEkXiBiFiQikD97iCk38eJJkQrirnwFS` |
| **TON (Toncoin)** | `UQDPCYKMhkA9hERfhLYNXIvl1dbV0ZKf4k7quu61iehEeMb1` |
| **Tether USD (TRC20)** | `TQwEkXiBiFiQikD97iCk38eJJkQrirnwFS` |

## Disk Cleanup

Crashed runs and old backups can silently eat disk space. **System → Storage**
now shows what can be reclaimed before anything is touched: files on disk that
carry no history row (orphans from a cycle that died mid-write) and backups
beyond the retention limit you set in Settings. A fresh file written by a
running cycle is left alone for one hour, so cleanup never races a live backup.
One click on **Clean now** removes exactly what the preview listed — the file
and its history row go together, and copies already delivered to Telegram are
not affected.

## Settings File

Moving bkup to a new server no longer means retyping every connection. In
**Settings**, **Export settings** downloads all four panel connections, the
Telegram destination and the schedule as one JSON file. By default credentials
are hidden in the file, so it is safe to keep or share; choosing **Include
credentials** writes the real values for a full migration. **Import settings**
on another install applies the file through the exact same validation the
settings form uses — masked credentials simply keep the values already on that
server.

## Dark Mode & Home-Screen App

The header carries a light/dark switch next to the live indicator. Out of the box bkup follows the operating system's appearance — dark at night, light in the morning — and the switch overrides that per device, with the choice remembered across visits. Every screen is themed, including the log console, the activity chart and the restore wizard, so nothing turns into a white flash after sunset.

The panel is also a **PWA**: open the browser menu and choose **Add to Home Screen** (or **Install** on desktop Chrome). bkup then launches in its own window with its own icon — no address bar, no tab hunting — which makes checking backups from a phone feel like opening a regular app.

## Terminal menu

Run `bkup` on the server:

| Option | Purpose |
|---|---|
| **Status** | service state, installed version, update availability |
| **Web panel URL** | prints the address and port |
| **Password** | change the panel password |
| **Port** | change the panel port |
| **Logs** | follow the live service logs |
| **Start panel** | start the web panel service |
| **Stop panel** | stop the web panel service |
| **Restart panel** | restart the web panel service |
| **Update** | install the latest release in place, data preserved |
| **Uninstall** | remove the service and the application |

## Server paths

| Path / command | What it is |
|---|---|
| `/opt/bkup` | application directory |
| `/opt/bkup/.env` | port and paths |
| `/opt/bkup/db/custom.db` | settings database |
| `/opt/bkup/backups` | local copies of the backups |
| `bkup` | terminal menu command |
| `bkup.service` | systemd service |

## License

This project is distributed under a proprietary license — see
[LICENSE](LICENSE) for the terms.
