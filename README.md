<div align="center">

<img src="docs/banner.svg" alt="bkup — automatic panel backups to Telegram" width="640">

**Auto backup & restore 3x-ui, HM Panel, PasarGuard, Rebecca.**

[![Release](https://img.shields.io/github/v/release/AliRezaC-xrol/bkup?style=flat-square&label=release)](https://github.com/AliRezaC-xrol/bkup/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/AliRezaC-xrol/bkup/total?style=flat-square&label=downloads)](https://github.com/AliRezaC-xrol/bkup/releases)
[![Stars](https://img.shields.io/github/stars/AliRezaC-xrol/bkup?style=flat-square)](https://github.com/AliRezaC-xrol/bkup/stargazers)

<img src="docs/panel-8.png" alt="bkup web panel" width="820">

[Install](#install) · [First run](#first-run) · [Features](#features) · [Reassemble](#reassemble-backup-parts) · [Restore](#restore-to-a-remote-server) · [Update](#update) · [Terminal menu](#terminal-menu) · [Donate](#donate) · [مستندات فارسی](README.fa.md)

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
- **Web panel** — dashboard, live logs, backup history with per-backup download and delete
- **Reassemble split backups** — parts delivered to Telegram are merged back into the one complete file right in the web panel, with a downloadable history; you can also pick the parts straight from your stored backups instead of uploading them
- **Restore to any server** — push a backup (a normal run or a reassembled file) back onto a server over SSH; the panel is installed automatically if it is missing, every step streams live, and the run can be cancelled
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


## Reassemble backup parts

Backups above 50 MB arrive in Telegram as numbered parts. Open the
**Reassemble** tab in the web panel, upload the parts and press
**Reassemble and store** — they are sorted by part number automatically and
merged byte-for-byte into the original backup file. Every merge is kept in a
history with a download and a delete button for each entry.

If the parts are already sitting in the **Backups** section — for example a
run that delivered each part as its own backup — switch the source to
**Pick from Backups** instead, tick the parts and merge those. The picker
marks each part with its number, shows what you have selected, and merges in
part order no matter what order you ticked. Same byte-for-byte result,
same history.

Every panel is covered — 3x-ui, HM Panel, PasarGuard and Rebecca — because
the parts are exact slices of the panel's own backup file.

## Restore to a remote server

Backups are only half the job — **Restore** is the other half. The Restore tab
takes a file from your backup pool — a normal backup run or a file you merged
in the Reassemble tab — and puts a panel back on its feet on any server you
can reach over SSH.

The wizard asks for the decisions in order: the target server (IP, SSH port,
user, password or private key — tested before anything else happens), the
panel type, optional Cloudflare DNS automation for certificate issuance, and
the backup itself. Both sources sit in one list — files produced by backup
runs next to files merged in Reassemble, the latter carrying a **Reassembled**
badge so there is no guessing which is which.

Before anything is written, the review screen shows the exact target, the
exact file and the panel that will be installed. Once started, every step
streams into the panel in real time — connecting, checking for an existing
installation, installing the panel if it is missing, restoring the data and
restarting the service — and you can cancel while it runs. Each attempt lands
in a history, so you can always see what ran, when, and how it ended.

All four panels are supported, and each is restored the way it actually
stores data: 3x-ui by replacing its SQLite database, HM Panel by unpacking
its full archive over the panel directory, and PasarGuard and Rebecca by
replaying a complete snapshot through the panel's own API.

## Donate

If bkup is useful to you, a small donation helps keep it going:

| Network | Address |
|---|---|
| **Tron (TRC20)** | `TQwEkXiBiFiQikD97iCk38eJJkQrirnwFS` |
| **TON (Toncoin)** | `UQDPCYKMhkA9hERfhLYNXIvl1dbV0ZKf4k7quu61iehEeMb1` |
| **Tether USD (TRC20)** | `TQwEkXiBiFiQikD97iCk38eJJkQrirnwFS` |

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
