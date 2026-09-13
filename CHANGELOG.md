# Changelog

All notable changes to **bkup** are documented here.
Versions follow [Semantic Versioning](https://semver.org/).

## [1.2.1] — 2026-09-13

### Fixed

- **The real root cause of "update says done / Already latest, but the panel never changes" (critical):**
  - The updater (and installer) copied new code over the installation **while bash was still reading the very script that was running** — `cp` rewrote `scripts/update.sh` (and `cli.sh`) in place, the interpreter's read offset landed in the middle of different code, and the update aborted with a random `syntax error near unexpected token` **after the copy but before the build**. The result: `package.json` already claimed the new version while the running panel was still the old build — and every later update then reported "Already on the latest release" forever, from both the terminal (option 7) and the web panel (System → Update).
  - `scripts/update.sh` and `install.sh` now stage executed files and swap them in with **atomic rename(2)** — a running shell keeps reading its own file until it exits; the next run uses the new code. No more mid-flight self-deletion.
  - The "Already latest" decision no longer trusts the on-disk `package.json` (a file the updater itself overwrites mid-update). The installed version is now resolved from the **truth chain**: the running build (`GET /api/system/info` → `appVersion`) → the last successful build output (`.next/standalone/package.json`) → on-disk `package.json` as a last resort. If the disk claims the newest version while the panel runs an older one, the update **runs and converges** the installation instead of skipping — self-healing for any install left in the stuck state.
  - CI now parses every tracked shell script with `bash -n` on every run, so a syntactically broken script can never land on `main` or in a release.

### Result

Updating from the terminal (`bkup` → 7) and from the web panel (System → Update) now: resolves the latest release, verifies it, swaps code atomically, merges `.env` (preserving your values), builds, runs database migrations, restarts the service, and confirms the running panel actually reports the new version — retrying safely if any step fails.

## [1.2.0] — 2026-09-13

### Added
- **Restore feature** — full restore flow for 3x-ui, HM Panel, PasarGuard, Rebecca via SSH. Upload backup or use existing backup, run restore with live step logs.
- **Restore History** — list of all restore jobs with status (running, success, failed, cancelled), duration, single delete and select-all deletion.
- **Cloudflare DNS integration** — manage Cloudflare DNS records from panel, with proper permission IDs (Zone Read `c8fed203ed3043cba015a93ad1616f1f`, DNS Edit `4755a26eedb94da69e1066d98aa820be`), inline IP/proxy edit, delete by ID, paste on HTTP, history button.
- **SSH restore dependencies** — `ssh2` marked as `serverExternalPackages` to avoid Turbopack bundling issues, `@types/ssh2` added.
- **New Prisma models** — `RestoreConfig` (singleton id=1, install script URLs, GitHub token) and `RestoreJob` (panel, backup source, SSH details, steps JSON).

### Fixed
- **Update bug root-cause (critical)** — fixed issue where CLI menu option 7 or web-panel update said "updated" but panel stayed on old version:
  - Backup `package.json` before overwriting code, restore on build failure so next update can retry (prevents `vFROM == TAG` false-positive "Already latest")
  - Fix typo `/proc/memsay` → `/proc/meminfo` in `scripts/update.sh` (was causing MEM_MB=0 and unnecessary swap creation)
  - Merge `.env.example` into `.env` preserving existing values, adding missing keys (PORT, DATABASE_URL, BACKUP_DIR, TZ, BKUP_APP_DIR, ABX_APP_DIR, BKUP_ENV_FILE, ABX_ENV_FILE) instead of overwriting or preserving verbatim
  - Copy `package.json` into `.next/standalone/` after build so runtime fallback `src/lib/version.ts` works even if `NEXT_PUBLIC_APP_VERSION` is missing
  - Post-build verification that standalone contains correct version and `server.js` exists
  - Health check verifies running API version matches expected, restarts service if mismatch
  - Define missing `ok()` helper in update.sh (was calling undefined function)
- **install.sh .env handling** — for existing installs, merge instead of overwriting `.env`, preserving custom values and adding missing keys from template.
- **build-native.sh** — copy `data/` into standalone/data and `package.json` into standalone, verify version, clean re-copy of static/public for correctness after failed build.
- **Restore cancel** — precise cancel with immediate abort and status `Cancelled` in history, not `Running`.
- **UI fixes**:
  - Brand `bkup` correctly aligned left corner on tablet/iPad/PC/laptop, not centered
  - Reassemble button full-width on phone like Choose Files
  - Backup mode fields show full text, not truncated
  - System update buttons side-by-side centered opposite each other
  - Remove phrase ", with zero guesswork." from restore description
  - Change footer tagline to "Backup & Restore for 3x-ui, HM Panel, PasarGuard, Rebecca" (comma before Rebecca)
  - Remove Clear all button when select-all checkbox exists (IMG_4064)
  - Cloudflare DNS "To update to" close icon changed from Trash2 to XCircle (close/remove from list, not delete DNS)
- **HM Panel AMD64** — improved native install handling, handle both `compose.yml` and `docker-compose.yml`, better verification for AMD64.
- **Version fallback** — `src/lib/version.ts` hardcoded fallback updated from 1.1.0 to 1.2.0, runtime reads `package.json` from `process.cwd()` (standalone).

### Changed
- **Version bump** — `package.json` version 1.1.0 → 1.2.0, `next.config.ts` adds `serverExternalPackages: ["ssh2"]`
- **Dependencies** — added `ssh2@^1.17.0`, `@types/ssh2@^1.15.6`, updated `bun.lock` and `package-lock.json`

## [1.1.0] — 2026-09-10

- **Rebecca Panel support** — fourth independent panel; true full backup through the official Rebecca API
- **HM Panel Free/Premium edition detection** — shown in the web panel and CLI
- **Unlimited backup size** — one complete archive per backup; single-upload Telegram delivery with an automatic multi-part fallback
- **CLI service control** — start / stop / restart the panel from the terminal menu
- **Memory & stability** — shared HTTP agents fix the keep-alive leak; self-healing watchdog
- **Update flow fixes** — the web panel always reports the installed version, the update notice clears right after updating
- All terminal logs and Telegram notifications in English

## [1.0.0] — 2026-09-09

The first release of the reset versioning line — the project version now
starts at **1.0.0**.

### Highlights

- Automatic full backups of **3x-ui**, **HM Panel** and **PasarGuard** — all
  three at once, each enabled independently and delivered to **Telegram** as a file.
- **Web panel** with dashboard, live logs and backup history — plus the `bkup`
  terminal menu (status, URL, password, port, logs, update, uninstall).
- **One-command install**: installs Node.js 20 if missing, downloads the latest
  GitHub release, verifies the code against it, builds and registers a hardened
  systemd service. Re-running it updates in place and preserves all data.
- **Updates always install the latest release**: the installer and the updater
  resolve `releases/latest`, verify the downloaded code against the tag and
  refuse anything else — a stale copy can never be installed again.
- **Version single source of truth**: the app version is injected from
  `package.json` at build time, so the web panel always shows the version that
  is actually running — even right after an update.
- **CI tag guard**: a release tag that does not match the version in
  `package.json` now fails the build, so tag/code mismatches cannot happen again.
