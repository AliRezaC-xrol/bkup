import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrCli } from "@/lib/auth";
import { listAvailableBackups } from "@/lib/restore-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/restore/backups — list backups available for restore. */
export async function GET(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  const data = await listAvailableBackups();
  return NextResponse.json(data);
}
