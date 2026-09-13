import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrCli } from "@/lib/auth";
import { previewCleanup, runCleanup } from "@/lib/cleanup-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — what WOULD be cleaned (orphans + retention excess). No writes. */
export async function GET(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  try {
    const preview = await previewCleanup();
    return NextResponse.json(preview);
  } catch {
    return NextResponse.json({ error: "preview failed" }, { status: 500 });
  }
}

/** POST — execute the cleanup and report what was freed. */
export async function POST(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  try {
    const result = await runCleanup();
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "cleanup failed" }, { status: 500 });
  }
}
