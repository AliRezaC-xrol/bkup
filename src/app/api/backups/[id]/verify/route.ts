import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { requireAuthOrCli } from "@/lib/auth";
import { bi } from "@/lib/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Integrity check for a stored local backup file.
 * Recomputes the SHA-256 of the file on disk and compares the recorded
 * size against the size logged when the backup was taken, so a silently
 * truncated or tampered file is caught before it is ever restored.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const run = await db.backupRun.findUnique({ where: { id: Number(id) } });
  if (!run) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!run.filePath || !fs.existsSync(run.filePath)) {
    return NextResponse.json({
      exists: false,
      recordedSize: run.fileSize ?? 0,
      sizeOnDisk: 0,
      sha256: null,
      sizeMatch: false,
      message: bi("The backup file is no longer on disk", "The backup file is no longer on disk"),
    });
  }

  const buf = fs.readFileSync(run.filePath);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const sizeOnDisk = buf.length;
  const sizeMatch = run.fileSize == null ? true : sizeOnDisk === run.fileSize;

  return NextResponse.json({
    exists: true,
    sha256,
    sizeOnDisk,
    recordedSize: run.fileSize ?? 0,
    sizeMatch,
  });
}
