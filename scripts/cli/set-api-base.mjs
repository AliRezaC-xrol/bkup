// Sets telegramApiBase in the bkup config DB (used by setup-botapi.sh).
import { PrismaClient } from "@prisma/client";
const base = process.argv[2];
if (!base) { console.error("usage: node set-api-base.mjs <base-url>"); process.exit(1); }
const db = new PrismaClient();
await db.backupConfig.upsert({
  where: { id: 1 },
  update: { telegramApiBase: base },
  create: { id: 1, telegramApiBase: base },
});
console.log("telegramApiBase =", base);
await db.$disconnect();
