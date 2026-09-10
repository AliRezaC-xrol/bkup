/**
 * Next.js instrumentation hook — runs once when the server process starts.
 * Boots the backup scheduler so auto backups work in dev and production.
 *
 * This is an unattended backup service: a transient error (SQLite busy,
 * network flap, etc.) must NEVER take the whole process down — and if the
 * process itself ever becomes unresponsive (memory pressure, wedged event
 * loop), a self-healing watchdog exits it so systemd brings a FRESH panel
 * back within seconds. The web panel must never just "stop opening".
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Global safety net — log and keep running
    process.on("unhandledRejection", (reason) => {
      console.error("[SAFETY] unhandledRejection:", reason);
    });
    process.on("uncaughtException", (err) => {
      console.error("[SAFETY] uncaughtException:", err);
    });

    const { bootstrapScheduler } = await import("@/lib/scheduler");
    bootstrapScheduler();

    // release watchdog — new versions reach every install (log + telegram + banner)
    const { bootstrapUpdateChecker } = await import("@/lib/update-checker");
    bootstrapUpdateChecker();

    // ── self-healing watchdog ────────────────────────────────────────────
    // Every 2 minutes (after a 4-minute settle) the process pings its OWN
    // health endpoint. Three consecutive failures = the panel is wedged →
    // exit(1) and let systemd's Restart=always revive it. While an update
    // is running the watchdog stands down so it never fights the updater.
    if (process.env.BKUP_HEALTH_WATCHDOG !== "0") {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const port = process.env.PORT || "3000";
      let fails = 0;
      const check = async () => {
        try {
          const st = JSON.parse(
            fs.readFileSync(path.join(process.cwd(), "data", "update-state.json"), "utf8")
          ) as { state?: string };
          if (st.state === "running") return; // update in progress — stand down
        } catch { /* no update state — normal */ }
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/auth/state`, {
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            fails = 0;
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        } catch (e) {
          fails++;
          console.error(`[WATCHDOG] health check failed (${fails}/3): ${e instanceof Error ? e.message : e}`);
          if (fails >= 3) {
            console.error("[WATCHDOG] the web panel is unresponsive — exiting so systemd restarts it fresh");
            process.exit(1);
          }
        }
      };
      const t = setTimeout(() => {
        setInterval(() => void check(), 120_000);
      }, 240_000);
      if (typeof t.unref === "function") t.unref();
    }
  }
}
