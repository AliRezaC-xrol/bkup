<div align="center">

# bkup

**Automatic backups of 3x-ui, HM Panel and PasarGuard — delivered to your Telegram.**

One self-contained service with a **web panel** and a **terminal menu**: it connects
to every panel you configure, takes a **full backup** on your schedule, and ships
it to your **Telegram** chat or channel as a file.

[![Release](https://img.shields.io/github/v/release/AliRezaC-xrol/bkup?style=flat-square&label=release)](https://github.com/AliRezaC-xrol/bkup/releases/latest)
[![Stars](https://img.shields.io/github/stars/AliRezaC-xrol/bkup?style=flat-square)](https://github.com/AliRezaC-xrol/bkup/stargazers)
[![Downloads](https://img.shields.io/github/downloads/AliRezaC-xrol/bkup/total?style=flat-square&label=downloads)](https://github.com/AliRezaC-xrol/bkup/releases)

[Install](#install) · [Quick start](#quick-start) · [Features](#features) · [Update](#update) · [CLI menu](#cli-menu) · [مستندات فارسی](README.fa.md)

</div>

---

## How it works

```
  3x-ui ────────┐
  HM Panel ─────┤   bkup pulls a full backup from every enabled panel,
  PasarGuard ───┘   on the schedule you set
                                │
                                ▼
                      your Telegram chat  ← each backup arrives as a file
```

`bkup` runs as a hardened systemd service — CPU/RAM capped, auto-restart, starts
on boot. Every panel is independent: enable any of them, each with its own
connection test. The interval is set in **seconds**, so you can go from a few
backups a day to one every few minutes.

## Install

One command as root on the server. It installs Node.js 20 if missing, downloads
the **latest release**, verifies the code against it, builds and starts the
service, then prints the panel address and password:

```bash
sudo bash <(curl -fsSL https://raw.githubusercontent.com/AliRezaC-xrol/bkup/main/install.sh)
```

Re-running the same command on an existing server **updates in place** — the
database, settings and backups are preserved.

## Quick start

| Step | Where | What to do |
|---|---|---|
| **1** | Installer | choose a port (or a random one) and a panel password |
| **2** | Browser | open `http://<server-ip>:<port>` and log in |
| **3** | **Settings** | connect 3x-ui / HM Panel / PasarGuard — press the test button |
| **4** | **Settings** | add your Telegram bot token + chat ID — press the test button |
| **5** | **Settings** | set the backup interval and flip **Auto backup** ON |

Backups start flowing to Telegram immediately.

## Features

- **All three panels at once** — 3x-ui, HM Panel and PasarGuard, each enabled independently with its own test button
- **Telegram delivery** — every backup is sent to your chat or channel as a file
- **Flexible schedule** — interval in seconds, survives reboots via systemd
- **Web panel** — dashboard, live logs, backup history, download or delete each backup
- **Terminal menu (`bkup`)** — status, panel URL, password, port, logs, update, uninstall
- **Safe updates** — the installer and the updater resolve the latest GitHub release, verify the downloaded code against it and refuse anything else; your data is never touched
- **Resource-friendly** — CPU/RAM limits on the service, backups stream straight to Telegram

## Update

| From | How |
|---|---|
| Web panel | **System → Check for updates → Update** |
| Terminal | `bkup` → **Update** |
| Anywhere | re-run the install command above |

The version shown in the panel is injected from the release at build time —
after an update it always reflects the code that is actually running.

## CLI menu

Run `bkup` on the server:

| Option | Purpose |
|---|---|
| **Status** | service state, installed version, update availability |
| **Web panel URL** | prints the panel address and port |
| **Password** | change the web panel password |
| **Port** | change the web panel port |
| **Logs** | tail the live service logs |
| **Update** | pull and install the latest release in place, data preserved |
| **Uninstall** | remove the service and the application |

## Uninstall

Run `bkup` → **Uninstall**.

## Screenshots

<div align="center">
<img src="docs/panel.png" alt="bkup web panel" width="820">
</div>

## Server paths

| Path / command | What it is |
|---|---|
| `/opt/bkup` | application directory |
| `/opt/bkup/.env` | port and paths |
| `/opt/bkup/db/custom.db` | settings database |
| `/opt/bkup/backups` | local copies of the backups |
| `bkup` | terminal menu command |
| `bkup.service` | systemd service |

---

[مستندات فارسی](README.fa.md)
