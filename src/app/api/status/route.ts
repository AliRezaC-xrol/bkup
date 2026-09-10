import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getConfig } from "@/lib/config-service";
import { getSchedulerStatus } from "@/lib/scheduler";
import { requireAuthOrCli } from "@/lib/auth";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Dashboard status: scheduler state + aggregate stats + last run. */
export async function GET(req: Request) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  const cfg = await getConfig();
  const sched = getSchedulerStatus();

  const [total, success, failed, last24h] = await Promise.all([
    db.backupRun.count(),
    db.backupRun.count({ where: { status: "success" } }),
    db.backupRun.count({ where: { status: "failed" } }),
    db.backupRun.count({
      where: { startedAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
    }),
  ]);

  const lastRun = await db.backupRun.findFirst({ orderBy: { startedAt: "desc" } });

  // per-panel readiness — the panels are fully independent connections
  const xuiReady =
    Boolean(cfg.panelUrl) &&
    (cfg.authMode === "bearer"
      ? Boolean(cfg.apiToken)
      : Boolean(cfg.panelUsername && cfg.panelPassword));
  const hmReady = Boolean(cfg.hmUrl && cfg.hmUsername && cfg.hmPassword);
  const pgReady = Boolean(cfg.pgUrl && cfg.pgUsername && cfg.pgPassword);
  const rebeccaReady = Boolean(cfg.rebeccaUrl && cfg.rebeccaUsername && cfg.rebeccaPassword);

  return NextResponse.json({
    scheduler: {
      ...sched,
      intervalSeconds: cfg.intervalSeconds,
      enabled: cfg.enabled,
    },
    stats: { total, success, failed, last24h },
    lastRun,
    panels: {
      xui: { enabled: cfg.xuiEnabled, ready: xuiReady },
      hm: { enabled: cfg.hmEnabled, ready: hmReady, premium: Boolean(cfg.hmPremium) },
      pg: { enabled: cfg.pgEnabled, ready: pgReady },
      rebecca: { enabled: cfg.rebeccaEnabled, ready: rebeccaReady },
      anyEnabled: cfg.xuiEnabled || cfg.hmEnabled || cfg.pgEnabled || cfg.rebeccaEnabled,
      anyReady: (cfg.xuiEnabled && xuiReady) || (cfg.hmEnabled && hmReady) || (cfg.rebeccaEnabled && rebeccaReady) || (cfg.pgEnabled && pgReady),
    },
    // legacy single-panel fields (kept for CLI/older clients)
    configReady: {
      panel: (cfg.xuiEnabled && xuiReady) || (cfg.hmEnabled && hmReady) || (cfg.rebeccaEnabled && rebeccaReady) || (cfg.pgEnabled && pgReady),
      telegram: Boolean(cfg.telegramBotToken && cfg.telegramChatId),
    },
    panelType: cfg.panelType === "hmpanel" ? "hmpanel" : "3x-ui",
  });
}
