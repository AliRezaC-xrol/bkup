#!/usr/bin/env node
/**
 * CLI helper: read app status directly from the SQLite database.
 * Works even when the web service is stopped.
 * Usage: node scripts/cli/status.mjs
 * Output: single-line JSON
 */
import "./_env.mjs"; // loads .env → DATABASE_URL (fixes "could not read app database")
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
try {
  const [cfg, total, success, failed, last24h, lastRun, sys, pkg] = await Promise.all([
    db.backupConfig.findUnique({ where: { id: 1 } }),
    db.backupRun.count(),
    db.backupRun.count({ where: { status: "success" } }),
    db.backupRun.count({ where: { status: "failed" } }),
    db.backupRun.count({ where: { startedAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } }),
    db.backupRun.findFirst({ orderBy: { startedAt: "desc" } }),
    db.systemConfig.findUnique({ where: { id: 1 } }),
    import("node:fs").then((fs) =>
      JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
    ),
  ]);

  const panelType = cfg?.panelType === "hmpanel" ? "hmpanel" : "3x-ui";

  // v3.1: the two panels are independent connections — each has its own state
  const xuiReady =
    Boolean(cfg?.panelUrl) &&
    (cfg?.authMode === "bearer"
      ? Boolean(cfg?.apiToken)
      : Boolean(cfg?.panelUsername && cfg?.panelPassword));
  const hmReady = Boolean(cfg?.hmUrl && cfg?.hmUsername && cfg?.hmPassword);
  const pgReady = Boolean(cfg?.pgUrl && cfg?.pgUsername && cfg?.pgPassword);
  const rbReady = Boolean(cfg?.rebeccaUrl && cfg?.rebeccaUsername && cfg?.rebeccaPassword);
  const xui = { enabled: Boolean(cfg?.xuiEnabled), ready: xuiReady };
  const hm = { enabled: Boolean(cfg?.hmEnabled), ready: hmReady, premium: Boolean(cfg?.hmPremium) };
  const pg = { enabled: Boolean(cfg?.pgEnabled), ready: pgReady };
  const rebecca = { enabled: Boolean(cfg?.rebeccaEnabled), ready: rbReady };

  console.log(
    JSON.stringify({
      version: pkg.version ?? "?",
      enabled: Boolean(cfg?.enabled),
      intervalSeconds: cfg?.intervalSeconds ?? 60,
      panels: { xui, hm, pg, rebecca },
      // legacy single-panel view (kept for compatibility)
      panelType,
      panelReady: (xui.enabled && xui.ready) || (hm.enabled && hm.ready),
      telegramReady: Boolean(cfg?.telegramBotToken && cfg?.telegramChatId),
      backupMode: cfg?.backupMode ?? "auto",
      passwordSet: Boolean(sys?.passwordHash),
      stats: { total, success, failed, last24h },
      lastRun: lastRun
        ? {
            status: lastRun.status,
            panel: lastRun.panel,
            method: lastRun.method,
            fileName: lastRun.fileName,
            startedAt: lastRun.startedAt,
          }
        : null,
    })
  );
} catch (e) {
  console.error(JSON.stringify({ error: String(e?.message || e) }));
  process.exit(1);
} finally {
  await db.$disconnect();
}
