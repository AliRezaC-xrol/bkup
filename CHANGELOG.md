# Changelog

All notable changes to **bkup** are documented here.
Versions follow [Semantic Versioning](https://semver.org/).

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
