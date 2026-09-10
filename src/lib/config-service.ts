import { db } from "@/lib/db";
import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";
import type { BackupConfig } from "@prisma/client";

export type AppConfig = BackupConfig;

const DEFAULTS: Omit<BackupConfig, "id" | "createdAt" | "updatedAt"> = {
  panelType: "3x-ui", // legacy v3.0 field — unused by v3.1 logic
  xuiEnabled: true,
  panelUrl: "",
  panelBasePath: "",
  panelUsername: "",
  panelPassword: "",
  authMode: "session",
  apiToken: "",
  skipTlsVerify: true,
  hmEnabled: false,
  hmUrl: "",
  hmUsername: "",
  hmPassword: "",
  pgEnabled: false,
  pgUrl: "",
  pgUsername: "",
  pgPassword: "",
  hmPremium: false,
  rebeccaEnabled: false,
  rebeccaUrl: "",
  rebeccaUsername: "",
  rebeccaPassword: "",
  telegramApiBase: "https://api.telegram.org",
  telegramBotToken: "",
  telegramChatId: "",
  telegramThreadId: "",
  intervalSeconds: 60,
  enabled: false,
  backupMode: "auto",
  localDbPath: "/etc/x-ui/x-ui.db",
  localRetention: 288,
  tgAutoDeleteKeep: 0,
};

/**
 * One-time auto-migration from v3.0 ("panelType" single-panel) to v3.1
 * (independent dual panels). v3.0 users who had selected HM Panel get their
 * credentials copied into the dedicated hm* fields; 3x-ui users are unchanged.
 * Idempotent: only fires while hmUrl is still empty.
 */
async function migrateLegacy(cfg: BackupConfig): Promise<BackupConfig> {
  if (cfg.panelType !== "hmpanel" || cfg.hmUrl.trim() !== "" || !cfg.panelUrl.trim()) {
    return cfg;
  }
  try {
    const migrated = await db.backupConfig.update({
      where: { id: cfg.id },
      data: {
        hmUrl: cfg.panelUrl,
        hmUsername: cfg.panelUsername,
        hmPassword: cfg.panelPassword,
        hmEnabled: true,
        xuiEnabled: false,
      },
    });
    await log("info", bi("تنظیمات HMPanel از نسخه قبلی به کارت مستقل پنل منتقل شد", "HMPanel settings were migrated from the previous version to the dedicated panel card"));
    return migrated;
  } catch {
    return cfg; // non-fatal — next call retries
  }
}

/** Load the singleton config row, creating it with defaults if missing. */
export async function getConfig(): Promise<AppConfig> {
  let cfg = await db.backupConfig.findUnique({ where: { id: 1 } });
  if (!cfg) {
    cfg = await db.backupConfig.create({ data: { id: 1, ...DEFAULTS } });
  }
  if (cfg.panelType === "hmpanel" && cfg.hmUrl.trim() === "") {
    cfg = await migrateLegacy(cfg);
  }
  // Telegram delivery is pinned to the official public endpoint. Older builds
  // allowed a custom base (e.g. a local Bot API server); if such a value is
  // still stored, reset it here so connectivity always works.
  const OFFICIAL_TG = "https://api.telegram.org";
  if (cfg.telegramApiBase.trim() !== OFFICIAL_TG) {
    cfg = await db.backupConfig.update({ where: { id: 1 }, data: { telegramApiBase: OFFICIAL_TG } });
  }
  return cfg;
}

/** Merge partial updates into the singleton config row. */
export async function saveConfig(
  patch: Partial<Omit<BackupConfig, "id" | "createdAt" | "updatedAt">>
): Promise<AppConfig> {
  await getConfig();
  return db.backupConfig.update({ where: { id: 1 }, data: patch });
}

/** Public-safe view of the config (masks secrets for the client UI). */
export function maskConfig(cfg: AppConfig) {
  const mask = (s: string) => (s ? "•".repeat(Math.min(s.length, 24)) : "");
  return {
    ...cfg,
    panelPassword: mask(cfg.panelPassword),
    hmPassword: mask(cfg.hmPassword),
    pgPassword: mask(cfg.pgPassword),
    rebeccaPassword: mask(cfg.rebeccaPassword),
    apiToken: mask(cfg.apiToken),
    telegramBotToken: mask(cfg.telegramBotToken),
  };
}

export type MaskedConfig = ReturnType<typeof maskConfig>;

/** Which fields the client is allowed to send as "unchanged" (masked value). */
export const SECRET_FIELDS = ["panelPassword", "hmPassword", "pgPassword", "rebeccaPassword", "apiToken", "telegramBotToken"] as const;
