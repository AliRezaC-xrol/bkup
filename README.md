<div align="center">

<img src="docs/banner.svg" alt="bkup" width="640">

**Backup & Restore for 3x-ui, HM Panel, PasarGuard & Rebecca.**

[![Release](https://img.shields.io/github/v/release/AliRezaC-xrol/bkup?style=flat-square&label=release)](https://github.com/AliRezaC-xrol/bkup/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/AliRezaC-xrol/bkup/total?style=flat-square&label=downloads)](https://github.com/AliRezaC-xrol/bkup/releases)
[![Stars](https://img.shields.io/github/stars/AliRezaC-xrol/bkup?style=flat-square)](https://github.com/AliRezaC-xrol/bkup/stargazers)

<img src="docs/panel-8.png" alt="bkup panel in dark mode on desktop and mobile" width="820">

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
- **Custom Paths:** Back up any directory on the server — for example `/opt/myapp` — alongside the panel backups, with no size limit.
- **Memory-Safe Transfers:** Every archive is streamed to disk and uploaded in sliced parts, so even multi-gigabyte backups fit the service memory limit. Backing up a single panel alone never crashes the service.
- **Web Panel:** Live logs, backup history, Reassemble, Restore.

> **v1.3.0** adds **Custom Paths** backup and **Custom Paths restore** (unpack a
> directory archive onto a server over SSH), fixes the crash that killed the
> service when only one panel (e.g. HM Panel) was backed up, fixes the **Copy
> shown** button in the log panel, and makes every server log and message
> English — old Persian log rows are translated once at boot. See
> [Releases](https://github.com/AliRezaC-xrol/bkup/releases) for the full
> changelog.

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
| **6** | **Settings** | (optional) add **Custom paths** — server directories to back up every cycle |

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


## Custom Paths

Besides the four panels, `bkup` can back up **any directory on the server** —
configuration folders, app data, anything under `/opt`, `/etc`, `/var` or your
own mount points.

| Step | Where | What to do |
|---|---|---|
| **1** | **Settings → Custom paths** | enter an absolute path, e.g. `/opt/folder`, and an optional label |
| **2** | **Settings → Custom paths** | press **Add path** — repeat for up to 16 directories |
| **3** | **Settings** | press **Save** |
| **4** | **Backups → Backup now** | every custom path is packed into its own `.tar.gz` and sent to the same Telegram chat |

Notes:

- Each path is archived as a `tar.gz`, one archive per path per cycle, and
  delivered next to the panel backups.
- Symlinks are stored as symlinks (never followed), so a symlink loop cannot
  hang or blow up the archive.
- The directory holding `bkup` itself is protected — it cannot back itself up,
  and files such as `.env` and `.cli-secret` are always excluded.
- An at-a-glance manifest (`backup-manifest.json`) is written into every
  archive so its contents can be audited.
- File permissions (mode bits) are preserved, so a script backed up as
  executable restores as executable.

## Restore a Custom Path Backup

A **custom path** backup can be restored onto any server you can reach over
SSH — the archive is unpacked into a directory of your choice.

| Step | Where | What to do |
|---|---|---|
| **1** | **Restore** | enter the target server SSH details and connect |
| **2** | **Restore → Panel type** | pick **Custom folder (DIR)** |
| **3** | **Restore → Backup** | choose the directory archive to restore |
| **4** | **Restore → Review** | enter the **target directory**, e.g. `/opt/myapp`, and start |

Notes:

- The target directory is created if it does not exist (`mkdir -p`); nothing
  outside it is touched.
- System directories (`/`, `/etc`, `/usr`, `/root`, …) and single-level paths
  are refused, both in the panel and again on the server before extraction.
- The archive is checked for members that would escape the target directory
  before `tar` runs — an unsafe archive is refused, not extracted.
- After extraction, the file count is compared with the manifest's count; a
  short extract is reported as a failure rather than a success.
- The uploaded archive is removed from the target server when the restore
  finishes, whether it succeeded or failed.

**From the terminal:** run `bkup` on the server and pick **item 12 —
Restore custom-path backup over SSH**. An interactive wizard lists the
custom-path archives, asks for the SSH details and target directory, and
watches the restore step by step (with an option to cancel). It uses the
same engine and validation as the panel flow, and everything it prints is
also written to the English-only log.

## Restore Backup to a Server

The **Restore** section lets you restore a backup directly to a server over **SSH**.

**Complete Restore:** All backup data is restored without modification.
**Automatic Installation:** If the panel is not installed, it is installed first and then restored.
**SSL & Verification:** Certificates are restored and the panel is checked to ensure it is running correctly
**Restore History:** Each restore records its status and errors, with a one-click Retry option.

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
| **Custom-path restore** | restore a custom path (DIR) backup onto a server over SSH |
| **Uninstall** | remove the service and the application |

## License

This project is distributed under a proprietary license — see
[LICENSE](LICENSE) for the terms.
