import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { db } from "@/lib/db";
import { requireAuthOrCli } from "@/lib/auth";
import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Delete a reassembled backup record and its merged file. */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const row = await db.reassembledBackup.findUnique({ where: { id: Number(id) } });
  if (!row) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  try {
    if (row.filePath && fs.existsSync(row.filePath)) fs.unlinkSync(row.filePath);
  } catch { /* file may already be gone */ }
  await db.reassembledBackup.delete({ where: { id: row.id } });
  await log("info", bi(
    `بکاپ برگردانده‌شده #${row.id} حذف شد`,
    `Reassembled backup #${row.id} was deleted`
  ));
  return NextResponse.json({ ok: true });
}
