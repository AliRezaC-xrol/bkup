import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { db } from "@/lib/db";
import { requireAuthOrCli } from "@/lib/auth";
import { bi } from "@/lib/messages";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Download a stored local backup file by run id. */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const run = await db.backupRun.findUnique({ where: { id: Number(id) } });
  if (!run || !run.filePath || !fs.existsSync(run.filePath)) {
    return NextResponse.json({ error: "فایل بکاپ پیدا نشد", errorBi: bi("فایل بکاپ پیدا نشد", "The backup file was not found") }, { status: 404 });
  }
  const buf = fs.readFileSync(run.filePath);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(run.fileName ?? "backup.bin")}"`,
      "Content-Length": String(buf.length),
    },
  });
}
