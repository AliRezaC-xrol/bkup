import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { readRestoreState } from "@/lib/restore-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/restore/status — current restore job state (polled by the UI). */
export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  const state = readRestoreState();
  return NextResponse.json(state || { status: "idle" });
}
