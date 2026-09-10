import fs from "node:fs";
import path from "node:path";
import { APP_VERSION } from "@/lib/version";
import { fetchLatestFromGithub } from "@/lib/system-info";
import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";
import { getConfig } from "@/lib/config-service";
import { sendMessage } from "@/lib/telegram";

/**
 * Release watchdog — the "updates reach every install" mechanism.
 *
 * Once an hour (and shortly after boot) it compares the running version
 * against the latest GitHub release. When a newer release exists it:
 *   1. writes a warning to the live log console (web panel + CLI logs),
 *   2. sends ONE Telegram notice per new tag (never spams),
 *   3. the web dashboard/System tab already badge "update available"
 *      and the CLI menu shows the notice on every open.
 *
 * State (last notified tag) lives in <app>/data/update-notify.json so a
 * restart does not repeat the same announcement.
 */

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly
const BOOT_DELAY_MS = 90 * 1000; // first check 90s after boot (let the app settle)

function stateFile(): string {
  const dir = path.join(process.cwd(), "data");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* exists */ }
  return path.join(dir, "update-notify.json");
}

function readNotified(): string | null {
  try {
    const d = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as { lastNotifiedTag?: string };
    return d.lastNotifiedTag ?? null;
  } catch {
    return null;
  }
}

function writeNotified(tag: string) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ lastNotifiedTag: tag, at: new Date().toISOString() }, null, 2));
  } catch { /* non-fatal */ }
}

function isNewer(latest: string, current: string): boolean {
  const l = latest.replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  const c = current.replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const a = l[i] ?? 0;
    const b = c[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

async function checkOnce() {
  try {
    const latest = await fetchLatestFromGithub();
    if (!latest.tag || !latest.version) return; // unreachable / no releases — silent
    if (!isNewer(latest.tag, APP_VERSION)) return; // up to date

    await log("warn", bi(`نسخه جدید bkup منتشر شده: ${latest.tag} (نصب‌شده: v${APP_VERSION}) — از وب‌پنل (سیستم → به‌روزرسانی) یا منوی ترمینال (گزینه 7) نصب کنید`, `A new bkup version was released: ${latest.tag} (installed: v${APP_VERSION}) — install it from the web panel (System → Update) or the terminal menu (option 7)`));

    const tag = latest.tag;
    if (readNotified() === tag) return; // already announced this release
    const cfg = await getConfig();
    if (cfg.telegramBotToken.trim() && cfg.telegramChatId.trim()) {
      const res = await sendMessage(
        cfg,
        [
          `⬆️ A new bkup version has been released: ${tag}`,
          `نصب‌شده روی این سرور: v${APP_VERSION}`,
          "",
          "به‌روزرسانی بدون از دست رفتن دیتا:",
          "• وب‌پنل → سیستم → به‌روزرسانی از گیت‌هاب",
          "• یا ترمینال: bkup → گزینه 7",
        ].join("\n")
      );
      if (res.ok) writeNotified(tag);
    } else {
      writeNotified(tag); // telegram not configured — don't retry forever
    }
  } catch {
    /* never crash the scheduler because of a version check */
  }
}

const g = globalThis as unknown as { __bkupUpdateTimer?: NodeJS.Timeout | null };

/** Boot the watchdog once per process. Safe to call multiple times. */
export function bootstrapUpdateChecker() {
  if (g.__bkupUpdateTimer) return;
  setTimeout(() => void checkOnce(), BOOT_DELAY_MS);
  g.__bkupUpdateTimer = setInterval(() => void checkOnce(), CHECK_INTERVAL_MS);
}
