import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { db } from "@/lib/db";
import { requireAuthOrCli } from "@/lib/auth";
import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Delete a backup record and (best-effort) its local file. */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const run = await db.backupRun.findUnique({ where: { id: Number(id) } });
  if (!run) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (run.filePath) {
    try {
      if (fs.existsSync(run.filePath)) fs.unlinkSync(run.filePath);
    } catch {
      /* file may already be gone */
    }
  }
  await db.backupRun.delete({ where: { id: run.id } });
  await log("info", bi(`رکورد بکاپ #${run.id} حذف شد`, `Backup record #${run.id} was deleted`));
  return NextResponse.json({ ok: true });
}
