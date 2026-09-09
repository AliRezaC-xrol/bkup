/**
 * Shared bootstrap for CLI helpers.
 * Loads the app's .env file so scripts work standalone (no shell env needed),
 * and resolves the real app root whether run from a checkout or /opt install.
 *
 * Fix: "could not read app database" — Prisma needs DATABASE_URL at runtime;
 * previously the CLI helpers relied on the caller exporting it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // <app>/scripts/cli

/** Walk up from scripts/cli to find the dir that contains package.json + .env */
export const APP_ROOT = (() => {
  let dir = here;
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(here, "../..");
})();

function loadEnvFile(file, overrideAll = false, overrideKeys = null) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
      const mustOverride =
        overrideAll || (overrideKeys ? overrideKeys.has(key) : false);
      if (mustOverride || process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = val;
      }
    }
    return true;
  } catch {
    return false;
  }
}

// Priority: explicit ABX_ENV_FILE → <app>/.env → inherited environment.
// The keys the CLI depends on (DATABASE_URL / PORT / BACKUP_DIR) are
// overridden by the app's .env when present — otherwise an unrelated
// DATABASE_URL exported in the user's shell (common on dev boxes) would
// silently point the CLI at the wrong database.
const CLI_OVERRIDABLE = new Set(["DATABASE_URL", "PORT", "BACKUP_DIR"]);
loadEnvFile(process.env.ABX_ENV_FILE || "", true);
loadEnvFile(path.join(APP_ROOT, ".env"), true, CLI_OVERRIDABLE);

// Final fallback: default DB location used by install.sh
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = `file:${path.join(APP_ROOT, "db", "custom.db")}`;
}
