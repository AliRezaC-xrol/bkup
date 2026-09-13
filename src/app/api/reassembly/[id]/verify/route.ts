import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { requireAuthOrCli } from "@/lib/auth";
import { bi } from "@/lib/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Integrity check for a reassembled backup file — same contract as the
 * Backups-section verify: recompute the SHA-256 of the file on disk and
 * compare the size against what was recorded when the file was merged, so
 * a silently truncated or tampered reassembled file is caught before it
 * is ever restored to a server.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const row = await db.reassembledBackup.findUnique({ where: { id: Number(id) } });
  if (!row) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!row.filePath || !fs.existsSync(row.filePath)) {
    return NextResponse.json({
      exists: false,
      recordedSize: row.size ?? 0,
      sizeOnDisk: 0,
      sha256: null,
      sizeMatch: false,
      message: bi("The reassembled file is no longer on disk", "The reassembled file is no longer on disk"),
    });
  }

  const buf = fs.readFileSync(row.filePath);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const sizeOnDisk = buf.length;
  const sizeMatch = row.size == null ? true : sizeOnDisk === row.size;

  return NextResponse.json({
    exists: true,
    sha256,
    sizeOnDisk,
    recordedSize: row.size ?? 0,
    sizeMatch,
  });
}
