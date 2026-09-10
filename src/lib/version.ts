import fs from "node:fs";
import path from "node:path";

/**
 * Application version.
 * 1) Build-time injection (next.config.ts) — the version the running bundle was built from.
 * 2) Runtime package.json — the installed version on disk, so the panel NEVER
 *    reports a stale number after an in-place update.
 */
function resolveAppVersion(): string {
  if (process.env.NEXT_PUBLIC_APP_VERSION) return process.env.NEXT_PUBLIC_APP_VERSION;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string };
    if (pkg.version) return String(pkg.version);
  } catch { /* fall through */ }
  return "1.1.0";
}

export const APP_VERSION = resolveAppVersion();

/** GitHub repository used for update checks (override with GITHUB_REPO env). */
export const GITHUB_REPO = process.env.GITHUB_REPO || "AliRezaC-xrol/bkup";

export const PROJECT_NAME = "bkup";
