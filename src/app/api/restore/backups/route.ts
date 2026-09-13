import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { listAvailableBackups } from "@/lib/restore-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/restore/backups — list backups available for restore. */
export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  const data = await listAvailableBackups();
  return NextResponse.json(data);
}
