/**
 * Next.js instrumentation hook — runs once when the server process starts.
 * Boots the backup scheduler so auto backups work in dev and production.
 *
 * This is an unattended backup service: a transient error (SQLite busy,
 * network flap, etc.) must NEVER take the whole process down.
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
  }
}
