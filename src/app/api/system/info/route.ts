import { NextResponse } from "next/server";
import { requireAuthOrCli } from "@/lib/auth";
import { getSystemInfo } from "@/lib/system-info";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** System + version info for the dashboard & System tab (session or CLI secret). */
export async function GET(req: Request) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  const info = await getSystemInfo();
  return NextResponse.json(info);
}
