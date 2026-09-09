import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuthOrCli } from "@/lib/auth";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Backup history list (newest first). */
export async function GET(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  const limit = Math.min(200, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 50));
  const rows = await db.backupRun.findMany({
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  return NextResponse.json(rows);
}
