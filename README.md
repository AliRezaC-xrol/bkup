<div align="center">

<img src="docs/banner.svg" alt="bkup" width="640">

**Automatic full backups of 3x-ui, HM Panel, PasarGuard and Rebecca to Telegram.**

[![Release](https://img.shields.io/github/v/release/AliRezaC-xrol/bkup?style=flat-square&label=release)](https://github.com/AliRezaC-xrol/bkup/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/AliRezaC-xrol/bkup/total?style=flat-square&label=downloads)](https://github.com/AliRezaC-xrol/bkup/releases)
[![Stars](https://img.shields.io/github/stars/AliRezaC-xrol/bkup?style=flat-square)](https://github.com/AliRezaC-xrol/bkup/stargazers)

<img src="docs/panel-8.png" alt="bkup web panel" width="820">

[Overview](#overview) · [Features](#features) · [Install](#install) · [First run](#first-run) · [Reassembly](#reassemble-backup-parts) · [Restore](#restore-to-a-server) · [Update](#update) · [Terminal menu](#terminal-menu) · [Paths](#paths) · [Donate](#donate) · [مستندات فارسی](README.fa.md)

</div>

## Overview

bkup runs on your server as a systemd service, takes a full backup of every panel you
configure on the interval you set, and sends each file to your Telegram chat or channel.
Resource usage is capped, the service restarts itself if it stops, and it comes back
after a reboot.

Every panel has exactly one backup method — its own complete backup, byte-for-byte and
never modified:

| Panel | Captured |
|---|---|
| 3x-ui | the panel's own full database (`x-ui.db`) |
| HM Panel | the panel's official full archive (`backup_full_*`) |
| PasarGuard | a complete snapshot: users, hosts, nodes, cores, groups, settings, templates |
| Rebecca | the panel's official full export |

<div align="center">

<img src="docs/flow-en-2.svg" alt="Your panels to bkup, then Telegram" width="820">

</div>

Panels are configured and tested separately, and the backup interval is set in seconds.

## Features

- Four panels in one installation, each enabled and tested on its own
- One full backup per enabled panel per cycle, unmodified, delivered to Telegram
- Interval in seconds, preserved across reboots; per-panel local retention
- Backups above Telegram's 50 MB limit are sent as numbered parts of the same file
- Web panel: dashboard, live logs, backup history with download and delete, search combined with the status filter
- Reassemble: merge those parts back into the original file, from an upload or from stored backups
- Restore: push a backup onto another server over SSH, with live steps, cancel, history and one-click retry
- Settings export and import, to move an installation to another server
- Password change and a one-tap log out on every device
- Dark mode and an installable home-screen app (PWA)
- In-place updates from the web panel or the terminal menu

## Install

Debian or Ubuntu with root access, and Node.js 20 (installed automatically if missing):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/AliRezaC-xrol/bkup/main/install.sh)
```

The installer takes the latest release, builds it and registers the `bkup` service, then
prints the panel address and password. Running the same command again updates in place
and keeps the database, backups and settings.

With Docker:

```bash
docker compose up -d --build      # panel on http://SERVER_IP:3999, data in ./data
```

## First run

| Step | Where | What to do |
|---|---|---|
| 1 | Installer | choose the web panel port and password |
| 2 | Browser | open `http://<server-ip>:<port>` |
| 3 | Settings | connect the panels you use and press each test button |
| 4 | Settings | add the Telegram bot token and chat ID, then test |
| 5 | Settings | set the backup interval and switch Auto backup on |

## Reassemble Backup Parts

Telegram accepts 50 MB per document, so larger backups arrive as numbered parts of the
same file. The **Reassemble** section merges them back into the one original file —
upload the parts or pick them straight from your stored backups. Parts are ordered by
number, duplicates are detected before the merge, and the result is integrity-checked
before it is stored. Part sets of one file are grouped with a have / total badge,
**Add all** selects the whole set, and the history supports bulk deletion.

## Restore to a Server

The **Restore** section pushes a backup onto another server over **SSH**. The selected
backup decides the panel: a 3x-ui backup is restored only onto 3x-ui, and the same holds
for HM Panel, PasarGuard and Rebecca — no cross-panel migration and no rewriting of the
backup bytes. A panel missing on the target is installed first. The placement is
verified, the running panel is probed instead of trusted, and certificates the restored
database references are rebuilt from the backup itself before the panel starts. Steps
stream live, a running restore can be cancelled, and the history keeps every result with
filters, CSV export and retry.

## Update

| From | How |
|---|---|
| Web panel | System → Check for updates → Install update |
| Web panel | Reinstall, to redeploy the current release |
| Terminal | `bkup` → Update |
| Anywhere | re-run the install command |

Updates resolve the newest release, verify the code against its tag and abort on a
mismatch, leaving the running installation untouched.

## Terminal menu

Run `bkup` on the server:

| Option | Purpose |
|---|---|
| 1 | status: service state, version and backup statistics |
| 2 | web panel URL and port |
| 3 · 4 | change the web panel password · port |
| 5 | live service logs |
| 6 · 7 | check for updates · update |
| 8 · 9 · 10 | start · stop · restart the service |
| 11 | uninstall |

## Paths

| Path | Purpose |
|---|---|
| `/opt/bkup` | application directory |
| `/opt/bkup/.env` | port, database URL, backup directory, timezone |
| `/opt/bkup/db/custom.db` | settings database |
| `/opt/bkup/backups` | local copies of the backups |
| `bkup` | terminal menu command |
| `bkup.service` | systemd unit |

## Donate

If bkup saves you time, a star on GitHub and sharing the project are the most useful
support.

| Network | Address |
|---|---|
| **Tron (TRC20)** | `TQwEkXiBiFiQikD97iCk38eJJkQrirnwFS` |
| **TON (Toncoin)** | `UQDPCYKMhkA9hERfhLYNXIvl1dbV0ZKf4k7quu61iehEeMb1` |
| **Tether USD (TRC20)** | `TQwEkXiBiFiQikD97iCk38eJJkQrirnwFS` |

## License

Distributed under a proprietary license — see [LICENSE](LICENSE).
