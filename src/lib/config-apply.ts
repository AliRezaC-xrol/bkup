/**
 * Config patch application — the single code path used by BOTH
 *   PUT /api/config   (Settings form save)
 *   POST /api/config/import (file import)
 * so a settings file can never do anything the form cannot.
 */
import { saveConfig, SECRET_FIELDS } from "@/lib/config-service";
import { restartScheduler } from "@/lib/scheduler";
import { invalidateSession } from "@/lib/panel-client";
import { hmInvalidateSession } from "@/lib/hmpanel-client";
import { log } from "@/lib/logger";
import { bi, type Bi } from "@/lib/messages";
import { MAX_PATHS, validateCustomPath } from "@/lib/custom-path-client";

const SECRET_MASKABLE: readonly string[] = SECRET_FIELDS;

export const CONFIG_ALLOWED = new Set([
  "panelType", // legacy v3.0 — accepted but ignored by v3.1 logic
  "xuiEnabled",
  "panelUrl",
  "panelBasePath",
  "panelUsername",
  "panelPassword",
  "authMode",
  "apiToken",
  "skipTlsVerify",
  "hmEnabled",
  "hmUrl",
  "hmUsername",
  "hmPassword",
  "pgEnabled",
  "pgUrl",
  "pgUsername",
  "pgPassword",
  "hmPremium",
  "rebeccaEnabled",
  "rebeccaUrl",
  "rebeccaUsername",
  "rebeccaPassword",
  "customPaths",
  "telegramApiBase",
  "telegramBotToken",
  "telegramChatId",
  "telegramThreadId",
  "intervalSeconds",
  "enabled",
  "localRetention",
  "tgAutoDeleteKeep",
]);

export function isMasked(v: unknown): boolean {
  return typeof v === "string" && /^•+$/.test(v);
}

/**
 * Normalize the custom-paths payload from the UI/import into a clean array.
 * Accepts a JSON string or an array of {path,label} / plain strings.
 * Returns Error when the payload is unusable or exceeds the limit.
 */
function parseCustomPathsForSave(raw: unknown): { path: string; label: string }[] | Error {
  let arr: unknown;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return new Error("Custom paths must be a list of directories");
    }
  } else {
    arr = raw;
  }
  if (!Array.isArray(arr)) {
    return new Error("Custom paths must be a list of directories");
  }
  if (arr.length > MAX_PATHS) {
    return new Error(`At most ${MAX_PATHS} custom directories are supported`);
  }
  const out: { path: string; label: string }[] = [];
  for (const v of arr) {
    if (typeof v === "string") {
      out.push({ path: v.trim(), label: "" });
    } else if (v && typeof v === "object" && typeof (v as Record<string, unknown>).path === "string") {
      const o = v as { path?: string; label?: unknown };
      out.push({
        path: String(o.path).trim(),
        label: typeof o.label === "string" ? o.label.trim().slice(0, 40) : "",
      });
    }
  }
  // dedupe by path, drop empties, preserve order
  const seen = new Set<string>();
  return out.filter((e) => {
    if (!e.path || seen.has(e.path)) return false;
    seen.add(e.path);
    return true;
  });
}

/** True when the object carries at least one REAL (unmasked) secret. */
export function hasRealSecrets(obj: Record<string, unknown>): boolean {
  for (const k of SECRET_MASKABLE) {
    const v = obj[k];
    if (typeof v === "string" && v !== "" && !isMasked(v)) return true;
  }
  return false;
}

function validateUrl(v: unknown, label: string): Bi | null {
  const url = String(v ?? "").trim();
  if (url && !/^https?:\/\//i.test(url)) {
    return bi(`The ${label} URL must start with http:// or https://`, `The ${label} URL must start with http:// or https://`);
  }
  return null;
}

export type ApplyResult =
  | { ok: true; updated: Awaited<ReturnType<typeof saveConfig>> }
  | { ok: false; status: number; error: Bi };

/** Validate + persist a config patch (same rules as the Settings form). */
export async function applyConfigPatch(
  body: Record<string, unknown>,
  opts?: { source?: "ui" | "import" }
): Promise<ApplyResult> {
  const patch: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(body)) {
    if (!CONFIG_ALLOWED.has(k)) continue;
    // Client/file sends masked secrets (•••) to mean "unchanged"
    if (SECRET_MASKABLE.includes(k) && isMasked(v)) continue;
    patch[k] = v;
  }

  // coerce & validate
  if (patch.intervalSeconds !== undefined) {
    const n = Number(patch.intervalSeconds);
    if (!Number.isFinite(n) || n < 10 || n > 86400) {
      return {
        ok: false,
        status: 400,
        error: bi("The backup interval must be between 10 seconds and 24 hours", "The backup interval must be between 10 seconds and 24 hours"),
      };
    }
    patch.intervalSeconds = Math.floor(n);
  }
  if (patch.localRetention !== undefined) {
    patch.localRetention = Math.max(0, Math.floor(Number(patch.localRetention) || 0));
  }
  if (patch.tgAutoDeleteKeep !== undefined) {
    patch.tgAutoDeleteKeep = Math.max(0, Math.floor(Number(patch.tgAutoDeleteKeep) || 0));
  }
  if (patch.authMode !== undefined && !["session", "bearer"].includes(String(patch.authMode))) {
    return { ok: false, status: 400, error: bi("Invalid authentication mode", "Invalid authentication mode") };
  }
  if (patch.panelUrl !== undefined) {
    const err = validateUrl(patch.panelUrl, "3x-ui panel");
    if (err) return { ok: false, status: 400, error: err };
    patch.panelUrl = String(patch.panelUrl).trim().replace(/\/+$/, "");
  }
  if (patch.hmUrl !== undefined) {
    const err = validateUrl(patch.hmUrl, "HMPanel");
    if (err) return { ok: false, status: 400, error: err };
    patch.hmUrl = String(patch.hmUrl).trim().replace(/\/+$/, "");
  }
  if (patch.pgUrl !== undefined) {
    const err = validateUrl(patch.pgUrl, "PasarGuard");
    if (err) return { ok: false, status: 400, error: err };
    patch.pgUrl = String(patch.pgUrl).trim().replace(/\/+$/, "");
  }
  if (patch.rebeccaUrl !== undefined) {
    const err = validateUrl(patch.rebeccaUrl, "Rebecca");
    if (err) return { ok: false, status: 400, error: err };
    patch.rebeccaUrl = String(patch.rebeccaUrl).trim().replace(/\/+$/, "");
  }

  // custom paths — validated against the real filesystem here so a typo is
  // caught at SAVE time, not at backup time. The bot's own root directory is
  // always refused: backing it up would leak every credential into Telegram.
  if (patch.customPaths !== undefined) {
    const list = parseCustomPathsForSave(patch.customPaths);
    if (list instanceof Error) {
      return { ok: false, status: 400, error: bi(list.message, list.message) };
    }
    for (const entry of list) {
      const problem = validateCustomPath(entry.path, process.cwd());
      if (problem) {
        return { ok: false, status: 400, error: problem };
      }
    }
    patch.customPaths = JSON.stringify(list);
  }

  const updated = await saveConfig(patch);
  invalidateSession();
  hmInvalidateSession();
  restartScheduler();
  await log(
    "info",
    opts?.source === "import"
      ? bi("Settings were imported from a file", "Settings were imported from a file")
      : bi("Settings updated successfully", "Settings updated successfully")
  );
  return { ok: true, updated };
}
