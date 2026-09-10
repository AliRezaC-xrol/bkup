# bkup v1.1.0 — Production Release Notes

**Release date:** 2026-09-10 · **Type:** official production release · **Versioning:** Semantic Versioning

## Rebecca Panel — full support

- **Rebecca is now the fourth officially supported panel**, fully independent
  from 3x-ui, HM Panel and PasarGuard — its own connection card, credentials,
  schedule behavior and backup history.
- **Connection** talks to Rebecca's official API: login via
  `POST /api/admin/token` (JSON with an automatic form-encoded fallback) and
  Bearer-token admin routes, verified against the official
  [rebeccapanel/Rebecca](https://github.com/rebeccapanel/Rebecca) source.
- **True full backup**: every cycle downloads Rebecca's own complete export —
  `GET /api/settings/backup/export` — the same archive the panel's dashboard
  and Telegram integration produce: database, configuration, certificates,
  users, inbounds/outbounds, traffic and settings. The panel's real filename
  (`.rbbackup`) is preserved via `Content-Disposition`.
- **Connection validation**: one-click test logs in, validates the token and
  reports the account; disabled accounts, wrong credentials, unreachable
  hosts, self-signed certificates and non-binary installs (HTTP 409) all
  produce clear, actionable error messages.
- **No partial backups, no splitting**: the archive is always one complete
  file, whatever its size.

## HM Panel — Free & Premium edition detection

- bkup now reads the HM Panel health payload (`mode`) and **automatically
  detects whether the connected panel is the Free (Community) or Premium
  edition**.
- The web panel displays the edition on the HM Panel card
  (**Premium** / **Free**) and the terminal status line tags it
  (`HM Panel … ⭐ Premium`).
- **Premium panels**: the full backup goes through the official HM Panel API
  (`POST /backups` with `type:"full"` + authenticated download), so every
  premium dataset included in the panel's own full archive ships in the
  backup — nothing omitted.
- **Free panels**: identical complete archive of all available data.

## Unlimited backup size & Telegram delivery

- Every artificial limitation was removed. **No backup size limit, no upload
  size limit, no artificial restrictions.**
- Every backup is generated as **one complete archive** — the archive itself
  is never split.
- Delivery tries the **complete file in a single upload first**. Only when the
  Telegram Bot API endpoint itself rejects the size (the public endpoint caps
  uploads at 50 MB) does an automatic multi-part fallback deliver every byte —
  parts are named `file.partNNofNN.ext` and rejoin with a single `cat`
  command. Pointing `telegramApiBase` at a local Telegram Bot API server keeps
  multi-hundred-MB backups as **one single upload** (up to 2 GB).

## Telegram notifications — all English, live progress

- All backup notifications are **100% English**: `Backup started`,
  `Creating full backup…`, `Uploading backup…`,
  `Backup uploaded successfully`, `Backup failed` (+ reason).
- Progress is shown in **one live message per backup** that edits itself
  through the states (start → uploading → result) instead of spamming the
  chat; captions carry file name, size, duration and edition.

## Terminal text

- The visible label **Thread ID is now Topic ID** everywhere (web panel,
  settings, placeholders) — database structure, APIs and logic untouched.
- **All terminal logs, CLI output and console errors are 100% English**
  (the bilingual database rows for the web console are unchanged).

## CLI

- New service-control items, fully wired to systemd with readiness checks:
  **Start panel (8)**, **Stop panel (9)**, **Restart/reboot panel service
  (10)**, plus the existing **status (1)** and **live logs (5)**.
- Every existing CLI option was reviewed; banner and help text now list all
  four supported panels.

## Memory & stability — root-cause fixes

- **Fixed a real socket leak**: all four panel clients used to build fresh
  keep-alive HTTP(S) agents per request, so sockets and timers accumulated in
  the long-running process. All clients now share cached process-wide agents
  (`src/lib/http-agents.ts`) — no more uncontrolled RAM growth.
- **Self-healing watchdog**: the process pings its own health endpoint every
  two minutes; three consecutive failures trigger a clean exit so systemd
  brings a fresh panel up within seconds — the web panel no longer "just
  stops opening".
- `uncaughtException` / `unhandledRejection` safety nets keep the service
  alive through transient errors; log storage is pruned to a bounded window.

## Backup integrity

- A new **integrity gate** verifies every downloaded archive before it is
  stored or sent: real gzip/zip magic bytes, non-empty payloads, and error
  pages or JSON error bodies are rejected outright — only valid, complete,
  restorable backups ever reach Telegram or disk.

## Versioning, docs & installation

- Version **1.1.0** applied consistently across the package, CLI and update
  checker; CHANGELOG updated.
- README (English + Persian) rewritten: Rebecca documented as a supported
  panel with a connection guide, HM Panel Premium documented, features and
  installation updated.
- One-command **install** and one-command **update** (bash only) with automatic
  dependency installation, automatic database migration (`prisma db push`) and
  automatic systemd service setup — now using a download-then-run form that is
  safe under `sudo`.

```bash
# install (or update in place — data preserved)
curl -fsSL https://raw.githubusercontent.com/AliRezaC-xrol/bkup/main/install.sh -o bkup-install.sh && sudo bash bkup-install.sh
```
