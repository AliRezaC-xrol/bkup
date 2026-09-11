import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";
import { getConfig } from "@/lib/config-service";
import { runBackup } from "@/lib/backup-service";

/**
 * Precise wall-clock scheduler.
 *
 * Instead of a plain setInterval (which drifts), each tick is scheduled against
 * the next absolute multiple of the interval — with a 60s interval, backups fire
 * exactly at second :00 of every minute regardless of how long the previous
 * run took.
 */

export interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  nextRunAt: number | null;
  intervalSeconds: number;
  lastTickAt: number | null;
}

interface SchedulerState {
  timer: NodeJS.Timeout | null;
  nextRunAt: number | null;
  busy: boolean;
  lastTickAt: number | null;
  started: boolean;
}

const g = globalThis as unknown as { __xuiScheduler?: SchedulerState };

function state(): SchedulerState {
  if (!g.__xuiScheduler) {
    g.__xuiScheduler = {
      timer: null,
      nextRunAt: null,
      busy: false,
      lastTickAt: null,
      started: false,
    };
  }
  return g.__xuiScheduler;
}

async function tick() {
  const s = state();
  s.lastTickAt = Date.now();
  s.nextRunAt = null;
  s.timer = null;

  let cfg;
  try {
    cfg = await getConfig();
  } catch (e: unknown) {
    console.error("[SCHEDULER] config read failed:", e instanceof Error ? e.message : e);
    scheduleNext();
    return;
  }
  if (!cfg.enabled) return; // stopped while waiting

  if (s.busy) {
    await log("warn", bi("اجرای قبلی هنوز در جریان است؛ این تیک رد شد", "The previous run is still in progress; this tick was skipped"));
    scheduleNext(); // keep the rhythm going
    return;
  }

  s.busy = true;
  try {
    await runBackup("auto");
  } catch (e: unknown) {
    await log("error", bi(`خطای غیرمنتظره در زمان‌بند: ${e instanceof Error ? e.message : String(e)}`, `Unexpected scheduler error: ${e instanceof Error ? e.message : String(e)}`));
  } finally {
    s.busy = false;
  }

  scheduleNext();
}

/** Compute next run aligned to the interval grid and arm the timer. */
export function scheduleNext() {
  const s = state();
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }

  getConfig()
    .then((cfg) => {
      if (!cfg.enabled) {
        s.nextRunAt = null;
        return;
      }
      const intervalMs = Math.max(10, cfg.intervalSeconds) * 1000;
      const now = Date.now();
      let next = Math.ceil(now / intervalMs) * intervalMs;
      if (next - now < 500) next += intervalMs; // avoid double-firing the same boundary
      s.nextRunAt = next;
      s.timer = setTimeout(() => {
        tick().catch((e) => console.error("[SCHEDULER] tick error:", e));
      }, Math.max(1, next - now));
    })
    .catch((e) => {
      console.error("[SCHEDULER] failed to load config:", e);
      // keep the chain alive — retry the tick shortly instead of dying silently
      s.nextRunAt = Date.now() + 30_000;
      s.timer = setTimeout(() => {
        tick().catch((e2) => console.error("[SCHEDULER] tick error:", e2));
      }, 30_000);
    });
}

/** Boot the scheduler once per process. Safe to call multiple times. */
export function bootstrapScheduler() {
  const s = state();
  if (s.started) return;
  s.started = true;
  console.log("[SCHEDULER] bootstrapped");
  // a run recorded as "running" can only be a cycle the restart interrupted —
  // close it so it can neither look alive nor suppress the next cycle
  import("@/lib/db").then(({ db }) =>
    db.backupRun.updateMany({
      where: { status: "running" },
      data: { status: "failed", error: "اجرای بکاپ با ری‌استارت سرویس قطع شد", durationMs: 0 },
    }).catch(() => undefined)
  );
  scheduleNext();
}

/** Re-evaluate schedule after a config change (called by API routes). */
export function restartScheduler() {
  if (!state().started) {
    bootstrapScheduler();
    return;
  }
  scheduleNext();
}

export function getSchedulerStatus(): SchedulerStatus {
  const s = state();
  return {
    enabled: s.nextRunAt !== null,
    running: s.busy,
    nextRunAt: s.nextRunAt,
    intervalSeconds: 0, // filled by the API route from config
    lastTickAt: s.lastTickAt,
  };
}
