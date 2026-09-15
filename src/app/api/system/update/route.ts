import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrCli } from "@/lib/auth";
import { getSystemInfo, fetchLatestFromGithub } from "@/lib/system-info";
import { readState, startUpdate, updateLogFile, writeState } from "@/lib/updater";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/system/update  {action: "check"}        → force-refresh latest release info
 * POST /api/system/update  {action: "run"}          → launch update.sh in background
 * POST /api/system/update  {action: "run", force}   → redeploy even if already latest
 * GET  /api/system/update?log=1                     → last 8KB of update log
 */
export async function POST(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { action?: string; force?: boolean };

  if (body.action === "check") {
    // force=true → a manual check always asks GitHub, never the 5-minute cache,
    // so the panel really re-checks instead of echoing the previous value.
    const latest = await fetchLatestFromGithub(true);
    const info = await getSystemInfo();
    return NextResponse.json({ ok: true, latest, updateAvailable: info.updateAvailable });
  }

  if (body.action === "run") {
    const res = startUpdate({ force: Boolean(body.force) });
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "BAD_ACTION" }, { status: 400 });
}

export async function GET(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  const url = new URL(req.url);
  if (url.searchParams.get("log")) {
    try {
      const fs = await import("node:fs");
      const buf = fs.readFileSync(updateLogFile());
      const tail = buf.length > 8192 ? buf.subarray(buf.length - 8192) : buf;
      return new Response(tail.toString("utf8"), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    } catch {
      return new Response("", { headers: { "Content-Type": "text/plain" } });
    }
  }
  return NextResponse.json({ state: readState() });
}
