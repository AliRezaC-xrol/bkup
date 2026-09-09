import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { APP_VERSION } from "@/lib/version";
import type { UpdateState } from "@/lib/system-info";

/**
 * Runs scripts/update.sh detached so the HTTP response returns immediately.
 * Progress: data/update.log   Result: data/update-state.json
 */

function dataDir(): string {
  const dir = path.join(process.cwd(), "data");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* exists */
  }
  return dir;
}

export function updateStateFile(): string {
  return path.join(dataDir(), "update-state.json");
}

export function updateLogFile(): string {
  return path.join(dataDir(), "update.log");
}

export function writeState(state: UpdateState) {
  fs.writeFileSync(updateStateFile(), JSON.stringify(state, null, 2));
}

export function isUpdateRunning(): boolean {
  const st = readState();
  if (!st) return false;
  if (st.state !== "running") return false;
  // stale guard: anything over 10 minutes counts as dead
  return Date.now() - st.startedAt < 10 * 60 * 1000;
}

export function readState(): UpdateState | null {
  try {
    return JSON.parse(fs.readFileSync(updateStateFile(), "utf8")) as UpdateState;
  } catch {
    return null;
  }
}

function findUpdateScript(): string | null {
  const candidates = [
    process.env.ABX_APP_DIR ? path.join(process.env.ABX_APP_DIR, "scripts", "update.sh") : null,
    path.join(process.cwd(), "scripts", "update.sh"),
    "/opt/auto-backup-xui/scripts/update.sh",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* skip */
    }
  }
  return null;
}

export function startUpdate(): { ok: boolean; error?: string } {
  if (isUpdateRunning()) return { ok: false, error: "UPDATE_ALREADY_RUNNING" };

  const script = findUpdateScript();
  if (!script) return { ok: false, error: "UPDATE_SCRIPT_NOT_FOUND" };

  const state: UpdateState = { state: "running", startedAt: Date.now(), fromVersion: APP_VERSION };
  writeState(state);
  fs.writeFileSync(updateLogFile(), `# update started ${new Date().toISOString()}\n`);

  const out = fs.openSync(updateLogFile(), "a");
  const child = spawn("bash", [script, "--web"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, ABX_FROM_VERSION: APP_VERSION },
    cwd: path.dirname(script),
  });
  child.unref();
  return { ok: true };
}
