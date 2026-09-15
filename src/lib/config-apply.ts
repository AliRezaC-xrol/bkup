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
    return bi(`The ${label} URL must start with http:// or https://`, `آدرس ${label} باید با http:// یا https:// شروع شود`);
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
        error: bi("The backup interval must be between 10 seconds and 24 hours", "فاصله بکاپ‌گیری باید بین ۱۰ ثانیه و ۲۴ ساعت باشد"),
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
    return { ok: false, status: 400, error: bi("Invalid authentication mode", "حالت احراز هویت نامعتبر است") };
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

  const updated = await saveConfig(patch);
  invalidateSession();
  hmInvalidateSession();
  restartScheduler();
  await log(
    "info",
    opts?.source === "import"
      ? bi("Settings were imported from a file", "تنظیمات از فایل وارد شد")
      : bi("Settings were updated", "تنظیمات به‌روزرسانی شد")
  );
  return { ok: true, updated };
}
