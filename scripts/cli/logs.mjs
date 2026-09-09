#!/usr/bin/env node
/**
 * CLI helper: tail the app log (AppLog table) when systemd/journalctl
 * is not available. Prints the last N entries, then follows for new ones.
 * Usage: node scripts/cli/logs.mjs [lines]
 */
import "./_env.mjs";
import { PrismaClient } from "@prisma/client";

const take = Math.max(1, Math.min(Number(process.argv[2]) || 50, 500));
const db = new PrismaClient();

let lastId = 0;

function print(row) {
  const t = new Date(row.ts).toISOString().replace("T", " ").slice(0, 19);
  const tag = { info: "INFO", success: " OK ", warn: "WARN", error: " ERR" }[row.level] ?? "    ";
  console.log(`${t}  [${tag}] ${row.message}`);
}

try {
  const rows = await db.appLog.findMany({ orderBy: { id: "desc" }, take });
  for (const row of rows.reverse()) {
    print(row);
    lastId = row.id;
  }
  if (rows.length === 0) console.log("(no log entries yet)");

  // follow mode — poll for new rows every 2s
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const fresh = await db.appLog.findMany({
      where: { id: { gt: lastId } },
      orderBy: { id: "asc" },
      take: 200,
    });
    for (const row of fresh) {
      print(row);
      lastId = row.id;
    }
  }
} catch (e) {
  console.error(JSON.stringify({ error: String(e?.message || e) }));
  process.exit(1);
}
