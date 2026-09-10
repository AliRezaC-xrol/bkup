import { db } from "@/lib/db";
import type { Bi } from "@/lib/messages";

export type LogLevel = "info" | "success" | "warn" | "error";

/** A log message may be plain text or a bilingual pair. */
export type LogMessage = string | Bi;

let lastPruneAt = 0;
const PRUNE_EVERY_MS = 30 * 60 * 1000; // prune check at most once per 30 min

/**
 * Persist a log entry to SQLite (and mirror to stdout).
 * Bilingual pairs are stored as JSON so the web console can render the
 * active language; the fa variant goes to stdout for server operators.
 * Prunes old rows at most once every 30 minutes to keep the table bounded
 * without adding per-write query overhead.
 */
export async function log(level: LogLevel, message: LogMessage): Promise<void> {
  const isBi = typeof message === "object" && message !== null;
  // server console (CLI / journalctl) is ALWAYS English — the bilingual JSON
  // row keeps both variants for the web console to pick from
  const consoleText = isBi ? (message.en || message.fa) : message;
  const line = `[${level.toUpperCase()}] ${consoleText}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  try {
    await db.appLog.create({ data: { level, message: isBi ? JSON.stringify(message) : consoleText } });
    if (Date.now() - lastPruneAt > PRUNE_EVERY_MS) {
      lastPruneAt = Date.now();
      // keep only the newest 3000 rows (fire & forget)
      db.appLog
        .findMany({ orderBy: { ts: "desc" }, skip: 3000, take: 1, select: { ts: true } })
        .then((rows) => {
          if (rows.length === 1) {
            return db.appLog.deleteMany({ where: { ts: { lte: rows[0].ts } } });
          }
        })
        .catch(() => {});
    }
  } catch (e) {
    console.error("[LOG] failed to persist log:", e);
  }
}
