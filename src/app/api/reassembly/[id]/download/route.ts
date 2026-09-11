import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { requireAuthOrCli } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Download the reassembled (complete) backup file. */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const row = await db.reassembledBackup.findUnique({ where: { id: Number(id) } });
  if (!row || !row.filePath || !fs.existsSync(row.filePath)) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  const stream = Readable.toWeb(fs.createReadStream(row.filePath)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${row.name}"`,
    },
  });
}
