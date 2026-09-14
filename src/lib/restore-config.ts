import { db } from "@/lib/db";
import type { RestoreConfig } from "@prisma/client";

// ── Hardcoded official install URLs ──────────────────────────────────────────
// FALLBACK URLs used when DB has no value. Verified from official repos.
export const OFFICIAL_INSTALL_URLS = {
  "3x-ui": "https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh",
  hmpanel: "https://raw.githubusercontent.com/neoauroraproject/hmpanel/main/install.sh",
  pasarguard: "https://github.com/PasarGuard/scripts/raw/main/pasarguard.sh",
  rebecca: "https://raw.githubusercontent.com/rebeccapanel/Rebecca/master/scripts/rebecca/rebecca-binary.sh",
} as const;

// ── Official node install URLs ──
export const OFFICIAL_NODE_INSTALL_URLS = {
  pasarguard: "https://github.com/PasarGuard/scripts/raw/main/pg-node.sh",
  rebecca: "https://raw.githubusercontent.com/rebeccapanel/Rebecca/master/scripts/rebecca/rebecca-node-binary.sh",
} as const;

// ── Official install COMMANDS — robust, no process substitution ─────────────
// Official commands from user use `bash <(curl ...)` which requires /dev/fd
// and fails over SSH with "curl: (3) URL using bad/illegal format" in some
// environments. We use the equivalent but robust form: curl -o + bash.
// Functionally identical, but works reliably when executed via remote script file.
export const OFFICIAL_INSTALL_COMMANDS = {
  "3x-ui":
    "curl -Ls https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh -o /tmp/x-ui-install.sh && bash /tmp/x-ui-install.sh",
  hmpanel:
    "curl -fsSL https://raw.githubusercontent.com/neoauroraproject/hmpanel/main/install.sh -o /tmp/hmpanel-install.sh && chmod +x /tmp/hmpanel-install.sh && printf 'localhost\nadmin\nAdmin12345\nY\n' | bash /tmp/hmpanel-install.sh",
  pasarguard:
    "curl -fsSL https://github.com/PasarGuard/scripts/raw/main/pasarguard.sh -o /tmp/pasarguard-install.sh && chmod +x /tmp/pasarguard-install.sh && printf 'n\nN\nn\n' | bash /tmp/pasarguard-install.sh install",
  rebecca:
    "curl -sL https://raw.githubusercontent.com/rebeccapanel/Rebecca/master/scripts/rebecca/rebecca-binary.sh -o /tmp/rebecca-install.sh && chmod +x /tmp/rebecca-install.sh && bash /tmp/rebecca-install.sh install",
} as const;

export const OFFICIAL_NODE_INSTALL_COMMANDS = {
  pasarguard:
    "curl -sL https://github.com/PasarGuard/scripts/raw/main/pg-node.sh -o /tmp/pg-node-install.sh && chmod +x /tmp/pg-node-install.sh && bash /tmp/pg-node-install.sh install",
  rebecca:
    "curl -sL https://raw.githubusercontent.com/rebeccapanel/Rebecca/master/scripts/rebecca/rebecca-node-binary.sh -o /tmp/rebecca-node-install.sh && chmod +x /tmp/rebecca-node-install.sh && bash /tmp/rebecca-node-install.sh install",
} as const;

const DEFAULTS: Omit<RestoreConfig, "id" | "createdAt" | "updatedAt"> = {
  xuiInstallScript: OFFICIAL_INSTALL_URLS["3x-ui"],
  hmInstallScript: OFFICIAL_INSTALL_URLS.hmpanel,
  pgInstallScript: OFFICIAL_INSTALL_URLS.pasarguard,
  rbInstallScript: OFFICIAL_INSTALL_URLS.rebecca,
  githubToken: "",
};

/** Load the singleton restore config row, creating it with defaults if missing. */
export async function getRestoreConfig(): Promise<RestoreConfig> {
  let cfg = await db.restoreConfig.findUnique({ where: { id: 1 } });
  if (!cfg) {
    cfg = await db.restoreConfig.create({ data: { id: 1, ...DEFAULTS } });
  }
  const repairs: Partial<RestoreConfig> = {};
  if (!cfg.xuiInstallScript?.trim()) repairs.xuiInstallScript = DEFAULTS.xuiInstallScript;
  if (!cfg.hmInstallScript?.trim()) repairs.hmInstallScript = DEFAULTS.hmInstallScript;
  if (!cfg.pgInstallScript?.trim()) repairs.pgInstallScript = DEFAULTS.pgInstallScript;
  if (!cfg.rbInstallScript?.trim()) repairs.rbInstallScript = DEFAULTS.rbInstallScript;
  if (Object.keys(repairs).length > 0) {
    cfg = await db.restoreConfig.update({ where: { id: 1 }, data: repairs });
  }
  return cfg;
}

/** Merge partial updates into the singleton restore config row. */
export async function saveRestoreConfig(
  patch: Partial<Omit<RestoreConfig, "id" | "createdAt" | "updatedAt">>
): Promise<RestoreConfig> {
  const cfg = await getRestoreConfig();
  if (Object.keys(patch).length === 0) return cfg;
  return db.restoreConfig.update({ where: { id: 1 }, data: patch });
}

/** Public-safe view of the restore config (masks the GitHub token). */
export function maskRestoreConfig(cfg: RestoreConfig) {
  const mask = (s: string) => (s ? "•".repeat(Math.min(s.length, 24)) : "");
  return {
    ...cfg,
    githubToken: mask(cfg.githubToken),
  };
}

export const RESTORE_SECRET_FIELDS = ["githubToken"] as const;

/**
 * Get the install script URL for a given panel type.
 * Falls back to the official hardcoded URL when the DB value is empty.
 */
export function getInstallScript(
  cfg: RestoreConfig | null | undefined,
  panel: "3x-ui" | "hmpanel" | "pasarguard" | "rebecca"
): string {
  const fallback = OFFICIAL_INSTALL_URLS[panel];
  if (!cfg) return fallback;
  switch (panel) {
    case "3x-ui":
      return cfg.xuiInstallScript?.trim() || fallback;
    case "hmpanel":
      return cfg.hmInstallScript?.trim() || fallback;
    case "pasarguard":
      return cfg.pgInstallScript?.trim() || fallback;
    case "rebecca":
      return cfg.rbInstallScript?.trim() || fallback;
  }
}

/**
 * Get the node install script URL for panels that support nodes.
 */
export function getNodeInstallScript(
  panel: "3x-ui" | "hmpanel" | "pasarguard" | "rebecca"
): string | null {
  if (panel === "pasarguard") return OFFICIAL_NODE_INSTALL_URLS.pasarguard;
  if (panel === "rebecca") return OFFICIAL_NODE_INSTALL_URLS.rebecca;
  return null;
}
