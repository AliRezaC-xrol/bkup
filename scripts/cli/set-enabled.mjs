#!/usr/bin/env node
/**
 * CLI helper: enable / disable the auto-backup scheduler.
 * Usage: node scripts/cli/set-enabled.mjs <on|off>
 */
import "./_env.mjs"; // loads .env → DATABASE_URL
import { PrismaClient } from "@prisma/client";

const arg = (process.argv[2] || "").toLowerCase();
if (!["on", "off"].includes(arg)) {
  console.error("usage: set-enabled.mjs <on|off>");
  process.exit(1);
}

const db = new PrismaClient();
try {
  const cfg = await db.backupConfig.findUnique({ where: { id: 1 } });
  if (!cfg) {
    await db.backupConfig.create({ data: { id: 1, enabled: arg === "on" } });
  } else {
    await db.backupConfig.update({ where: { id: 1 }, data: { enabled: arg === "on" } });
  }
  console.log(JSON.stringify({ ok: true, enabled: arg === "on" }));
} catch (e) {
  console.error(JSON.stringify({ error: String(e?.message || e) }));
  process.exit(1);
} finally {
  await db.$disconnect();
}
