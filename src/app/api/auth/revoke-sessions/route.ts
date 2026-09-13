import { NextRequest, NextResponse } from "next/server";
import { revokeAllSessions, requireAuth } from "@/lib/auth";
import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Log out EVERYWHERE: bumps sessionsVersion so every issued token — every
 * browser and every device, the caller included — stops verifying.
 * The user is returned to the login screen by their next authenticated
 * request (or immediately by the caller).
 */
export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  await revokeAllSessions();
  await log("success", bi("All web panel sessions were signed out", "All web panel sessions were signed out"));
  return NextResponse.json({ ok: true });
}
