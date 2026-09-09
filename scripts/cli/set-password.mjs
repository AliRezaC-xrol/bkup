#!/usr/bin/env node
/**
 * CLI helper: set / change the web-panel password (no old password required).
 * Usage: node scripts/cli/set-password.mjs <newPassword>
 * Hash algorithm matches src/lib/auth.ts (scrypt, 64 bytes, hex).
 */
import crypto from "node:crypto";
import "./_env.mjs"; // loads .env → DATABASE_URL
import { PrismaClient } from "@prisma/client";

const password = process.argv[2] || "";
if (password.length < 4) {
  console.error("usage: set-password.mjs <newPassword> (min 4 chars)");
  process.exit(1);
}

const db = new PrismaClient();
try {
  let row = await db.systemConfig.findUnique({ where: { id: 1 } });
  if (!row) row = await db.systemConfig.create({ data: { id: 1 } });

  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");

  await db.systemConfig.update({
    where: { id: 1 },
    data: {
      passwordHash: hash,
      passwordSalt: salt,
      sessionSecret: row.sessionSecret || crypto.randomBytes(32).toString("hex"),
      sessionsVersion: { increment: 1 }, // kick existing web sessions
    },
  });
  console.log(JSON.stringify({ ok: true }));
} catch (e) {
  console.error(JSON.stringify({ error: String(e?.message || e) }));
  process.exit(1);
} finally {
  await db.$disconnect();
}
