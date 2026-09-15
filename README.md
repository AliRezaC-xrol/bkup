<div align="center">

<img src="docs/banner.svg" alt="bkup" width="640">

**Backup & Restore for 3x-ui, HM Panel, PasarGuard & Rebecca.**

[![Release](https://img.shields.io/github/v/release/AliRezaC-xrol/bkup?style=flat-square&label=release)](https://github.com/AliRezaC-xrol/bkup/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/AliRezaC-xrol/bkup/total?style=flat-square&label=downloads)](https://github.com/AliRezaC-xrol/bkup/releases)
[![Stars](https://img.shields.io/github/stars/AliRezaC-xrol/bkup?style=flat-square)](https://github.com/AliRezaC-xrol/bkup/stargazers)

<img src="docs/panel-8.png" alt="bkup web panel" width="820">

[Install](#install) · [First run](#first-run) · [Features](#features) · [Reassemble](#reassemble-backup-parts) · [Restore](#restore-Backup-to-a-server) · [Update](#update) · [Terminal menu](#terminal-menu) · [Donate](#donate) · [مستندات فارسی](README.fa.md)

</div>

## What it does

`bkup` is a robust, lightweight systemd service designed to automate full, byte-for-byte backups for your server panels. It connects securely to your configured panels, captures exact snapshots on your custom schedule, and delivers them directly as files to your Telegram chat or channel.

<div align="center">

<img src="docs/flow-en-2.svg" alt="Your panels to bkup, then Telegram" width="820">

</div>

Each panel is configured separately: enable the ones you use and test every
connection with one click. The backup interval is set in **seconds**.

## Features

- **All-in-One Management:** Control 3x-ui, HM Panel, PasarGuard, and Rebecca from dashboard.
- **Telegram Delivery:** Backup files are sent directly to your Telegram destination.
- **Flexible Scheduling:** Set intervals in seconds for any scheduling requirement.
- **Web Panel:** Live logs, backup history, Reassemble, Restore.

## Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/AliRezaC-xrol/bkup/main/install.sh)
```

The command installs Node.js 20 if it is missing, downloads the **latest
release**, verifies it, builds the app and registers the service — then prints
the panel address and password.

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

Backups larger than **50 MB** are split into multiple numbered parts before being sent to Telegram, In the Reassemble section, these parts can be merged back into the original backup file, Parts are automatically sorted and merged **byte-by-byte**, while the original files remain untouched, The final file is integrity-checked before being stored, The backup’s panel is automatically detected: 3x-ui, HMPanel, PasarGuard, and Rebecca.


## Restore Backup to a Server

The **Restore** section lets you restore a backup directly to a server over **SSH**.

- **Complete Restore:** All backup data is restored without modification.
- **Automatic Installation:** If the panel is not installed, it is installed first and then restored.
- **SSL & Verification:** Certificates are restored and the panel is checked to ensure it is running correctly
- **Restore History:** Each restore records its status and errors, with a one-click Retry option.

## Donate

If `bkup` has been useful to you, even a single **STAR** on **GitHub** can be the greatest support for continuing the development of the project.

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

## License

This project is distributed under a proprietary license — see
[LICENSE](LICENSE) for the terms.
